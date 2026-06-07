//! Adversarial drain tests against the ownership-layer streamed-annuity puzzle,
//! run on the chia-sdk-test simulator (real CLVM validation + BLS signatures).
//!
//! Threat models:
//!   * OWNER attacks — the legitimate recipient/issuer tries to extract MORE
//!     than the puzzle allows (accelerate vesting, claw back a permanent
//!     annuity, lie about the coin amount).
//!   * OUTSIDE-KEY attacks — a party with no control of the annuity tries to
//!     claim, steal ownership, or redirect a transfer by revealing the WRONG
//!     owner puzzle or omitting the owner's signature.
//!   * OWNERSHIP-LAYER attacks — wrong owner reveal (hash mismatch) is rejected;
//!     a parked STREAM<SETTLEMENT> coin cannot be drained as liquid CAT via
//!     claim; transfer cannot strip the stream wrapper.
//!
//! Honest flows must succeed; every attack must be REJECTED by consensus.

use chia_protocol::Bytes32;
use chia_puzzles::SETTLEMENT_PAYMENT_HASH;
use chia_sdk_driver::{Cat, CatSpend, SpendContext, StandardLayer};
use chia_sdk_test::Simulator;
use chia_sdk_types::Conditions;

use xchannuity_core::spend::{
    authorize_message, claim_solution, clawback_message, clawback_solution, inner_spend,
    transfer_solution,
};
use xchannuity_core::AnnuityInfo;

const START: u64 = 1000;
const END: u64 = 2000;
const AMOUNT: u64 = 100;

/// Issue a streamed CAT whose inner puzzle is our annuity puzzle for `info`.
/// Returns the eve annuity CAT coin.
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

// ---------------------------------------------------------------------------
// Honest flows — must SUCCEED
// ---------------------------------------------------------------------------

#[test]
fn honest_claim_pays_only_the_recipient() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let owner = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT)?;

    sim.set_next_timestamp(1500)?; // half the window elapsed
    let claim_time = 1500;

    // The owner authorizes by revealing + running their standard p2 (signs).
    let solution = claim_solution(ctx, owner.pk, annuity.coin.amount, claim_time)?;
    let inner = inner_spend(ctx, &info, solution)?;
    let children = Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
    sim.spend_coins(ctx.take(), &[owner.sk])?;

    let payout = children
        .iter()
        .find(|c| c.info.p2_puzzle_hash == owner.puzzle_hash)
        .expect("a CAT payout to the recipient");
    assert_eq!(payout.coin.amount, 50, "recipient receives exactly the vested half");

    let expected_cont: Bytes32 = info.after_claim(1500).inner_puzzle_hash().into();
    let cont = children
        .iter()
        .find(|c| c.info.p2_puzzle_hash == expected_cont)
        .expect("a recreated continuation annuity");
    assert_eq!(cont.coin.amount, 50, "remainder keeps streaming");
    Ok(())
}

#[test]
fn honest_transfer_moves_ownership_to_the_new_recipient() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let owner = sim.bls(0);
    let buyer = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT)?;

    // The current owner authorizes a plain transfer to the buyer (its revealed
    // p2 directs the coin to the buyer; the layer re-wraps to STREAM<buyer>).
    let solution = transfer_solution(
        ctx,
        owner.pk,
        annuity.coin.amount,
        buyer.puzzle_hash,
        Conditions::new(),
    )?;
    let inner = inner_spend(ctx, &info, solution)?;
    let children = Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
    sim.spend_coins(ctx.take(), &[owner.sk])?;

    let expected: Bytes32 = info.after_transfer(buyer.puzzle_hash).inner_puzzle_hash().into();
    let moved = children
        .iter()
        .find(|c| c.info.p2_puzzle_hash == expected)
        .expect("annuity recreated under the new recipient");
    assert_eq!(moved.coin.amount, AMOUNT, "whole remaining annuity transferred");
    Ok(())
}

