//! End-to-end builder tests on the simulator: the unsigned bundles produced by
//! `build_create` / `build_claim` / `build_transfer` are signed and pushed, and
//! must be accepted. Also checks the denomination allow-list guard and the
//! park/take offer flow.

use chia_protocol::{Bytes32, Coin, SpendBundle};
use chia_puzzle_types::cat::CatArgs;
use chia_puzzle_types::{LineageProof, Memos};
use chia_puzzles::SETTLEMENT_PAYMENT_HASH;
use chia_sdk_driver::{decode_offer, encode_offer, Cat, SpendContext, StandardLayer};
use chia_sdk_test::Simulator;
use chia_sdk_types::Conditions;

use xchannuity_core::composition::discovery::child_from_parent_spend;
use xchannuity_core::composition::spend::{
    build_claim, build_create, build_create_inner, build_open_offer, build_take_offer,
    build_transfer, take_from_offer,
};
use xchannuity_core::layers::stream::StreamLayer;
use xchannuity_core::Error;

#[test]
fn create_guard_rejects_unsupported_asset() {
    let mut ctx = SpendContext::new();
    let unsupported = Bytes32::new([9u8; 32]);
    let r = build_create(
        &mut ctx,
        unsupported,
        vec![],
        Bytes32::default(),
        None,
        2000,
        1000,
        100,
    );
    assert!(matches!(r, Err(Error::UnsupportedAsset(_))), "non-allow-listed asset must be rejected");
}

#[test]
fn create_then_claim_then_transfer_through_builders() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let creator = sim.bls(100_000);
    let owner = sim.bls(0);
    let buyer = sim.bls(0);

    let start = 1000u64;
    let end = 2000u64;
    let principal = 100_000u64;

    // Mint a CAT owned by the creator (their funding for the annuity).
    let (issue, cats) = Cat::issue_with_coin(
        ctx,
        creator.coin.coin_id(),
        principal,
        Conditions::new().create_coin(creator.puzzle_hash, principal, Memos::None),
    )?;
    StandardLayer::new(creator.pk).spend(ctx, creator.coin, issue)?;
    sim.spend_coins(ctx.take(), &[creator.sk.clone()])?;
    let funding = cats[0];
    let asset_id = funding.info.asset_id;

    // CREATE the annuity (recipient = owner).
    let bundle = build_create_inner(
        ctx, asset_id, vec![(funding, creator.pk)], owner.puzzle_hash, None, end, start, principal, 0,
        None,
    )?;
    let stream_id = bundle.stream_id;
    sim.spend_coins(bundle.coin_spends, &[creator.sk.clone()])?;

    let info = StreamLayer::new(owner.puzzle_hash, None, end, start);
    let inner_ph: Bytes32 = info.inner_puzzle_hash().into();
    let fee = principal * 50 / 10_000;
    let annuity_amount = principal - fee;
    let annuity_ph: Bytes32 = CatArgs::curry_tree_hash(asset_id, info.inner_puzzle_hash()).into();
    let annuity_coin = Coin::new(funding.coin.coin_id(), annuity_ph, annuity_amount);
    assert_eq!(annuity_coin.coin_id(), stream_id, "stream id = created annuity coin id");

    let lineage = LineageProof {
        parent_parent_coin_info: funding.coin.parent_coin_info,
        parent_inner_puzzle_hash: funding.info.p2_puzzle_hash,
        parent_amount: funding.coin.amount,
    };

    // CLAIM at mid-term via the builder (owner authorizes by revealing its p2).
    sim.set_next_timestamp(1500)?;
    let claim_bundle = build_claim(ctx, &info, annuity_coin, lineage, asset_id, owner.pk, 1500)?;
    sim.spend_coins(claim_bundle.coin_spends, &[owner.sk.clone()])?;

    // Reconstruct the continuation, then TRANSFER it to the buyer via the builder.
    let vested = annuity_amount * 500 / 1000;
    let remainder = annuity_amount - vested;
    let info2 = info.after_claim(1500);
    let cont_ph: Bytes32 = CatArgs::curry_tree_hash(asset_id, info2.inner_puzzle_hash()).into();
    let cont_coin = Coin::new(annuity_coin.coin_id(), cont_ph, remainder);
    let lineage2 = LineageProof {
        parent_parent_coin_info: annuity_coin.parent_coin_info,
        parent_inner_puzzle_hash: inner_ph,
        parent_amount: annuity_coin.amount,
    };

    let transfer_bundle =
        build_transfer(ctx, &info2, cont_coin, lineage2, asset_id, owner.pk, buyer.puzzle_hash)?;
    sim.spend_coins(transfer_bundle.coin_spends, &[owner.sk.clone()])?;

    Ok(())
}

