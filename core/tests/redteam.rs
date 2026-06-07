//! Red-team round 2 — exploit angles NOT covered by `adversarial.rs` / `exploits.rs`.
//!
//! Every attack runs on the `chia-sdk-test` simulator (real CLVM + BLS + CAT
//! conservation), so a rejection is a true consensus verdict. Focus areas:
//!   1. CAT SUPPLY INTEGRITY through the stream re-wrap (mint / melt) — the
//!      scariest class: can a TRANSFER create or destroy CAT value?
//!   2. OFFER ECONOMIC INTEGRITY — can a taker underpay or redirect the maker's
//!      XCH while still pulling the annuity?
//!   3. CLAIM-SIDE LAUNDERING — the claim continuation must preserve the
//!      clawback authority + vesting window (only the transfer side was tested).
//!
//! Honest baselines that these mirror already pass in the other suites, so each
//! rejection here is attributable to the attacked guard, not a construction error.

use chia_protocol::{Bytes32, Coin};
use chia_puzzle_types::cat::CatArgs;
use chia_puzzle_types::{LineageProof, Memos};
use chia_puzzles::SETTLEMENT_PAYMENT_HASH;
use chia_sdk_driver::{Cat, CatSpend, SpendContext, SpendWithConditions, StandardLayer};
use chia_sdk_test::Simulator;
use chia_sdk_types::Conditions;

use xchannuity_core::builders::{build_open_offer, build_take_offer};
use xchannuity_core::spend::{claim_solution, inner_spend, transfer_solution_with_owner};
use xchannuity_core::AnnuityInfo;

const START: u64 = 1000;
const END: u64 = 2000;
const AMOUNT: u64 = 100;

/// Mint a streamed CAT whose inner puzzle is the annuity for `info`.
fn issue_annuity(
    sim: &mut Simulator,
    ctx: &mut SpendContext,
    info: &AnnuityInfo,
    amount: u64,
) -> anyhow::Result<Cat> {
    let minter = sim.bls(amount);
    let inner_ph: Bytes32 = info.inner_puzzle_hash().into();
    let memos = ctx.hint(inner_ph)?;
    let (issue, cats) = Cat::issue_with_coin(
        ctx,
        minter.coin.coin_id(),
        amount,
        Conditions::new().create_coin(inner_ph, amount, memos),
    )?;
    StandardLayer::new(minter.pk).spend(ctx, minter.coin, issue)?;
    sim.spend_coins(ctx.take(), &[minter.sk])?;
    Ok(cats[0])
}

fn annuity_cat(coin: Coin, lineage: LineageProof, asset_id: Bytes32, inner_ph: Bytes32) -> Cat {
    Cat {
        coin,
        lineage_proof: Some(lineage),
        info: chia_sdk_driver::CatInfo { asset_id, hidden_puzzle_hash: None, p2_puzzle_hash: inner_ph },
    }
}

// ---------------------------------------------------------------------------
// 1. CAT SUPPLY INTEGRITY through the stream re-wrap
// ---------------------------------------------------------------------------

#[test]
fn transfer_cannot_inflate_cat_supply() {
    // The owner authorizes a TRANSFER, but the revealed p2 directs MORE than the
    // coin holds (amount = AMOUNT + 1000). The stream layer faithfully re-wraps the
    // owner's CREATE_COIN as STREAM<buyer> at the inflated amount — and the CAT
    // layer's value-conservation ring rejects it (output > input). The annuity
    // cannot be used to mint CAT out of thin air.
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();
    let owner = sim.bls(0);
    let buyer = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT).unwrap();

    let attempt: anyhow::Result<()> = (|| {
        let memos = ctx.alloc(&[buyer.puzzle_hash])?;
        let conds = Conditions::new().create_coin(buyer.puzzle_hash, AMOUNT + 1000, Memos::Some(memos));
        let owner_spend = StandardLayer::new(owner.pk).spend_with_conditions(ctx, conds)?;
        let solution = transfer_solution_with_owner(owner_spend, AMOUNT);
        let cat = annuity_cat(annuity.coin, annuity.lineage_proof.unwrap(), annuity.info.asset_id, info.inner_puzzle_hash().into());
        let inner = inner_spend(ctx, &info, solution)?;
        Cat::spend_all(ctx, &[CatSpend::new(cat, inner)])?;
        sim.spend_coins(ctx.take(), &[owner.sk])?;
        Ok(())
    })();
    assert!(attempt.is_err(), "a transfer must not be able to inflate the CAT supply");
}

