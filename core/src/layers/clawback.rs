//! Clawback authorization layer (CUSTOM). The issuer terminates an annuity by
//! sending a mode-23 message bound to sha256(CLAWBACK_TAG ++ my_amount ++ pt) and,
//! via RECEIVER_COIN, to the exact coin. This module owns the message format and
//! the issuer-coin spend that emits it.

use chia_bls::PublicKey;
use chia_protocol::{Bytes, Bytes32, Coin};
use chia_puzzle_types::Memos;
use chia_sdk_driver::{DriverError, SpendContext, StandardLayer};
use chia_sdk_types::Conditions;
use clvmr::NodePtr;

use crate::constants::{MODE_CLAWBACK, STREAM_MSG_MODE};
use crate::layers::stream::StreamSolution;

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

/// Build a CLAWBACK stream solution: the owner is NOT run (reveal is nil); the
/// issuer authorizes separately via `authorize_message`. This is the stream-side
/// half of the clawback flow — kept here alongside the issuer message it pairs with.
pub fn clawback_solution(my_amount: u64, payment_time: u64) -> StreamSolution<NodePtr, NodePtr> {
    StreamSolution {
        mode: MODE_CLAWBACK,
        my_amount,
        payment_time,
        owner_puzzle: NodePtr::NIL,
        owner_solution: NodePtr::NIL,
    }
}
