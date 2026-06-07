//! Xchannuity core — deterministic spend-bundle builder for a transferable,
//! tradable streamed-CAT annuity on Chia. The on-chain puzzle is authored in
//! Rue (`puzzles/stream.rue`) and embedded here as compiled CLVM.

pub mod assets;
pub mod composition;
pub mod constants;
pub mod dto;
pub mod error;
pub mod layers;
pub mod wasm;

pub use error::{Error, Result};