#[test]
fn transfer_cannot_melt_and_pocket_value() {
    // The owner directs LESS than the coin holds (AMOUNT - 40), hoping the missing
    // 40 leaks out as liquid CAT they could grab. CAT conservation requires the
    // outputs of this asset to sum to the input exactly (no TAIL melt magic here),
    // so under-creating is rejected too — value can't be skimmed off a transfer.
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();
    let owner = sim.bls(0);
    let buyer = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT).unwrap();

    let attempt: anyhow::Result<()> = (|| {
        let memos = ctx.alloc(&[buyer.puzzle_hash])?;
        let conds = Conditions::new().create_coin(buyer.puzzle_hash, AMOUNT - 40, Memos::Some(memos));
        let owner_spend = StandardLayer::new(owner.pk).spend_with_conditions(ctx, conds)?;
        let solution = transfer_solution_with_owner(owner_spend, AMOUNT);
        let cat = annuity_cat(annuity.coin, annuity.lineage_proof.unwrap(), annuity.info.asset_id, info.inner_puzzle_hash().into());
        let inner = inner_spend(ctx, &info, solution)?;
        Cat::spend_all(ctx, &[CatSpend::new(cat, inner)])?;
        sim.spend_coins(ctx.take(), &[owner.sk])?;
        Ok(())
    })();
    assert!(attempt.is_err(), "a transfer must not be able to melt/skim CAT value");
}

// ---------------------------------------------------------------------------
// 2. CLAIM-SIDE LAUNDERING — continuation must keep clawback authority + window
// ---------------------------------------------------------------------------

#[test]
fn claim_continuation_preserves_clawback_and_window() {
    // The transfer side is tested in exploits.rs; do the same for CLAIM. An owner
    // claiming a clawbackable annuity must NOT be able to have the streamed
    // remainder come back un-clawbackable or with a reset vesting window — the
    // layer re-wraps the continuation with the SAME curried clawback_ph + end_time.
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();
    let owner = sim.bls(0);
    let issuer = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, Some(issuer.puzzle_hash), END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT).unwrap();

    sim.set_next_timestamp(1500).unwrap();
    let solution = claim_solution(ctx, owner.pk, annuity.coin.amount, 1500).unwrap();
    let cat = annuity_cat(annuity.coin, annuity.lineage_proof.unwrap(), annuity.info.asset_id, info.inner_puzzle_hash().into());
    let inner = inner_spend(ctx, &info, solution).unwrap();
    let children = Cat::spend_all(ctx, &[CatSpend::new(cat, inner)]).unwrap();
    sim.spend_coins(ctx.take(), &[owner.sk]).unwrap();

    // Correct continuation: clawback_ph preserved, end unchanged, last advanced to 1500.
    let preserved: Bytes32 = info.after_claim(1500).inner_puzzle_hash().into();
    // A laundered (clawback-stripped) continuation would have THIS hash:
    let stripped: Bytes32 = AnnuityInfo::new(owner.puzzle_hash, None, END, 1500)
        .inner_puzzle_hash()
        .into();
    // A window-reset continuation (end pushed out) would have THIS hash:
    let reset: Bytes32 = AnnuityInfo::new(owner.puzzle_hash, Some(issuer.puzzle_hash), END + 1, 1500)
        .inner_puzzle_hash()
        .into();
    assert!(
        children.iter().any(|c| c.info.p2_puzzle_hash == preserved),
        "claim continuation must keep clawback authority + window"
    );
    assert!(
        !children.iter().any(|c| c.info.p2_puzzle_hash == stripped),
        "claim must NOT strip the clawback authority"
    );
    assert!(
        !children.iter().any(|c| c.info.p2_puzzle_hash == reset),
        "claim must NOT reset/extend the vesting window"
    );
}

// ---------------------------------------------------------------------------
// 3. OFFER ECONOMIC INTEGRITY — the maker cannot be shortchanged
// ---------------------------------------------------------------------------

