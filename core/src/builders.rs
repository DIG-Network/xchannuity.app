//! Unsigned-spend builders for each annuity flow. They construct coin spends
//! into a `SpendContext`; the caller (Sage, via the dApp) signs the standard
//! p2 spends. These are exercised end-to-end on the simulator in
//! `tests/builders.rs`, so the construction is verified — only the
//! Sage-JSON (de)serialization at the wasm edge is integration-tested off-box.
//!
//! Ownership model: the stream layer is curried with the OWNER's puzzle HASH and
//! RUNS a REVEALED owner inner puzzle (the beneficiary's standard p2). CLAIM and
//! TRANSFER therefore carry the owner's signature inside the revealed p2 spend —
//! `owner_pk` is the owner's synthetic key whose standard puzzle hash equals the
//! curried `owner_hash`. CLAWBACK is issuer-message-authorized and does not run
//! the owner.

use chia_bls::PublicKey;
use chia_protocol::{Bytes32, Coin, CoinSpend};
use chia_puzzle_types::offer::{NotarizedPayment, Payment, SettlementPaymentsSolution};
use chia_puzzle_types::{LineageProof, Memos};
use chia_puzzles::SETTLEMENT_PAYMENT_HASH;
use chia_sdk_driver::{
    decode_offer, Cat, CatInfo, CatLayer, CatSpend, HashedPtr, Layer, Puzzle, SettlementLayer,
    Spend, SpendContext, StandardLayer, SpendWithConditions,
};
use chia_sdk_types::{announcement_id, tree_hash_notarized_payment, Conditions};

use crate::assets::require_supported;
use crate::constants::{protocol_fee_puzzle_hash, stream_mod_tree_hash, PROTOCOL_FEE_BPS};
use crate::discovery::child_from_parent_spend;
use crate::error::{Error, Result};
use crate::info::{AnnuityInfo, StreamCurry};
use crate::spend::{
    authorize_message, claim_solution, clawback_message, clawback_solution, inner_spend,
    transfer_solution, transfer_solution_with_owner,
};

/// An unsigned bundle ready for Sage to partial-sign and the dApp to broadcast.
pub struct UnsignedBundle {
    pub coin_spends: Vec<CoinSpend>,
    pub stream_id: Bytes32,
}

/// The maker side of an annuity-for-XCH offer: the (unsigned) annuity-transfer
/// spend bound to a settlement announcement, plus the notarized-payment terms a
/// taker needs to fill it (and which let any wallet recompute the announcement).
pub struct OfferUnsigned {
    pub coin_spends: Vec<CoinSpend>,
    pub stream_id: Bytes32,
    /// The puzzle-announcement id the annuity transfer asserts.
    pub settlement_id: Bytes32,
    /// Notarized-payment nonce (the offered annuity coin id).
    pub nonce: Bytes32,
    /// Where the requested XCH is paid.
    pub maker_puzzle_hash: Bytes32,
    /// Requested XCH amount (mojos).
    pub xch_amount: u64,
}

/// Reconstruct the annuity CAT coin for a flow.
fn annuity_cat(
    coin: Coin,
    lineage_proof: LineageProof,
    asset_id: Bytes32,
    inner_ph: Bytes32,
) -> Cat {
    Cat {
        coin,
        lineage_proof: Some(lineage_proof),
        info: CatInfo {
            asset_id,
            hidden_puzzle_hash: None,
            p2_puzzle_hash: inner_ph,
        },
    }
}

/// Compute the settlement announcement id for an annuity-for-XCH offer: the
/// requested XCH `NotarizedPayment(nonce = annuity coin id, [(maker_ph, amount)])`,
/// hashed and bound to the settlement puzzle.
fn settlement_terms(
    ctx: &mut SpendContext,
    nonce: Bytes32,
    maker_receive_ph: Bytes32,
    xch_amount: u64,
) -> (NotarizedPayment, Bytes32) {
    let np = NotarizedPayment::new(
        nonce,
        vec![Payment::new(maker_receive_ph, xch_amount, Memos::None)],
    );
    let np_hash = tree_hash_notarized_payment(ctx, &np);
    let settlement_id = announcement_id(Bytes32::from(SETTLEMENT_PAYMENT_HASH), np_hash);
    (np, settlement_id)
}