#[test]
fn create_funding_split_across_two_keys() -> anyhow::Result<()> {
    // The principal is sourced from TWO funding coins controlled by DIFFERENT
    // wallet keys. The lead coin emits the create outputs; the second binds via
    // ASSERT_CONCURRENT_SPEND and is spent with its OWN StandardLayer.
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    // Two distinct keys; one issues the CAT and splits it across both p2 hashes.
    let key_a = sim.bls(100_000);
    let key_b = sim.bls(0);
    let owner = sim.bls(0);

    let start = 1000u64;
    let end = 2000u64;
    let part_a = 40_000u64;
    let part_b = 60_000u64;
    let principal = part_a + part_b; // 100_000, fully sourced across both keys

    // Issue a single CAT and split it: part_a → key_a, part_b → key_b.
    let (issue, cats) = Cat::issue_with_coin(
        ctx,
        key_a.coin.coin_id(),
        principal,
        Conditions::new()
            .create_coin(key_a.puzzle_hash, part_a, Memos::None)
            .create_coin(key_b.puzzle_hash, part_b, Memos::None),
    )?;
    StandardLayer::new(key_a.pk).spend(ctx, key_a.coin, issue)?;
    sim.spend_coins(ctx.take(), &[key_a.sk.clone()])?;

    let asset_id = cats[0].info.asset_id;
    let coin_a = cats
        .iter()
        .copied()
        .find(|c| c.info.p2_puzzle_hash == key_a.puzzle_hash)
        .expect("key_a funding coin");
    let coin_b = cats
        .iter()
        .copied()
        .find(|c| c.info.p2_puzzle_hash == key_b.puzzle_hash)
        .expect("key_b funding coin");
    assert_eq!(coin_a.coin.amount, part_a);
    assert_eq!(coin_b.coin.amount, part_b);

    // CREATE the annuity from BOTH coins (each with its own controlling key).
    let bundle = build_create_inner(
        ctx,
        asset_id,
        vec![(coin_a, key_a.pk), (coin_b, key_b.pk)],
        owner.puzzle_hash,
        None,
        end,
        start,
        principal,
        0,
        None,
    )?;
    let stream_id = bundle.stream_id;
    // Must be accepted with BOTH keys' signatures.
    sim.spend_coins(bundle.coin_spends, &[key_a.sk.clone(), key_b.sk.clone()])?;

    // The annuity coin (lead = coin_a) exists with the full principal less fee.
    let info = StreamLayer::new(owner.puzzle_hash, None, end, start);
    let fee = principal * 50 / 10_000;
    let annuity_amount = principal - fee;
    let annuity_ph: Bytes32 = CatArgs::curry_tree_hash(asset_id, info.inner_puzzle_hash()).into();
    let annuity_coin = Coin::new(coin_a.coin.coin_id(), annuity_ph, annuity_amount);
    assert_eq!(annuity_coin.coin_id(), stream_id, "stream id = created annuity coin id");
    assert!(
        sim.coin_state(annuity_coin.coin_id()).is_some(),
        "annuity funded from two keys must be created"
    );
    Ok(())
}