/// Issue an annuity and build the maker's open offer; returns (maker park spends,
/// parked coin, parked lineage, asset id, info, xch_price, maker_ph) so a test can
/// build a tampered take against it.
fn make_open_offer(
    sim: &mut Simulator,
    ctx: &mut SpendContext,
    maker_ph: Bytes32,
    maker_pk: chia_bls::PublicKey,
    xch_price: u64,
) -> anyhow::Result<(Vec<chia_protocol::CoinSpend>, Coin, LineageProof, Bytes32, AnnuityInfo)> {
    let info = AnnuityInfo::new(maker_ph, None, END, START);
    let annuity = issue_annuity(sim, ctx, &info, AMOUNT)?;
    let asset_id = annuity.info.asset_id;

    let offer = build_open_offer(
        ctx,
        &info,
        annuity.coin,
        annuity.lineage_proof.unwrap(),
        asset_id,
        maker_pk,
        maker_ph,
        xch_price,
    )?;
    let maker_spends: Vec<_> = offer
        .coin_spends
        .into_iter()
        .filter(|c| c.coin.parent_coin_info != Bytes32::default())
        .collect();

    let settle_ph = Bytes32::from(SETTLEMENT_PAYMENT_HASH);
    let parked_info = AnnuityInfo::new(settle_ph, None, END, START);
    let parked_ph: Bytes32 = CatArgs::curry_tree_hash(asset_id, parked_info.inner_puzzle_hash()).into();
    let parked_coin = Coin::new(annuity.coin.coin_id(), parked_ph, AMOUNT);
    let parked_lineage = LineageProof {
        parent_parent_coin_info: annuity.coin.parent_coin_info,
        parent_inner_puzzle_hash: info.inner_puzzle_hash().into(),
        parent_amount: annuity.coin.amount,
    };
    Ok((maker_spends, parked_coin, parked_lineage, asset_id, info))
}

#[test]
fn offer_taker_underpaying_xch_is_rejected() {
    // The maker's park asserts the settlement announcement for EXACTLY `xch_price`
    // to `maker_ph` (nonce = annuity coin id). A taker who pays one mojo less makes
    // a settlement announcement that hashes differently → the maker's
    // ASSERT_PUZZLE_ANNOUNCEMENT is unsatisfied → the whole take is rejected. The
    // taker cannot pull the annuity while underpaying the maker.
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();
    let maker = sim.bls(0);
    let taker = sim.bls(50);
    let xch_price = 9u64;

    let attempt: anyhow::Result<()> = (|| {
        let (maker_spends, parked_coin, parked_lineage, asset_id, info) =
            make_open_offer(&mut sim, ctx, maker.puzzle_hash, maker.pk, xch_price)?;
        // TAMPER: build the take paying one mojo LESS than requested.
        let take = build_take_offer(
            ctx,
            &info,
            parked_coin,
            parked_lineage,
            asset_id,
            taker.puzzle_hash,
            maker.puzzle_hash,
            xch_price - 1, // underpay
            taker.coin,
            taker.pk,
        )?;
        let mut all = maker_spends;
        all.extend(take.coin_spends);
        sim.spend_coins(all, &[maker.sk, taker.sk])?;
        Ok(())
    })();
    assert!(attempt.is_err(), "a taker underpaying the maker's XCH must be rejected");
}

#[test]
fn offer_taker_redirecting_xch_to_self_is_rejected() {
    // The settlement announcement the maker asserts commits to the PAYEE puzzle
    // hash. A taker who routes the XCH to their OWN address (instead of the maker)
    // produces a non-matching announcement → the maker's assert fails → rejected.
    // The taker cannot keep both the XCH and take the annuity.
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();
    let maker = sim.bls(0);
    let taker = sim.bls(50);
    let xch_price = 9u64;

    let attempt: anyhow::Result<()> = (|| {
        let (maker_spends, parked_coin, parked_lineage, asset_id, info) =
            make_open_offer(&mut sim, ctx, maker.puzzle_hash, maker.pk, xch_price)?;
        // TAMPER: route the XCH to the TAKER instead of the maker.
        let take = build_take_offer(
            ctx,
            &info,
            parked_coin,
            parked_lineage,
            asset_id,
            taker.puzzle_hash,
            taker.puzzle_hash, // redirect payment to self
            xch_price,
            taker.coin,
            taker.pk,
        )?;
        let mut all = maker_spends;
        all.extend(take.coin_spends);
        sim.spend_coins(all, &[maker.sk, taker.sk])?;
        Ok(())
    })();
    assert!(attempt.is_err(), "a taker redirecting the maker's XCH must be rejected");
}
