//! CAT (outer) layer — the audited Chia CAT puzzle (chia-puzzles). No custom
//! logic lives here: the annuity's CAT wrapping, value-conservation ring, and
//! lineage proofs are handled by the SDK primitives below. The denomination
//! allow-list (a UX convenience, not consensus) lives in `crate::assets`.
pub use chia_puzzle_types::cat::CatArgs;
pub use chia_sdk_driver::{Cat, CatInfo, CatLayer, CatSpend};
