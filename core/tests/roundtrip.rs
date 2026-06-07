//! Layout-proving test: run the curried Rue ownership-layer puzzle in CLVM and
//! confirm the emitted conditions match the Rue reference. Validates the curry
//! layout (5 args, owner_hash last), the solution encoding (owner reveal +
//! solution), and the vesting math end-to-end.

use chia_bls::PublicKey;
use chia_protocol::Bytes32;
use chia_puzzle_types::standard::StandardArgs;
use chia_sdk_driver::{SpendContext, StandardLayer, SpendWithConditions};
use chia_sdk_types::{Condition, Conditions};
use clvmr::NodePtr;

use xchannuity_core::info::StreamSolution;
use xchannuity_core::AnnuityInfo;

#[test]
fn claim_midstream_layout_matches_rue() -> anyhow::Result<()> {
    let mut ctx = SpendContext::new();

    // The owner is a standard p2; owner_hash = its curried tree hash.
    let owner_pk = PublicKey::default();
    let recipient: Bytes32 = StandardArgs::curry_tree_hash(owner_pk).into();
    let info = AnnuityInfo::new(recipient, None, 2000, 1000);

    // CLAIM solution: reveal the owner p2 spent with empty conditions (emits only
    // its AGG_SIG; the layer strips any CREATE_COIN it would emit).
    let owner_spend = StandardLayer::new(owner_pk).spend_with_conditions(&mut ctx, Conditions::new())?;
    let solution = ctx.alloc(&StreamSolution {
        mode: 0u8, // CLAIM
        my_amount: 100u64,
        payment_time: 1500u64,
        owner_puzzle: owner_spend.puzzle,
        owner_solution: owner_spend.solution,
    })?;

    let puzzle = info.construct_puzzle(&mut ctx)?;
    let output = ctx.run(puzzle, solution)?;
    let conditions = ctx.extract::<Vec<Condition<NodePtr>>>(output)?;

    let mut saw_amount = false;
    let mut saw_time = false;
    let mut saw_auth = false;
    let mut payout: Option<u64> = None;
    let mut continuation: Option<(Bytes32, u64)> = None;

    for c in conditions {
        match c {
            Condition::AssertMyAmount(a) => {
                assert_eq!(a.amount, 100);
                saw_amount = true;
            }
            Condition::AssertSecondsAbsolute(a) => {
                assert_eq!(a.seconds, 1500);
                saw_time = true;
            }
            Condition::CreateCoin(cc) => {
                if cc.puzzle_hash == recipient {
                    payout = Some(cc.amount);
                } else {
                    continuation = Some((cc.puzzle_hash, cc.amount));
                }
            }
            // The owner's authorization surfaces as an AGG_SIG (any standard
            // variant), proving the owner reveal was run.
            Condition::AggSigMe(_)
            | Condition::AggSigUnsafe(_)
            | Condition::AggSigParent(_)
            | Condition::AggSigPuzzle(_)
            | Condition::AggSigAmount(_)
            | Condition::AggSigPuzzleAmount(_)
            | Condition::AggSigParentAmount(_)
            | Condition::AggSigParentPuzzle(_) => {
                saw_auth = true;
            }
            _ => {}
        }
    }

    assert!(saw_amount, "missing ASSERT_MY_AMOUNT");
    assert!(saw_time, "missing ASSERT_SECONDS_ABSOLUTE");
    assert!(saw_auth, "owner reveal must emit an authorizing AGG_SIG");
    assert_eq!(payout, Some(50), "recipient should receive half-vested 50");

    let expected_cont: Bytes32 = info.after_claim(1500).inner_puzzle_hash().into();
    assert_eq!(
        continuation,
        Some((expected_cont, 50)),
        "continuation recreated under advanced last_payment_time, holding the remainder"
    );
    Ok(())
}
