//! Spend helpers shared by the driver and the test suite.
//!
//! Ownership model: the stream layer is curried with the OWNER's puzzle HASH and
//! RUNS a REVEALED owner inner puzzle (the beneficiary's standard p2) for
//! authorization. CLAIM/TRANSFER therefore carry the owner's signature inside the
//! revealed p2 spend (no separate message coin). CLAWBACK is the exception: the
//! issuer authorizes via a mode-23 message and the owner reveal is nil.

use chia_bls::PublicKey;
use chia_protocol::{Bytes, Bytes32, Coin};
use chia_puzzle_types::Memos;
use chia_sdk_driver::{DriverError, Spend, SpendContext, StandardLayer, SpendWithConditions};
use chia_sdk_types::Conditions;
use clvmr::NodePtr;

use crate::constants::STREAM_MSG_MODE;
use crate::info::{AnnuityInfo, StreamSolution};

/// CLVM-canonical big-endian encoding of a u64, matching Rue's `x as Bytes`
/// (and the encoding the SDK's own streaming primitive uses).
pub fn u64_to_atom(v: u64) -> Bytes {
    Bytes::new(chia_consensus::make_aggsig_final_message::u64_to_bytes(v))
}

/// Domain tag mixed into the clawback authorization message. MUST byte-match the
/// Rue `CLAWBACK_TAG` constant in `puzzles/stream.rue`.
pub const CLAWBACK_TAG: &[u8] = b"xchannuity:clawback:v1";

/// The clawback authorization message body: `sha256(CLAWBACK_TAG ++ my_amount ++ pt)`
/// where the integers use the CLVM-canonical atom encoding — byte-identical to the
/// puzzle's `sha256(CLAWBACK_TAG + (my_amount as Bytes) + (pt as Bytes))`. Binds
/// the issuer's mode-23 message to a clawback of this exact amount + time (and,
/// via RECEIVER_COIN, this exact coin), so it can never be replayed for any other
/// purpose.
pub fn clawback_message(my_amount: u64, payment_time: u64) -> Bytes {
    use chia_consensus::make_aggsig_final_message::u64_to_bytes;
    let mut h = chia_sha2::Sha256::new();
    h.update(CLAWBACK_TAG);
    h.update(u64_to_bytes(my_amount));
    h.update(u64_to_bytes(payment_time));
    Bytes::new(h.finalize().to_vec())
}

/// Build the inner annuity spend (curried puzzle + already-allocated solution).
pub fn inner_spend(
    ctx: &mut SpendContext,
    info: &AnnuityInfo,
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

/// Build a CLAWBACK stream solution: the owner is NOT run (reveal is nil); the
/// issuer authorizes separately via `authorize_message`.
pub fn clawback_solution(my_amount: u64, payment_time: u64) -> StreamSolution<NodePtr, NodePtr> {
    StreamSolution {
        mode: crate::constants::MODE_CLAWBACK,
        my_amount,
        payment_time,
        owner_puzzle: NodePtr::NIL,
        owner_solution: NodePtr::NIL,
    }
}

/// Spend an issuer-controlled standard p2 coin to authorize a CLAWBACK, by
/// sending the mode-23 message bound to `target_coin_id`. This is the spend that
/// carries the BLS signature for clawback — the streaming puzzle holds no
/// AGG_SIG of its own in that mode.
pub fn authorize_message(
    ctx: &mut SpendContext,
    signer_pk: PublicKey,
    signer_coin: Coin,
    message: Bytes,
    target_coin_id: Bytes32,
) -> Result<(), DriverError> {
    let coin_id_ptr = ctx.alloc(&target_coin_id)?;
    // Recreate the signer's coin (same puzzle hash + amount) so its value is NOT
    // burned — the spend only exists to emit the authorizing message.
    let conditions = Conditions::new()
        .send_message(STREAM_MSG_MODE, message, vec![coin_id_ptr])
        .create_coin(signer_coin.puzzle_hash, signer_coin.amount, Memos::None);
    StandardLayer::new(signer_pk).spend(ctx, signer_coin, conditions)
}