/// CREATE — spend the creator's existing CAT coins (of an allow-listed asset)
/// into a new streamed annuity coin, carving the 0.5% protocol fee. The lead
/// input emits the outputs; the rest bind via ASSERT_CONCURRENT_SPEND.
///
/// `funding` pairs each CAT coin with the synthetic key that controls it, so the
/// principal may be sourced from coins under DIFFERENT wallet keys.
#[allow(clippy::too_many_arguments)]
pub fn build_create(
    ctx: &mut SpendContext,
    asset_id: Bytes32,
    funding: Vec<(Cat, PublicKey)>,
    recipient: Bytes32,
    clawback_ph: Option<Bytes32>,
    end_time: u64,
    start_time: u64,
    principal: u64,
) -> Result<UnsignedBundle> {
    require_supported(asset_id)?;
    build_create_inner(
        ctx, asset_id, funding, recipient, clawback_ph, end_time, start_time, principal,
        0, None,
    )
}

/// Same as `build_create` but without the allow-list guard (test/internal use:
/// the simulator can't mint a CAT with a real allow-listed asset id).
///
/// Funding can span MULTIPLE keys: each `(Cat, PublicKey)` pair is spent with its
/// own `StandardLayer`. Only the LEAD coin emits the create outputs (annuity +
/// fee + change); the rest bind to the lead via ASSERT_CONCURRENT_SPEND.
#[allow(clippy::too_many_arguments)]
pub fn build_create_inner(
    ctx: &mut SpendContext,
    asset_id: Bytes32,
    funding: Vec<(Cat, PublicKey)>,
    recipient: Bytes32,
    clawback_ph: Option<Bytes32>,
    end_time: u64,
    start_time: u64,
    principal: u64,
    // Optional XCH network (farming) fee in mojos.
    network_fee: u64,
    // XCH funder coin (+ its synthetic key) used to pay `network_fee`.
    xch_fee: Option<(Coin, PublicKey)>,
) -> Result<UnsignedBundle> {
    if funding.is_empty() {
        return Err(Error::Custom("no funding coins".into()));
    }
    // Vesting window must be positive: end<=start makes the puzzle's
    // `(end - last)` denominator zero, so every claim div-by-zeros in CLVM and
    // the funds lock forever. Reject it at construction.
    if end_time <= start_time {
        return Err(Error::Custom("end_time must be strictly after start_time".into()));
    }
    if principal == 0 {
        return Err(Error::Custom("principal must be positive".into()));
    }
    if funding.iter().any(|(c, _)| c.info.asset_id != asset_id) {
        return Err(Error::Custom("funding coin asset id mismatch".into()));
    }
    let total: u64 = funding.iter().map(|(c, _)| c.coin.amount).sum();
    if total < principal {
        return Err(Error::Custom("insufficient funding for principal".into()));
    }

    // u128 intermediate: `principal * 50` overflows u64 for very large CAT
    // supplies. `fee <= principal`, so the cast back is lossless.
    let fee = ((principal as u128) * u128::from(PROTOCOL_FEE_BPS) / 10_000) as u64;
    let annuity_amount = principal - fee;
    let change = total - principal;

    let info = AnnuityInfo::new(recipient, clawback_ph, end_time, start_time);
    let inner_ph: Bytes32 = info.inner_puzzle_hash().into();
    // Launch hints: coin is hinted to `recipient` (first memo) so the beneficiary
    // can find it via getCoinRecordsByHint, and the params are recoverable.
    let memos = Memos::Some(ctx.alloc(&info.launch_hints())?);
    let (lead, lead_pk) = funding[0];

    let mut conds = Conditions::new().create_coin(inner_ph, annuity_amount, memos);
    if fee > 0 {
        conds = conds.create_coin(protocol_fee_puzzle_hash(), fee, Memos::None);
    }
    if change > 0 {
        // Change returns to the lead coin's own p2 (one of the contributing keys).
        conds = conds.create_coin(lead.info.p2_puzzle_hash, change, Memos::None);
    }

    let lead_spend = StandardLayer::new(lead_pk).spend_with_conditions(ctx, conds)?;
    let mut cat_spends = vec![CatSpend::new(lead, lead_spend)];
    for (c, pk) in &funding[1..] {
        let bind = StandardLayer::new(*pk).spend_with_conditions(
            ctx,
            Conditions::new().assert_concurrent_spend(lead.coin.coin_id()),
        )?;
        cat_spends.push(CatSpend::new(*c, bind));
    }

    let children = Cat::spend_all(ctx, &cat_spends)?;
    let stream_id = children
        .iter()
        .find(|c| c.info.p2_puzzle_hash == inner_ph)
        .map(|c| c.coin.coin_id())
        .ok_or_else(|| Error::Custom("annuity coin not created".into()))?;

    // Attach an XCH network fee from a funder coin (recreating its change).
    if network_fee > 0 {
        let (xch_coin, xch_key) =
            xch_fee.ok_or_else(|| Error::Custom("network fee requires an XCH funder coin".into()))?;
        let mut fee_conds = Conditions::new().reserve_fee(network_fee);
        let change = xch_coin.amount.saturating_sub(network_fee);
        if change > 0 {
            fee_conds = fee_conds.create_coin(xch_coin.puzzle_hash, change, Memos::None);
        }
        StandardLayer::new(xch_key).spend(ctx, xch_coin, fee_conds)?;
    }

    Ok(UnsignedBundle { coin_spends: ctx.take(), stream_id })
}

