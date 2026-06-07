//! On-chain discovery: given a coin's PARENT spend, reconstruct the annuity it
//! created (or recreated via claim/transfer). Adapted to the ownership-layer Rue
//! puzzle.
//!
//! The dApp walks: getCoinRecordsByHint(recipient) → for each unspent coin,
//! fetch its parent's puzzle+solution → this parser → the live AnnuityInfo
//! (with the current last_payment_time / recipient) + a lineage proof.

use chia_protocol::{Bytes, Bytes32, Coin};
use chia_puzzle_types::cat::CatArgs;
use chia_puzzle_types::{LineageProof, Memos};
use chia_sdk_driver::{CatLayer, HashedPtr, Layer, Puzzle, SpendContext};
use chia_sdk_types::Condition;
use clvmr::op_utils::u64_from_bytes;
use clvmr::NodePtr;

use crate::error::{Error, Result};
use crate::info::AnnuityInfo;
use crate::layers::stream::StreamLayer;

const MODE_CLAIM: u8 = 0;
const MODE_TRANSFER: u8 = 1;

/// A live annuity reconstructed from a parent spend.
#[derive(Debug, Clone)]
pub struct Discovered {
    pub coin: Coin,
    pub asset_id: Bytes32,
    pub info: AnnuityInfo,
    pub lineage_proof: LineageProof,
}

/// Reconstruct AnnuityInfo from launch-hint memos `[recipient, clawback, last, end]`.
fn info_from_memos(memos: &[Bytes]) -> Option<AnnuityInfo> {
    if memos.len() < 4 {
        return None;
    }
    let recipient: Bytes32 = memos[0].as_ref().try_into().ok()?;
    let clawback_ph: Option<Bytes32> = if memos[1].is_empty() {
        None
    } else {
        Some(memos[1].as_ref().try_into().ok()?)
    };
    let last_payment_time = u64_from_bytes(memos[2].as_ref());
    let end_time = u64_from_bytes(memos[3].as_ref());
    Some(AnnuityInfo::new(recipient, clawback_ph, end_time, last_payment_time))
}