#[test]
fn honest_clawback_splits_accrued_and_remainder() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let recipient = sim.bls(0);
    let issuer = sim.bls(0);
    let info = AnnuityInfo::new(recipient.puzzle_hash, Some(issuer.puzzle_hash), END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT)?;

    sim.set_next_timestamp(1400)?; // clawback must land BEFORE payment_time
    let pt = 1500;

    // the clawback authority (issuer) authorizes via message from its coin
    let issuer_msg_coin = sim.new_coin(issuer.puzzle_hash, 0);
    authorize_message(ctx, issuer.pk, issuer_msg_coin, clawback_message(annuity.coin.amount, pt), annuity.coin.coin_id())?;

    let inner = inner_spend(ctx, &info, clawback_solution(annuity.coin.amount, pt))?;
    let children = Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
    sim.spend_coins(ctx.take(), &[issuer.sk])?;

    let to_recipient = children
        .iter()
        .find(|c| c.info.p2_puzzle_hash == recipient.puzzle_hash)
        .expect("accrued paid to recipient");
    let to_issuer = children
        .iter()
        .find(|c| c.info.p2_puzzle_hash == issuer.puzzle_hash)
        .expect("remainder returned to issuer");
    assert_eq!(to_recipient.coin.amount, 50);
    assert_eq!(to_issuer.coin.amount, 50);
    Ok(())
}

// ---------------------------------------------------------------------------
// OWNER attacks — must FAIL
// ---------------------------------------------------------------------------

#[test]
fn owner_cannot_claim_unvested_future_value() {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let owner = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT).unwrap();

    sim.set_next_timestamp(1500).unwrap(); // only half the term has elapsed

    let attempt: anyhow::Result<()> = (|| {
        // try to grab the FULL amount by claiming as-of END_TIME
        let solution = claim_solution(ctx, owner.pk, annuity.coin.amount, END)?;
        let inner = inner_spend(ctx, &info, solution)?;
        Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
        sim.spend_coins(ctx.take(), &[owner.sk])?;
        Ok(())
    })();

    assert!(
        attempt.is_err(),
        "claiming end-time value at mid-term must fail ASSERT_SECONDS_ABSOLUTE"
    );
}

#[test]
fn permanent_annuity_cannot_be_clawed_back() {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let owner = sim.bls(0);
    // clawback_ph = None => permanent, non-clawbackable
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT).unwrap();

    sim.set_next_timestamp(1400).unwrap();
    let pt = 1500;

    let attempt: anyhow::Result<()> = (|| {
        let msg_coin = sim.new_coin(owner.puzzle_hash, 0);
        authorize_message(ctx, owner.pk, msg_coin, clawback_message(annuity.coin.amount, pt), annuity.coin.coin_id())?;
        let inner = inner_spend(ctx, &info, clawback_solution(annuity.coin.amount, pt))?;
        Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
        sim.spend_coins(ctx.take(), &[owner.sk])?;
        Ok(())
    })();

    assert!(attempt.is_err(), "clawback of a permanent annuity must be rejected (puzzle raises)");
}

#[test]
fn lying_about_coin_amount_fails() {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let owner = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT).unwrap();

    sim.set_next_timestamp(1500).unwrap();

    let attempt: anyhow::Result<()> = (|| {
        // claim asserting a my_amount larger than the real coin → ASSERT_MY_AMOUNT
        let solution = claim_solution(ctx, owner.pk, AMOUNT * 5, 1500)?;
        let inner = inner_spend(ctx, &info, solution)?;
        Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
        sim.spend_coins(ctx.take(), &[owner.sk])?;
        Ok(())
    })();

    assert!(attempt.is_err(), "a forged my_amount must be rejected");
}

// ---------------------------------------------------------------------------
// OUTSIDE-KEY attacks — must FAIL
// ---------------------------------------------------------------------------