/// CLAIM — owner pulls vested value (to `owner_hash`); the remainder continues as
/// `STREAM<owner_hash>` with last advanced to the (clamped) payment time. The
/// owner authorizes by revealing + running their standard p2 (which emits its
/// AGG_SIG). `owner_pk` is the owner's synthetic key.
#[allow(clippy::too_many_arguments)]
pub fn build_claim(
    ctx: &mut SpendContext,
    info: &AnnuityInfo,
    annuity_coin: Coin,
    lineage_proof: LineageProof,
    asset_id: Bytes32,
    owner_pk: PublicKey,
    claim_time: u64,
) -> Result<UnsignedBundle> {
    let pt = info.clamp_time(claim_time);
    let coin_id = annuity_coin.coin_id();
    let cat = annuity_cat(annuity_coin, lineage_proof, asset_id, info.inner_puzzle_hash().into());
    let solution = claim_solution(ctx, owner_pk, annuity_coin.amount, pt)?;
    let inner = inner_spend(ctx, info, solution)?;
    Cat::spend_all(ctx, &[CatSpend::new(cat, inner)])?;
    Ok(UnsignedBundle { coin_spends: ctx.take(), stream_id: coin_id })
}

/// CLAWBACK — issuer terminates (recipient gets accrued, issuer gets remainder).
/// The owner is NOT run; the issuer authorizes via a mode-23 message from
/// `issuer_coin`.
#[allow(clippy::too_many_arguments)]
pub fn build_clawback(
    ctx: &mut SpendContext,
    info: &AnnuityInfo,
    annuity_coin: Coin,
    lineage_proof: LineageProof,
    asset_id: Bytes32,
    issuer_pk: PublicKey,
    issuer_coin: Coin,
    payment_time: u64,
) -> Result<UnsignedBundle> {
    let pt = info.clamp_time(payment_time);
    let coin_id = annuity_coin.coin_id();
    authorize_message(ctx, issuer_pk, issuer_coin, clawback_message(annuity_coin.amount, pt), coin_id)?;
    let cat = annuity_cat(annuity_coin, lineage_proof, asset_id, info.inner_puzzle_hash().into());
    let inner = inner_spend(ctx, info, clawback_solution(annuity_coin.amount, pt))?;
    Cat::spend_all(ctx, &[CatSpend::new(cat, inner)])?;
    Ok(UnsignedBundle { coin_spends: ctx.take(), stream_id: coin_id })
}