#[test]
fn discover_from_create_then_from_claim() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let creator = sim.bls(100_000);
    let owner = sim.bls(0);
    let start = 1000u64;
    let end = 2000u64;
    let principal = 100_000u64;
    let fee = principal * 50 / 10_000;
    let annuity_amount = principal - fee;

    let (issue, cats) = Cat::issue_with_coin(
        ctx,
        creator.coin.coin_id(),
        principal,
        Conditions::new().create_coin(creator.puzzle_hash, principal, Memos::None),
    )?;
    StandardLayer::new(creator.pk).spend(ctx, creator.coin, issue)?;
    sim.spend_coins(ctx.take(), &[creator.sk.clone()])?;
    let funding = cats[0];
    let asset_id = funding.info.asset_id;

    let bundle = build_create_inner(
        ctx, asset_id, vec![(funding, creator.pk)], owner.puzzle_hash, None, end, start, principal, 0,
        None,
    )?;
    let stream_id = bundle.stream_id;
    let create_spends = bundle.coin_spends.clone();
    sim.spend_coins(bundle.coin_spends, &[creator.sk.clone()])?;

    // DISCOVER from the funding coin's spend (Case B: launch-hint memos)
    let create_cs = create_spends.iter().find(|cs| cs.coin == funding.coin).expect("funding spend");
    let mut d_ctx = SpendContext::new();
    let pr = d_ctx.alloc(&create_cs.puzzle_reveal)?;
    let sol = d_ctx.alloc(&create_cs.solution)?;
    let d = child_from_parent_spend(&mut d_ctx, funding.coin, pr, sol)?.expect("discover from create");
    assert_eq!(d.info.recipient, owner.puzzle_hash);
    assert_eq!(d.info.end_time, end);
    assert_eq!(d.info.last_payment_time, start);
    assert_eq!(d.coin.coin_id(), stream_id);
    assert_eq!(d.coin.amount, annuity_amount);

    // CLAIM mid-term, then DISCOVER the continuation (Case A: parent is the annuity)
    let info = StreamLayer::new(owner.puzzle_hash, None, end, start);
    sim.set_next_timestamp(1500)?;
    let claim = build_claim(ctx, &info, d.coin, d.lineage_proof, asset_id, owner.pk, 1500)?;
    let claim_spends = claim.coin_spends.clone();
    sim.spend_coins(claim.coin_spends, &[owner.sk.clone()])?;

    let claim_cs = claim_spends.iter().find(|cs| cs.coin == d.coin).expect("annuity spend");
    let mut d2 = SpendContext::new();
    let pr2 = d2.alloc(&claim_cs.puzzle_reveal)?;
    let sol2 = d2.alloc(&claim_cs.solution)?;
    let cont = child_from_parent_spend(&mut d2, d.coin, pr2, sol2)?.expect("discover continuation");
    assert_eq!(cont.info.recipient, owner.puzzle_hash);
    assert_eq!(cont.info.last_payment_time, 1500);
    let vested = annuity_amount * 500 / 1000;
    assert_eq!(cont.coin.amount, annuity_amount - vested);
    Ok(())
}

