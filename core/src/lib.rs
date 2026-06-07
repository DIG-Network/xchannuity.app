//! Xchannuity core — deterministic spend-bundle builder for a transferable,
//! tradable streamed-CAT annuity on Chia. The on-chain puzzle is authored in
//! Rue (`puzzles/stream.rue`) and embedded here as compiled CLVM.

pub mod assets;
pub mod builders;
pub mod constants;
pub mod discovery;
pub mod dto;
pub mod error;
pub mod info;
pub mod spend;
pub mod wasm;

pub use error::{Error, Result};
pub use info::{AnnuityInfo, StreamCurry, StreamSolution};
