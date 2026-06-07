//! `AnnuityInfo` mirrors the curried state of the Rue ownership-layer `stream`
//! puzzle and computes the same puzzle hashes it does, so the driver and puzzle
//! agree byte-for-byte.
//!
//! Curry layout (5 separate args, in order):
//!   `(mod_hash, clawback_ph, end_time, last_payment_time, owner_hash)`
//! where `owner_hash` is the HASH of the inner ownership puzzle (the beneficiary's
//! p2 — or `SETTLEMENT_PAYMENT_HASH` while offered). The owner puzzle reveal is
//! supplied in the SOLUTION, not curried, so an annuity is sendable to any
//! address.
//!
//! Solution layout (proper list):
//!   `(mode, my_amount, payment_time, owner_puzzle, owner_solution)`
//! `owner_puzzle`/`owner_solution` are the revealed inner puzzle + its solution
//! (nil for CLAWBACK, which is issuer-message-authorized and never runs the owner).

use chia_protocol::{Bytes, Bytes32};
use chia_sdk_driver::{DriverError, SpendContext};
use clvm_traits::{FromClvm, ToClvm};
use clvm_utils::{CurriedProgram, ToTreeHash, TreeHash};
use clvmr::NodePtr;

use crate::constants::{stream_mod_hash, stream_mod_tree_hash, stream_puzzle_bytes};

/// The 5 curried arguments of the stream layer, in puzzle order.
/// `#[clvm(curry)]` curries each field as a separate argument.
#[derive(Debug, Clone, PartialEq, Eq, ToClvm, FromClvm)]
#[clvm(curry)]
pub struct StreamCurry {
    pub mod_hash: Bytes32,
    pub clawback_ph: Option<Bytes32>,
    pub end_time: u64,
    pub last_payment_time: u64,
    /// Hash of the inner ownership puzzle (the beneficiary's p2 puzzle hash, i.e.
    /// their address; or `SETTLEMENT_PAYMENT_HASH` while the annuity is offered).
    pub owner_hash: Bytes32,
}

/// The solution after the 5 args are curried. Generic over the revealed owner
/// puzzle `P` and its solution `S` (both `NodePtr` when building/parsing in-ctx).
#[derive(Debug, Clone, PartialEq, Eq, ToClvm, FromClvm)]
#[clvm(list)]
pub struct StreamSolution<P, S> {
    pub mode: u8,
    pub my_amount: u64,
    pub payment_time: u64,
    /// Revealed inner ownership puzzle (CLAIM/TRANSFER); nil for CLAWBACK.
    pub owner_puzzle: P,
    /// Solution to the revealed inner puzzle; nil for CLAWBACK.
    pub owner_solution: S,
}

/// High-level annuity parameters (the curried state minus the constant mod hash).
/// `recipient` is the OWNER's puzzle hash (their address / p2 hash) = `owner_hash`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnnuityInfo {
    pub recipient: Bytes32,
    pub clawback_ph: Option<Bytes32>,
    pub end_time: u64,
    pub last_payment_time: u64,
}

impl AnnuityInfo {
    pub fn new(
        recipient: Bytes32,
        clawback_ph: Option<Bytes32>,
        end_time: u64,
        last_payment_time: u64,
    ) -> Self {
        Self { recipient, clawback_ph, end_time, last_payment_time }
    }

    pub fn from_curry(c: &StreamCurry) -> Self {
        Self {
            recipient: c.owner_hash,
            clawback_ph: c.clawback_ph,
            end_time: c.end_time,
            last_payment_time: c.last_payment_time,
        }
    }

    /// Memos emitted on the create CreateCoin so the coin is hinted to the owner
    /// (first memo) AND its params are recoverable on discovery.
    /// Layout: [owner_hash, clawback_ph_or_empty, last_payment_time, end_time].
    pub fn launch_hints(&self) -> Vec<Bytes> {
        let recipient: Bytes = self.recipient.into();
        let clawback: Bytes = match self.clawback_ph {
            Some(c) => c.into(),
            None => Bytes::new(vec![]),
        };
        vec![
            recipient,
            clawback,
            crate::spend::u64_to_atom(self.last_payment_time),
            crate::spend::u64_to_atom(self.end_time),
        ]
    }

    pub fn to_curry(&self) -> StreamCurry {
        StreamCurry {
            mod_hash: stream_mod_hash(),
            clawback_ph: self.clawback_ph,
            end_time: self.end_time,
            last_payment_time: self.last_payment_time,
            owner_hash: self.recipient,
        }
    }

    /// Inner (pre-CAT) puzzle hash:
    /// `curry_tree_hash(mod_hash, [th(mod_hash), th(clawback), th(end), th(last), th(owner_hash)])`.
    pub fn inner_puzzle_hash(&self) -> TreeHash {
        CurriedProgram {
            program: stream_mod_tree_hash(),
            args: self.to_curry(),
        }
        .tree_hash()
    }

    /// Allocate the curried inner puzzle into the context.
    pub fn construct_puzzle(&self, ctx: &mut SpendContext) -> Result<NodePtr, DriverError> {
        let mod_ptr = ctx.puzzle(stream_mod_tree_hash(), &stream_puzzle_bytes())?;
        ctx.alloc(&CurriedProgram { program: mod_ptr, args: self.to_curry() })
    }

    /// Clamp a caller time into `[last_payment_time, end_time]` — mirrors `clamp_time`.
    pub fn clamp_time(&self, payment_time: u64) -> u64 {
        payment_time.clamp(self.last_payment_time, self.end_time)
    }

    /// Vested amount due at a (raw) caller time, using the clamped time. Floor
    /// division — matches the puzzle exactly. The puzzle computes this in
    /// arbitrary-precision CLVM, so we use a u128 intermediate to avoid a u64
    /// overflow on `my_amount * (pt - last)` for large annuities (which would
    /// make the driver disagree with on-chain and break discovery). The result
    /// is `<= my_amount`, so the final cast back to u64 is lossless.
    pub fn claimable(&self, my_amount: u64, payment_time: u64) -> u64 {
        // Guard the degenerate window (mirrors the JS `claimableMojos`): a coin
        // with end <= last can't arise via `build_create` (end>start enforced) or
        // any continuation, but the public `claimable_now` wasm export is callable
        // with arbitrary values — return 0 rather than dividing by zero (panic).
        if self.end_time <= self.last_payment_time {
            return 0;
        }
        let pt = self.clamp_time(payment_time);
        let num = (my_amount as u128) * u128::from(pt - self.last_payment_time);
        (num / u128::from(self.end_time - self.last_payment_time)) as u64
    }

    /// The continuation after a claim at clamped time `pt`.
    pub fn after_claim(&self, pt: u64) -> Self {
        Self { last_payment_time: pt, ..*self }
    }

    /// The continuation after a transfer to `new_recipient` (owner hash).
    pub fn after_transfer(&self, new_recipient: Bytes32) -> Self {
        Self { recipient: new_recipient, ..*self }
    }
}