#[test]
fn transfer_preserves_vesting_no_early_access() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let creator = sim.bls(100_000);
    let owner = sim.bls(0);
    let buyer = sim.bls(0);
    let start = 1000u64;
    let end = 2000u64;
    let principal = 100_000u64;
    let net = principal - principal * 50 / 10_000; // after 0.5% fee = 99_500

    let (issue, cats) = Cat::issue_with_coin(
        ctx,
        creator.coin.coin_id(),
        principal,
        Conditions::new().create_coin(creator.puzzle_hash, principal, Memos::None),
    )?;
    StandardLayer::new(creator.pk).spend(ctx, creator.coin, issue)?;
    sim.spend_coins(ctx.take(), &[creator.sk.clone()])?;
    let funding = cats[0];
    let asset_id = funding.info.asset_id;

    let bundle = build_create_inner(
        ctx, asset_id, vec![(funding, creator.pk)], owner.puzzle_hash, None, end, start, principal, 0, None,
    )?;
    let create_spends = bundle.coin_spends.clone();
    sim.spend_coins(bundle.coin_spends, &[creator.sk.clone()])?;

    let cs = create_spends.iter().find(|c| c.coin == funding.coin).unwrap();
    let mut d0 = SpendContext::new();
    let (pr, sol) = (d0.alloc(&cs.puzzle_reveal)?, d0.alloc(&cs.solution)?);
    let eve = child_from_parent_spend(&mut d0, funding.coin, pr, sol)?.unwrap();

    // owner claims at 1500 → vested 49_750, remaining 49_750, last advances to 1500
    let info0 = StreamLayer::new(owner.puzzle_hash, None, end, start);
    sim.set_next_timestamp(1500)?;
    let claim = build_claim(ctx, &info0, eve.coin, eve.lineage_proof, asset_id, owner.pk, 1500)?;
    let claim_spends = claim.coin_spends.clone();
    sim.spend_coins(claim.coin_spends, &[owner.sk.clone()])?;

    let ccs = claim_spends.iter().find(|c| c.coin == eve.coin).unwrap();
    let mut d1 = SpendContext::new();
    let (pr1, sol1) = (d1.alloc(&ccs.puzzle_reveal)?, d1.alloc(&ccs.solution)?);
    let cont = child_from_parent_spend(&mut d1, eve.coin, pr1, sol1)?.unwrap();
    let vested0 = net * 500 / 1000; // 49_750
    assert_eq!(cont.coin.amount, net - vested0);
    assert_eq!(cont.info.last_payment_time, 1500);

    // owner transfers the continuation to the buyer
    let info1 = StreamLayer::new(owner.puzzle_hash, None, end, 1500);
    let xfer = build_transfer(ctx, &info1, cont.coin, cont.lineage_proof, asset_id, owner.pk, buyer.puzzle_hash)?;
    let xfer_spends = xfer.coin_spends.clone();
    sim.spend_coins(xfer.coin_spends, &[owner.sk.clone()])?;

    let xcs = xfer_spends.iter().find(|c| c.coin == cont.coin).unwrap();
    let mut d2 = SpendContext::new();
    let (pr2, sol2) = (d2.alloc(&xcs.puzzle_reveal)?, d2.alloc(&xcs.solution)?);
    let xfered = child_from_parent_spend(&mut d2, cont.coin, pr2, sol2)?.unwrap();
    assert_eq!(xfered.info.recipient, buyer.puzzle_hash);
    assert_eq!(xfered.info.last_payment_time, 1500, "transfer must PRESERVE last_payment_time");
    assert_eq!(xfered.coin.amount, net - vested0, "transfer must PRESERVE the reduced amount (no reset)");

    // EARLY-ACCESS ATTEMPT: buyer tries to claim as-of END while the chain is ~1500 → must fail.
    let info_buyer = StreamLayer::new(buyer.puzzle_hash, None, end, 1500);
    let attempt: anyhow::Result<()> = (|| {
        let b = build_claim(ctx, &info_buyer, xfered.coin, xfered.lineage_proof, asset_id, buyer.pk, end)?;
        sim.spend_coins(b.coin_spends, &[buyer.sk.clone()])?;
        Ok(())
    })();
    assert!(attempt.is_err(), "buyer must NOT claim the full remaining early");

    // VALID buyer claim at 1750 → only vested-since-transfer (of the remaining)
    sim.set_next_timestamp(1750)?;
    let b2 = build_claim(ctx, &info_buyer, xfered.coin, xfered.lineage_proof, asset_id, buyer.pk, 1750)?;
    let b2_spends = b2.coin_spends.clone();
    sim.spend_coins(b2.coin_spends, &[buyer.sk.clone()])?;

    let b2cs = b2_spends.iter().find(|c| c.coin == xfered.coin).unwrap();
    let mut d3 = SpendContext::new();
    let (pr3, sol3) = (d3.alloc(&b2cs.puzzle_reveal)?, d3.alloc(&b2cs.solution)?);
    let bcont = child_from_parent_spend(&mut d3, xfered.coin, pr3, sol3)?.unwrap();
    let buyer_vested = (net - vested0) * 250 / 500; // 24_875
    assert_eq!(
        bcont.coin.amount,
        (net - vested0) - buyer_vested,
        "buyer claims only vested-since-transfer, never the previous owner's claimed funds"
    );
    Ok(())
}