/// TRANSFER — reassign ownership. The owner's revealed p2 directs the whole coin
/// to `new_recipient`; the layer re-wraps it as `STREAM<new_recipient>`, so
/// vesting state is preserved. `owner_pk` is the current owner's synthetic key.
#[allow(clippy::too_many_arguments)]
pub fn build_transfer(
    ctx: &mut SpendContext,
    info: &AnnuityInfo,
    annuity_coin: Coin,
    lineage_proof: LineageProof,
    asset_id: Bytes32,
    owner_pk: PublicKey,
    new_recipient: Bytes32,
) -> Result<UnsignedBundle> {
    let coin_id = annuity_coin.coin_id();
    let cat = annuity_cat(annuity_coin, lineage_proof, asset_id, info.inner_puzzle_hash().into());
    let solution =
        transfer_solution(ctx, owner_pk, annuity_coin.amount, new_recipient, Conditions::new())?;
    let inner = inner_spend(ctx, info, solution)?;
    Cat::spend_all(ctx, &[CatSpend::new(cat, inner)])?;
    Ok(UnsignedBundle { coin_spends: ctx.take(), stream_id: coin_id })
}

/// OPEN SELL OFFER — the maker side of an annuity ⇄ XCH trade with NO named
/// buyer. The maker's revealed p2 directs the annuity to `SETTLEMENT_PAYMENT_HASH`
/// (the layer re-wraps it → a PARKED `CAT<STREAM<SETTLEMENT>>` coin) AND asserts
/// the settlement announcement for the requested XCH payment to `maker_receive_ph`.
/// The maker signs this whole transfer (via the revealed p2). The parked coin is
/// then spent by the taker (`build_take_offer`), who names themselves owner.
#[allow(clippy::too_many_arguments)]
pub fn build_open_offer(
    ctx: &mut SpendContext,
    info: &AnnuityInfo,
    annuity_coin: Coin,
    lineage_proof: LineageProof,
    asset_id: Bytes32,
    owner_pk: PublicKey,
    maker_receive_ph: Bytes32,
    xch_amount: u64,
) -> Result<OfferUnsigned> {
    // A clawbackable annuity must never be listed: the clawback authority is
    // curried state preserved across the transfer, so the issuer could reclaim
    // the unvested remainder right after a taker pays. Only permanent annuities
    // are sellable.
    if info.clawback_ph.is_some() {
        return Err(Error::ClawbackableNotSellable);
    }
    let coin_id = annuity_coin.coin_id();
    let (_np, settlement_id) = settlement_terms(ctx, coin_id, maker_receive_ph, xch_amount);

    let cat = annuity_cat(annuity_coin, lineage_proof, asset_id, info.inner_puzzle_hash().into());
    let settle_ph = Bytes32::from(SETTLEMENT_PAYMENT_HASH);
    // Maker parks the annuity under the settlement puzzle, gated on the taker's
    // XCH payment announcement.
    let extra = Conditions::new().assert_puzzle_announcement(settlement_id);
    let solution = transfer_solution(ctx, owner_pk, annuity_coin.amount, settle_ph, extra)?;
    let inner = inner_spend(ctx, info, solution)?;
    Cat::spend_all(ctx, &[CatSpend::new(cat, inner)])?;

    // Append the REQUESTED-side notarized payment as a standard settlement
    // "skeleton" spend so the offer is COMPLETE and self-describing: a taker who
    // only has the `offer1` string can decode it and recover both the requested
    // XCH amount AND where it is paid (`maker_receive_ph`). This mirrors how
    // `chia_sdk_driver::Offer::to_spend_bundle` encodes requested XCH payments —
    // a CoinSpend on a dummy coin `Coin(parent=0, SETTLEMENT_PAYMENT_HASH, 0)`
    // whose puzzle is the bare settlement-payments puzzle and whose solution
    // carries the `NotarizedPayment`. It contributes no real coin (parent is the
    // null coin id) but round-trips through `encode_offer`/`decode_offer`.
    let (np, _) = settlement_terms(ctx, coin_id, maker_receive_ph, xch_amount);
    let requested_puzzle = SettlementLayer.construct_puzzle(ctx)?;
    let requested_solution = SettlementLayer
        .construct_solution(ctx, SettlementPaymentsSolution { notarized_payments: vec![np] })?;
    let requested_coin = Coin::new(Bytes32::default(), settle_ph, 0);
    ctx.spend(requested_coin, Spend::new(requested_puzzle, requested_solution))?;

    Ok(OfferUnsigned {
        coin_spends: ctx.take(),
        stream_id: coin_id,
        settlement_id,
        nonce: coin_id,
        maker_puzzle_hash: maker_receive_ph,
        xch_amount,
    })
}