#[test]
fn claim_without_owner_signature_fails() {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let owner = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT).unwrap();

    sim.set_next_timestamp(1500).unwrap();

    let attempt: anyhow::Result<()> = (|| {
        // build the claim with the correct owner reveal, but push WITHOUT the
        // owner's secret key → the revealed p2's AGG_SIG is unsatisfied.
        let solution = claim_solution(ctx, owner.pk, annuity.coin.amount, 1500)?;
        let inner = inner_spend(ctx, &info, solution)?;
        Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
        sim.spend_coins(ctx.take(), &[])?;
        Ok(())
    })();

    assert!(attempt.is_err(), "claim without the owner's signature must fail");
}

#[test]
fn wrong_owner_reveal_is_rejected() {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let owner = sim.bls(0);
    let attacker = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT).unwrap();

    sim.set_next_timestamp(1500).unwrap();

    let attempt: anyhow::Result<()> = (|| {
        // The attacker reveals THEIR OWN p2 (hash != curried owner_hash). The
        // layer's `run_owner` raises on the hash mismatch.
        let solution = claim_solution(ctx, attacker.pk, annuity.coin.amount, 1500)?;
        let inner = inner_spend(ctx, &info, solution)?;
        Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
        sim.spend_coins(ctx.take(), &[attacker.sk])?;
        Ok(())
    })();

    assert!(attempt.is_err(), "a mismatched owner reveal must abort the spend");
}

#[test]
fn outsider_cannot_forge_a_transfer_to_steal_the_annuity() {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let owner = sim.bls(0);
    let attacker = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT).unwrap();

    let attempt: anyhow::Result<()> = (|| {
        // attacker reveals their own p2 to direct the coin to themselves — but
        // its hash != the curried owner hash, so the layer raises.
        let solution = transfer_solution(
            ctx,
            attacker.pk,
            annuity.coin.amount,
            attacker.puzzle_hash,
            Conditions::new(),
        )?;
        let inner = inner_spend(ctx, &info, solution)?;
        Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
        sim.spend_coins(ctx.take(), &[attacker.sk])?;
        Ok(())
    })();

    assert!(attempt.is_err(), "an outsider must not be able to transfer ownership to themselves");
}

#[test]
fn offer_transfer_without_settlement_payment_fails() {
    // An offer-mode park asserts the settlement announcement, so the annuity
    // cannot move unless the buyer's payment side is spent in the same bundle.
    // The owner genuinely authorizes (signs) the parking transfer, but no
    // settlement announcement is produced — the taker tries to grab it for free.
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let owner = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT).unwrap();

    let settlement_id = Bytes32::new([0x42u8; 32]);
    let settle_ph = Bytes32::from(SETTLEMENT_PAYMENT_HASH);

    let attempt: anyhow::Result<()> = (|| {
        // owner signs a park gated on settlement_id — but nothing in the bundle
        // creates the matching puzzle announcement.
        let extra = Conditions::new().assert_puzzle_announcement(settlement_id);
        let solution = transfer_solution(ctx, owner.pk, annuity.coin.amount, settle_ph, extra)?;
        let inner = inner_spend(ctx, &info, solution)?;
        Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
        sim.spend_coins(ctx.take(), &[owner.sk])?;
        Ok(())
    })();

    assert!(
        attempt.is_err(),
        "taking an annuity via an offer without the settlement payment must fail"
    );
}

#[test]
fn transfer_destination_cannot_be_rewritten_by_a_watcher() {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let owner = sim.bls(0);
    let buyer = sim.bls(0);
    let attacker = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT).unwrap();

    let attempt: anyhow::Result<()> = (|| {
        // The owner authorizes (signs) a transfer to the BUYER. A mempool watcher
        // then swaps the destination to the ATTACKER while reusing the owner's
        // reveal. Because the owner's p2 signs over the delegated puzzle (which
        // contains the destination CREATE_COIN), the swapped destination breaks
        // the AGG_SIG. We model the swap by re-revealing the owner p2 directing
        // to the attacker but pushing only the owner's signature for the buyer
        // version — i.e. no valid signature exists for the tampered spend, so we
        // build the attacker-directed spend and push WITHOUT a fresh owner sig.
        let _ = buyer;
        let solution = transfer_solution(
            ctx,
            owner.pk,
            annuity.coin.amount,
            attacker.puzzle_hash,
            Conditions::new(),
        )?;
        let inner = inner_spend(ctx, &info, solution)?;
        Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
        // push without the owner's secret key: the AGG_SIG over the attacker
        // destination is unsatisfiable by anyone but the owner.
        sim.spend_coins(ctx.take(), &[])?;
        Ok(())
    })();

    assert!(
        attempt.is_err(),
        "rewriting the transfer destination must break the owner's signature"
    );
}