pub fn child_from_parent_spend(
    ctx: &mut SpendContext,
    parent_coin: Coin,
    puzzle_reveal: NodePtr,
    solution: NodePtr,
) -> Result<Option<Discovered>> {
    let parent_puzzle = Puzzle::parse(ctx, puzzle_reveal);

    // --- Case A: parent IS a CAT-wrapped annuity (claim/transfer recreated it) ---
    if let Some(cat) = CatLayer::<StreamLayer>::parse_puzzle(&*ctx, parent_puzzle)? {
        let asset_id = cat.asset_id;
        let parent_info = cat.inner_puzzle; // StreamLayer (= AnnuityInfo)
        // The puzzle is now a confirmed CAT<StreamLayer>, so its solution MUST be a
        // well-formed CatSolution — a parse failure here is a data-integrity error,
        // not an ambiguous puzzle type, so propagate it (`?`) rather than swallow it.
        let inner_sol =
            CatLayer::<StreamLayer>::parse_solution(&*ctx, solution)?.inner_puzzle_solution;

        let child = match inner_sol.mode {
            MODE_TRANSFER => {
                // The layer re-wraps the owner's CREATE_COIN as
                // STREAM<new_owner>. Read the new owner hash from the
                // continuation coin's memo (= the inner owner hash).
                let new_recipient =
                    transfer_new_owner(ctx, &parent_info, asset_id, puzzle_reveal, solution)?
                        .ok_or_else(|| {
                            Error::Custom("transfer continuation not found".into())
                        })?;
                Some((
                    AnnuityInfo { recipient: new_recipient, ..parent_info },
                    parent_coin.amount,
                ))
            }
            MODE_CLAIM => {
                let pt = parent_info.clamp_time(inner_sol.payment_time);
                let to_pay = parent_info.claimable(parent_coin.amount, pt);
                let remainder = parent_coin.amount - to_pay;
                if remainder == 0 {
                    None
                } else {
                    Some((AnnuityInfo { last_payment_time: pt, ..parent_info }, remainder))
                }
            }
            _ => None, // clawback terminates the annuity
        };

        if let Some((child_info, child_amount)) = child {
            let child_cat_ph: Bytes32 =
                CatArgs::curry_tree_hash(asset_id, child_info.inner_puzzle_hash()).into();
            return Ok(Some(Discovered {
                coin: Coin::new(parent_coin.coin_id(), child_cat_ph, child_amount),
                asset_id,
                info: child_info,
                lineage_proof: LineageProof {
                    parent_parent_coin_info: parent_coin.parent_coin_info,
                    parent_inner_puzzle_hash: parent_info.inner_puzzle_hash().into(),
                    parent_amount: parent_coin.amount,
                },
            }));
        }
        return Ok(None);
    }

    // --- Case B: parent CREATED the annuity (funding CAT spend) — read memos ---
    let parent_puzzle = Puzzle::parse(ctx, puzzle_reveal);
    let (asset_id, parent_inner_ph) = match CatLayer::<HashedPtr>::parse_puzzle(ctx, parent_puzzle) {
        Ok(Some(cat)) => (cat.asset_id, Bytes32::from(cat.inner_puzzle.tree_hash())),
        _ => return Ok(None),
    };

    let output = ctx.run(puzzle_reveal, solution)?;
    let conditions = ctx.extract::<Vec<Condition<NodePtr>>>(output)?;
    for cond in conditions {
        let Condition::CreateCoin(cc) = cond else {
            continue;
        };
        let Memos::Some(memos_ptr) = cc.memos else {
            continue;
        };
        let memos = ctx.extract::<Vec<Bytes>>(memos_ptr)?;
        let Some(info) = info_from_memos(&memos) else {
            continue;
        };
        let cat_ph: Bytes32 = CatArgs::curry_tree_hash(asset_id, info.inner_puzzle_hash()).into();
        if cc.puzzle_hash == cat_ph {
            return Ok(Some(Discovered {
                coin: Coin::new(parent_coin.coin_id(), cat_ph, cc.amount),
                asset_id,
                info,
                lineage_proof: LineageProof {
                    parent_parent_coin_info: parent_coin.parent_coin_info,
                    parent_inner_puzzle_hash: parent_inner_ph,
                    parent_amount: parent_coin.amount,
                },
            }));
        }
    }

    Ok(None)
}

/// Run the parent CAT spend and find the re-wrapped transfer continuation:
/// the output CREATE_COIN whose puzzle hash equals `CAT<STREAM<owner>>` for the
/// owner hash recorded in its first memo. Returns that new owner hash.
fn transfer_new_owner(
    ctx: &mut SpendContext,
    parent_info: &AnnuityInfo,
    asset_id: Bytes32,
    puzzle_reveal: NodePtr,
    solution: NodePtr,
) -> Result<Option<Bytes32>> {
    let output = ctx.run(puzzle_reveal, solution)?;
    let conditions = ctx.extract::<Vec<Condition<NodePtr>>>(output)?;
    for cond in conditions {
        let Condition::CreateCoin(cc) = cond else {
            continue;
        };
        let Memos::Some(memos_ptr) = cc.memos else {
            continue;
        };
        let memos = ctx.extract::<Vec<Bytes>>(memos_ptr)?;
        let Some(first) = memos.first() else {
            continue;
        };
        let Ok(owner_hash) = <[u8; 32]>::try_from(first.as_ref()) else {
            continue;
        };
        let owner_hash = Bytes32::new(owner_hash);
        let candidate = AnnuityInfo { recipient: owner_hash, ..*parent_info };
        let cat_ph: Bytes32 =
            CatArgs::curry_tree_hash(asset_id, candidate.inner_puzzle_hash()).into();
        if cc.puzzle_hash == cat_ph {
            return Ok(Some(owner_hash));
        }
    }
    Ok(None)
}