/// TAKE an open offer. The taker becomes the new owner: spends the PARKED
/// `CAT<STREAM<SETTLEMENT>>` coin in TRANSFER mode, revealing the SETTLEMENT
/// puzzle as the owner, whose notarized payment directs the coin to the taker
/// (the layer re-wraps → `STREAM<taker>`) AND announces the maker's XCH payment.
/// Also pays `xch_amount` XCH into settlement → the maker.
///
/// The parked coin is EPHEMERAL: created by the maker's park spend (provided by
/// the caller as `parked_coin` + `parked_lineage`) and spent here in the same
/// bundle.
#[allow(clippy::too_many_arguments)]
pub fn build_take_offer(
    ctx: &mut SpendContext,
    info: &AnnuityInfo,
    parked_coin: Coin,
    parked_lineage: LineageProof,
    asset_id: Bytes32,
    taker_recipient: Bytes32,
    maker_receive_ph: Bytes32,
    xch_amount: u64,
    taker_xch_coin: Coin,
    taker_pk: PublicKey,
) -> Result<UnsignedBundle> {
    // The parked coin is currently owned by SETTLEMENT_PAYMENT_HASH.
    let settle_ph = Bytes32::from(SETTLEMENT_PAYMENT_HASH);
    let parked_info = AnnuityInfo { recipient: settle_ph, ..*info };
    let parked_id = parked_coin.coin_id();

    // 1) Taker pays the XCH into the settlement puzzle (recreating change).
    let mut pay_conds = Conditions::new().create_coin(settle_ph, xch_amount, Memos::None);
    let change = taker_xch_coin.amount.saturating_sub(xch_amount);
    if change > 0 {
        pay_conds = pay_conds.create_coin(taker_xch_coin.puzzle_hash, change, Memos::None);
    }
    StandardLayer::new(taker_pk).spend(ctx, taker_xch_coin, pay_conds)?;

    // 2) The XCH→maker settlement spend (creates the announcement the maker's
    //    park asserts). Nonce = the offered annuity coin id (= parked-coin parent).
    let (xch_np, _settlement_id) =
        settlement_terms(ctx, parked_coin.parent_coin_info, maker_receive_ph, xch_amount);
    let settle_xch_coin = Coin::new(taker_xch_coin.coin_id(), settle_ph, xch_amount);
    let settle_xch_puzzle = SettlementLayer.construct_puzzle(ctx)?;
    let settle_xch_solution = SettlementLayer
        .construct_solution(ctx, SettlementPaymentsSolution { notarized_payments: vec![xch_np] })?;
    ctx.spend(settle_xch_coin, Spend::new(settle_xch_puzzle, settle_xch_solution))?;

    // 3) Spend the parked annuity in TRANSFER mode. The revealed owner is the
    //    SETTLEMENT puzzle; its notarized payment directs the whole coin to the
    //    taker (re-wrapped → STREAM<taker>). Nonce = parked coin id (ephemeral).
    let memos = ctx.alloc(&[taker_recipient])?;
    let annuity_np = NotarizedPayment::new(
        parked_id,
        vec![Payment::new(taker_recipient, parked_coin.amount, Memos::Some(memos))],
    );
    let owner_puzzle = SettlementLayer.construct_puzzle(ctx)?;
    let owner_solution = SettlementLayer.construct_solution(
        ctx,
        SettlementPaymentsSolution { notarized_payments: vec![annuity_np] },
    )?;
    let cat = annuity_cat(
        parked_coin,
        parked_lineage,
        asset_id,
        parked_info.inner_puzzle_hash().into(),
    );
    let solution =
        transfer_solution_with_owner(Spend::new(owner_puzzle, owner_solution), parked_coin.amount);
    let inner = inner_spend(ctx, &parked_info, solution)?;
    Cat::spend_all(ctx, &[CatSpend::new(cat, inner)])?;

    Ok(UnsignedBundle { coin_spends: ctx.take(), stream_id: parked_id })
}