// ---------------------------------------------------------------------------
// OWNERSHIP-LAYER attacks — must FAIL
// ---------------------------------------------------------------------------

#[test]
fn parked_settlement_coin_cannot_be_drained_as_liquid_cat_via_claim() {
    // A coin parked as STREAM<SETTLEMENT> (mid-offer) must not be drainable as
    // liquid CAT through CLAIM mode: CLAIM strips the settlement's CREATE_COIN,
    // so an attacker cannot redirect a liquid payout to themselves. The only
    // liquid payout CLAIM makes is the vested split to owner_hash (= SETTLEMENT),
    // which the attacker cannot spend.
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let settle_ph = Bytes32::from(SETTLEMENT_PAYMENT_HASH);
    let info = AnnuityInfo::new(settle_ph, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT).unwrap();
    let attacker = sim.bls(0);

    sim.set_next_timestamp(1500).unwrap();

    let attempt: anyhow::Result<()> = (|| {
        // Attacker reveals their own p2 as the owner — but owner_hash is the
        // settlement hash, so the reveal mismatches and the layer raises. Even if
        // they could run it, CLAIM strips any CREATE_COIN they emit.
        let solution = claim_solution(ctx, attacker.pk, annuity.coin.amount, 1500)?;
        let inner = inner_spend(ctx, &info, solution)?;
        Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
        sim.spend_coins(ctx.take(), &[attacker.sk])?;
        Ok(())
    })();

    assert!(
        attempt.is_err(),
        "a parked STREAM<SETTLEMENT> coin must not be drainable as liquid CAT via claim"
    );
}

#[test]
fn transfer_cannot_strip_the_stream_wrapper() -> anyhow::Result<()> {
    // The layer ALWAYS re-wraps the owner's CREATE_COIN as STREAM<dest>. Prove the
    // continuation is STREAM<buyer> (a CAT-wrapped annuity), never a liquid CAT to
    // the buyer's bare p2 hash.
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let owner = sim.bls(0);
    let buyer = sim.bls(0);
    let info = AnnuityInfo::new(owner.puzzle_hash, None, END, START);
    let annuity = issue_annuity(&mut sim, ctx, &info, AMOUNT)?;

    let solution = transfer_solution(
        ctx,
        owner.pk,
        annuity.coin.amount,
        buyer.puzzle_hash,
        Conditions::new(),
    )?;
    let inner = inner_spend(ctx, &info, solution)?;
    let children = Cat::spend_all(ctx, &[CatSpend::new(annuity, inner)])?;
    sim.spend_coins(ctx.take(), &[owner.sk])?;

    // The output coin's inner puzzle hash is STREAM<buyer>, NOT the buyer's bare
    // p2 hash — value never escaped the streaming wrapper.
    let stream_buyer: Bytes32 = info.after_transfer(buyer.puzzle_hash).inner_puzzle_hash().into();
    assert!(
        children.iter().any(|c| c.info.p2_puzzle_hash == stream_buyer),
        "continuation must be wrapped as STREAM<buyer>"
    );
    assert!(
        !children.iter().any(|c| c.info.p2_puzzle_hash == buyer.puzzle_hash),
        "value must NOT escape as a liquid CAT to the buyer's bare p2"
    );
    Ok(())
}