#[test]
fn open_offer_filled_by_arbitrary_taker() -> anyhow::Result<()> {
    // OPEN offer: the maker parks the annuity under the settlement puzzle, naming
    // NO buyer — only the XCH terms. An arbitrary taker fills it, naming
    // THEMSELVES the new owner. Proves the taker becomes owner (as STREAM<taker>,
    // vesting preserved) and the maker is paid the requested XCH.
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let creator = sim.bls(100_000);
    let owner = sim.bls(0); // maker = current annuity recipient
    let taker = sim.bls(50); // arbitrary filler — NOT referenced when the offer is made
    let start = 1000u64;
    let end = 2000u64;
    let principal = 100_000u64;
    let net = principal - principal * 50 / 10_000;
    let xch_price = 9u64;

    let (issue, cats) = Cat::issue_with_coin(
        ctx,
        creator.coin.coin_id(),
        principal,
        Conditions::new().create_coin(creator.puzzle_hash, principal, Memos::None),
    )?;
    StandardLayer::new(creator.pk).spend(ctx, creator.coin, issue)?;
    sim.spend_coins(ctx.take(), &[creator.sk.clone()])?;
    let funding = cats[0];
    let asset_id = funding.info.asset_id;

    let bundle = build_create_inner(
        ctx, asset_id, vec![(funding, creator.pk)], owner.puzzle_hash, None, end, start, principal, 0,
        None,
    )?;
    let create_spends = bundle.coin_spends.clone();
    sim.spend_coins(bundle.coin_spends, &[creator.sk.clone()])?;

    let cs = create_spends.iter().find(|c| c.coin == funding.coin).unwrap();
    let mut d0 = SpendContext::new();
    let (pr, sol) = (d0.alloc(&cs.puzzle_reveal)?, d0.alloc(&cs.solution)?);
    let eve = child_from_parent_spend(&mut d0, funding.coin, pr, sol)?.unwrap();
    assert_eq!(eve.coin.amount, net);
    let info = StreamLayer::new(owner.puzzle_hash, None, end, start);

    // MAKER: build the open offer — the maker's p2 parks the annuity under the
    // settlement puzzle, gated on `xch_price` to the owner. (Maker signs.)
    let offer = build_open_offer(
        ctx,
        &info,
        eve.coin,
        eve.lineage_proof,
        asset_id,
        owner.pk,
        owner.puzzle_hash,
        xch_price,
    )?;
    // Only the REAL maker spend (the park) is pushed on chain; the requested-
    // payment skeleton (null-parent coin) lives only inside the offer encoding.
    let maker_spends: Vec<_> = offer
        .coin_spends
        .iter()
        .filter(|c| c.coin.parent_coin_info != Bytes32::default())
        .cloned()
        .collect();

    // The generated offer file is a real, round-trippable `offer1…` string.
    let draft_bundle = SpendBundle::new(offer.coin_spends.clone(), chia_bls::Signature::default());
    let encoded = encode_offer(&draft_bundle)?;
    assert!(encoded.starts_with("offer1"), "offer encodes to a standard offer1 string");
    let decoded = decode_offer(&encoded)?;
    assert_eq!(decoded.coin_spends, draft_bundle.coin_spends, "offer1 round-trips the maker spends");

    // The parked coin: CAT<STREAM<SETTLEMENT>>, parent = eve, amount = net.
    let settle_ph = Bytes32::from(SETTLEMENT_PAYMENT_HASH);
    let parked_info = StreamLayer::new(settle_ph, None, end, start);
    let parked_ph: Bytes32 = CatArgs::curry_tree_hash(asset_id, parked_info.inner_puzzle_hash()).into();
    let parked_coin = Coin::new(eve.coin.coin_id(), parked_ph, net);
    let parked_lineage = LineageProof {
        parent_parent_coin_info: eve.coin.parent_coin_info,
        parent_inner_puzzle_hash: info.inner_puzzle_hash().into(),
        parent_amount: eve.coin.amount,
    };

    // TAKER: fill it, naming THEMSELVES the new owner.
    let take = build_take_offer(
        ctx,
        &info,
        parked_coin,
        parked_lineage,
        asset_id,
        taker.puzzle_hash, // taker chooses themselves at fill time
        owner.puzzle_hash,
        xch_price,
        taker.coin,
        taker.pk,
    )?;

    let mut all = maker_spends;
    all.extend(take.coin_spends);
    sim.spend_coins(all, &[owner.sk.clone(), taker.sk.clone()])?;

    // The TAKER now owns the annuity (as STREAM<taker>, full amount preserved).
    let taker_info = info.after_transfer(taker.puzzle_hash);
    let taker_ph: Bytes32 = CatArgs::curry_tree_hash(asset_id, taker_info.inner_puzzle_hash()).into();
    let taker_coin = Coin::new(parked_coin.coin_id(), taker_ph, net);
    assert!(
        sim.coin_state(taker_coin.coin_id()).is_some(),
        "arbitrary taker must become the new owner"
    );

    // The maker was paid the XCH.
    let settle_xch_coin = Coin::new(taker.coin.coin_id(), settle_ph, xch_price);
    let pay_coin = Coin::new(settle_xch_coin.coin_id(), owner.puzzle_hash, xch_price);
    assert!(
        sim.coin_state(pay_coin.coin_id()).is_some(),
        "maker must receive the requested XCH"
    );
    Ok(())
}