/// The trade terms recovered by DECODING an `offer1` produced by
/// `build_open_offer`: everything a taker needs to fill it.
struct OfferTerms {
    info: AnnuityInfo,
    asset_id: Bytes32,
    /// The PARKED `CAT<STREAM<SETTLEMENT>>` coin the maker's park spend creates.
    parked_coin: Coin,
    parked_lineage: LineageProof,
    /// Where the requested XCH is paid (recovered from the requested-payment skeleton).
    maker_puzzle_hash: Bytes32,
    /// Requested XCH amount in mojos (recovered from the requested-payment skeleton).
    xch_amount: u64,
}

/// Decode a complete `offer1` string (as produced by `build_open_offer`) and
/// recover the full trade terms WITHOUT any side information: the annuity park
/// spend yields the annuity params + the parked coin & its lineage proof, and the
/// requested-payment settlement skeleton yields `maker_puzzle_hash` + `xch_amount`.
fn parse_offer(ctx: &mut SpendContext, offer: &str) -> Result<OfferTerms> {
    let bundle = decode_offer(offer).map_err(|e| Error::Custom(format!("decode offer: {e}")))?;

    let settle_ph = Bytes32::from(SETTLEMENT_PAYMENT_HASH);
    let mut park: Option<(AnnuityInfo, Bytes32, Coin, LineageProof)> = None;
    let mut requested: Option<(Bytes32, u64)> = None;

    for cs in &bundle.coin_spends {
        // Requested-payment skeleton: dummy coin (null parent) under SETTLEMENT.
        if cs.coin.parent_coin_info == Bytes32::default() && cs.coin.puzzle_hash == settle_ph {
            // Reject ambiguity: exactly one requested-payment skeleton, with
            // exactly one notarized payment of exactly one output. Otherwise a
            // crafted offer could make different decoders read different terms.
            if requested.is_some() {
                return Err(Error::Custom("offer has multiple requested-payment skeletons".into()));
            }
            let sol = ctx.alloc(&cs.solution)?;
            let parsed = ctx.extract::<SettlementPaymentsSolution>(sol)?;
            if parsed.notarized_payments.len() != 1 {
                return Err(Error::Custom("requested payment must have exactly one notarized payment".into()));
            }
            let np = &parsed.notarized_payments[0];
            if np.payments.len() != 1 {
                return Err(Error::Custom("requested payment must have exactly one output".into()));
            }
            let payment = &np.payments[0];
            requested = Some((payment.puzzle_hash, payment.amount));
            continue;
        }

        // The annuity park spend: a CAT<STREAM<SETTLEMENT>> coin with a real parent.
        let pr = ctx.alloc(&cs.puzzle_reveal)?;
        let puzzle = Puzzle::parse(ctx, pr);
        let Ok(Some(cat)) = CatLayer::<HashedPtr>::parse_puzzle(ctx, puzzle) else {
            continue;
        };
        let inner = Puzzle::parse(ctx, cat.inner_puzzle.ptr());
        let Some(curried) = inner.as_curried() else {
            continue;
        };
        if curried.mod_hash != stream_mod_tree_hash() {
            continue;
        }
        // This is the maker's park spend: it SPENDS the eve `CAT<STREAM<maker>>`
        // coin and re-routes it to a PARKED `CAT<STREAM<SETTLEMENT>>` coin. The
        // curried owner here is the MAKER (the eve owner); `build_take_offer`
        // takes this eve `info` and derives the parked (SETTLEMENT) info itself.
        let sc: StreamCurry = ctx.extract(curried.args)?;
        let eve_info = AnnuityInfo::from_curry(&sc);

        // Recover the parked child coin + its lineage proof from the park spend.
        let sol = ctx.alloc(&cs.solution)?;
        let child = child_from_parent_spend(ctx, cs.coin, pr, sol)?
            .ok_or_else(|| Error::Custom("park spend did not create a parked annuity".into()))?;
        // The discovered child's `recipient` is SETTLEMENT (the re-routed owner);
        // its end_time/last_payment_time match the eve coin. Pass the eve info.
        park = Some((eve_info, child.asset_id, child.coin, child.lineage_proof));
    }

    let (info, asset_id, parked_coin, parked_lineage) =
        park.ok_or_else(|| Error::Custom("offer has no annuity park spend".into()))?;
    let (maker_puzzle_hash, xch_amount) =
        requested.ok_or_else(|| Error::Custom("offer has no requested payment".into()))?;

    // Refuse to inspect/take an offer for a clawbackable annuity: even a
    // hand-crafted offer can't trick a taker into buying something the issuer
    // can immediately claw back. Only permanent annuities are tradable.
    if info.clawback_ph.is_some() {
        return Err(Error::ClawbackableNotSellable);
    }

    Ok(OfferTerms {
        info,
        asset_id,
        parked_coin,
        parked_lineage,
        maker_puzzle_hash,
        xch_amount,
    })
}

