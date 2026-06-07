//! Owner-authorization layer (AUDITED inner puzzles). The annuity curries the
//! owner's puzzle HASH; the owner is REVEALED in the stream solution and run for
//! authorization. CLAIM/TRANSFER reveal the owner's standard p2 (SDK
//! `StandardLayer`) or, for offers, the settlement puzzle; these constructors
//! build the owner-authorized `StreamSolution` for each kind. `inner_spend` is the
//! shared helper that pairs a `StreamLayer` puzzle with its `StreamSolution` into a
//! ready `Spend`. (The CLAWBACK solution, which runs no owner, lives in
//! `crate::layers::clawback` next to the issuer message it pairs with.)

use chia_bls::PublicKey;
use chia_protocol::Bytes32;
use chia_puzzle_types::Memos;
use chia_sdk_driver::{DriverError, Spend, SpendContext, SpendWithConditions, StandardLayer};
use chia_sdk_types::Conditions;
use clvmr::NodePtr;

use crate::layers::stream::{StreamLayer, StreamSolution};

/// Build the inner annuity spend (curried puzzle + already-allocated solution).
pub fn inner_spend(
    ctx: &mut SpendContext,
    info: &StreamLayer,
    solution: StreamSolution<NodePtr, NodePtr>,
) -> Result<Spend, DriverError> {
    let puzzle = info.construct_puzzle(ctx)?;
    let sol = ctx.alloc(&solution)?;
    Ok(Spend::new(puzzle, sol))
}

/// Build a CLAIM stream solution: the owner's standard p2 is revealed and spent
/// with EMPTY conditions, so it emits only its AGG_SIG (the layer strips any
/// CREATE_COIN). The owner's signature authorizes the claim.
pub fn claim_solution(
    ctx: &mut SpendContext,
    owner_pk: PublicKey,
    my_amount: u64,
    payment_time: u64,
) -> Result<StreamSolution<NodePtr, NodePtr>, DriverError> {
    let owner_spend = StandardLayer::new(owner_pk).spend_with_conditions(ctx, Conditions::new())?;
    Ok(StreamSolution {
        mode: crate::constants::MODE_CLAIM,
        my_amount,
        payment_time,
        owner_puzzle: owner_spend.puzzle,
        owner_solution: owner_spend.solution,
    })
}

/// Build a TRANSFER stream solution: the owner's standard p2 is revealed and
/// directs the WHOLE coin to `new_owner_hash` (the layer re-wraps it as
/// STREAM<new_owner_hash>). `extra` lets callers attach additional owner
/// conditions (e.g. an `assert_puzzle_announcement` for offers).
pub fn transfer_solution(
    ctx: &mut SpendContext,
    owner_pk: PublicKey,
    my_amount: u64,
    new_owner_hash: Bytes32,
    extra: Conditions,
) -> Result<StreamSolution<NodePtr, NodePtr>, DriverError> {
    let memos = Memos::Some(ctx.alloc(&[new_owner_hash])?);
    let conds = extra.create_coin(new_owner_hash, my_amount, memos);
    let owner_spend = StandardLayer::new(owner_pk).spend_with_conditions(ctx, conds)?;
    Ok(StreamSolution {
        mode: crate::constants::MODE_TRANSFER,
        my_amount,
        payment_time: 0,
        owner_puzzle: owner_spend.puzzle,
        owner_solution: owner_spend.solution,
    })
}

/// Build a TRANSFER stream solution whose revealed owner puzzle is an arbitrary
/// pre-built spend (e.g. the settlement-payments puzzle for the taker side of an
/// offer). The revealed puzzle is responsible for emitting the CREATE_COIN that
/// the layer re-wraps.
pub fn transfer_solution_with_owner(
    owner_spend: Spend,
    my_amount: u64,
) -> StreamSolution<NodePtr, NodePtr> {
    StreamSolution {
        mode: crate::constants::MODE_TRANSFER,
        my_amount,
        payment_time: 0,
        owner_puzzle: owner_spend.puzzle,
        owner_solution: owner_spend.solution,
    }
}