#[test]
fn offer1_round_trips_and_fills() -> anyhow::Result<()> {
    // FULL self-describing offer1: the maker's `build_open_offer` produces a
    // COMPLETE offer bundle (park spend + the standard requested-payment
    // settlement skeleton). It is encoded to a real `offer1…` string, and the
    // taker reconstructs the ENTIRE trade by DECODING that string alone — no side
    // information about the XCH terms, the parked coin, or its lineage proof.
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let creator = sim.bls(100_000);
    let owner = sim.bls(0); // maker = current annuity recipient
    let taker = sim.bls(50); // arbitrary filler, chosen only at fill time
    let start = 1000u64;
    let end = 2000u64;
    let principal = 100_000u64;
    let net = principal - principal * 50 / 10_000;
    let xch_price = 9u64;

    // Mint the funding CAT and create the annuity (recipient = maker).
    let (issue, cats) = Cat::issue_with_coin(
        ctx,
        creator.coin.coin_id(),
        principal,
        Conditions::new().create_coin(creator.puzzle_hash, principal, Memos::None),
    )?;
    StandardLayer::new(creator.pk).spend(ctx, creator.coin, issue)?;
    sim.spend_coins(ctx.take(), &[creator.sk.clone()])?;
    let funding = cats[0];
    let asset_id = funding.info.asset_id;

    let bundle = build_create_inner(
        ctx, asset_id, vec![(funding, creator.pk)], owner.puzzle_hash, None, end, start, principal, 0,
        None,
    )?;
    let create_spends = bundle.coin_spends.clone();
    sim.spend_coins(bundle.coin_spends, &[creator.sk.clone()])?;

    let cs = create_spends.iter().find(|c| c.coin == funding.coin).unwrap();
    let mut d0 = SpendContext::new();
    let (pr, sol) = (d0.alloc(&cs.puzzle_reveal)?, d0.alloc(&cs.solution)?);
    let eve = child_from_parent_spend(&mut d0, funding.coin, pr, sol)?.unwrap();
    assert_eq!(eve.coin.amount, net);
    let info = StreamLayer::new(owner.puzzle_hash, None, end, start);

    // MAKER: build the complete open offer, encode it to an offer1 string.
    let offer = build_open_offer(
        ctx,
        &info,
        eve.coin,
        eve.lineage_proof,
        asset_id,
        owner.pk,
        owner.puzzle_hash,
        xch_price,
    )?;
    // The bundle now carries BOTH the park spend AND the requested-payment skeleton.
    assert_eq!(
        offer.coin_spends.len(),
        2,
        "complete offer = park spend + requested-payment skeleton"
    );

    // Encode to a standard offer1 string. (Sage supplies the maker's partial
    // signature in production; for the round-trip we only need the coin spends,
    // and the simulator re-signs on push below.)
    let full_bundle = SpendBundle::new(offer.coin_spends.clone(), chia_bls::Signature::default());
    let offer1 = encode_offer(&full_bundle)?;
    assert!(offer1.starts_with("offer1"), "produces a standard offer1 string");

    // TAKER: reconstruct the whole trade by DECODING offer1 alone. This exercises
    // the exact path `build_take_from_offer` uses.
    let take = take_from_offer(ctx, &offer1, taker.puzzle_hash, taker.coin, taker.pk)?;

    // Combine the maker's park spend (recovered by decoding) + taker spends and push.
    let decoded = decode_offer(&offer1)?;
    let mut all: Vec<_> = decoded
        .coin_spends
        .into_iter()
        .filter(|c| c.coin.parent_coin_info != Bytes32::default())
        .collect();
    all.extend(take.coin_spends);
    sim.spend_coins(all, &[owner.sk.clone(), taker.sk.clone()])?;

    // The TAKER now owns the annuity (STREAM<taker>), full amount, vesting preserved.
    let parked_coin = Coin::new(
        eve.coin.coin_id(),
        CatArgs::curry_tree_hash(
            asset_id,
            StreamLayer::new(Bytes32::from(SETTLEMENT_PAYMENT_HASH), None, end, start)
                .inner_puzzle_hash(),
        )
        .into(),
        net,
    );
    let taker_info = info.after_transfer(taker.puzzle_hash);
    assert_eq!(taker_info.end_time, end, "end_time preserved");
    assert_eq!(taker_info.last_payment_time, start, "last_payment_time preserved");
    let taker_ph: Bytes32 = CatArgs::curry_tree_hash(asset_id, taker_info.inner_puzzle_hash()).into();
    let taker_coin = Coin::new(parked_coin.coin_id(), taker_ph, net);
    assert!(
        sim.coin_state(taker_coin.coin_id()).is_some(),
        "taker owns CAT<STREAM<taker>> with the full parked amount"
    );

    // The maker received the requested XCH.
    let settle_ph = Bytes32::from(SETTLEMENT_PAYMENT_HASH);
    let settle_xch_coin = Coin::new(taker.coin.coin_id(), settle_ph, xch_price);
    let pay_coin = Coin::new(settle_xch_coin.coin_id(), owner.puzzle_hash, xch_price);
    assert!(
        sim.coin_state(pay_coin.coin_id()).is_some(),
        "maker received the requested XCH"
    );
    Ok(())
}