/// TAKE an offer given ONLY the `offer1` string (plus the taker's choices). This
/// is the non-wasm core that both the wasm export and the sim test call: it
/// decodes the offer, recovers every parameter, and builds the taker's fill
/// bundle via `build_take_offer`. The annuity park spend (with the maker's
/// signature) lives inside the decoded offer; the caller is responsible for
/// combining it with the returned taker spends (and the maker's signature) before
/// broadcasting.
pub fn take_from_offer(
    ctx: &mut SpendContext,
    offer: &str,
    taker_recipient: Bytes32,
    taker_xch_coin: Coin,
    taker_pk: PublicKey,
) -> Result<UnsignedBundle> {
    let t = parse_offer(ctx, offer)?;
    build_take_offer(
        ctx,
        &t.info,
        t.parked_coin,
        t.parked_lineage,
        t.asset_id,
        taker_recipient,
        t.maker_puzzle_hash,
        t.xch_amount,
        taker_xch_coin,
        taker_pk,
    )
}

/// Read-only summary of an `offer1`'s trade terms, for display before taking.
pub struct OfferInspection {
    pub asset_id: Bytes32,
    /// Remaining annuity amount (the parked coin's amount).
    pub amount: u64,
    pub end_time: u64,
    pub last_payment_time: u64,
    pub clawback_ph: Option<Bytes32>,
    pub maker_puzzle_hash: Bytes32,
    /// XCH the taker must pay (mojos).
    pub xch_amount: u64,
}

/// Decode an `offer1` and recover its trade terms WITHOUT building a spend, so
/// the dApp can show the taker exactly what they receive and pay.
pub fn inspect_offer(offer: &str) -> Result<OfferInspection> {
    let mut ctx = SpendContext::new();
    let t = parse_offer(&mut ctx, offer)?;
    Ok(OfferInspection {
        asset_id: t.asset_id,
        amount: t.parked_coin.amount,
        end_time: t.info.end_time,
        last_payment_time: t.info.last_payment_time,
        clawback_ph: t.info.clawback_ph,
        maker_puzzle_hash: t.maker_puzzle_hash,
        xch_amount: t.xch_amount,
    })
}

/// Decode an `offer1` and return the maker's REAL park spend(s) (those with a
/// non-null parent — the requested-payment skeleton is excluded) plus the maker's
/// aggregated signature recovered from the offer. The dApp combines these with the
/// taker spends from `take_from_offer` to form a complete, broadcastable bundle.
pub fn maker_spends_from_offer(offer: &str) -> Result<(Vec<CoinSpend>, chia_bls::Signature)> {
    let bundle = decode_offer(offer).map_err(|e| Error::Custom(format!("decode offer: {e}")))?;
    let maker_spends = bundle
        .coin_spends
        .into_iter()
        .filter(|cs| cs.coin.parent_coin_info != Bytes32::default())
        .collect();
    Ok((maker_spends, bundle.aggregated_signature))
}
