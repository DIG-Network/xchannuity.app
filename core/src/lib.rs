//! Xchannuity core — deterministic spend-bundle builder for a transferable,
//! tradable streamed-CAT annuity on Chia. The on-chain puzzle is authored in
//! Rue (`puzzles/stream.rue`) and embedded here as compiled CLVM.

pub mod assets;
pub mod composition;
pub mod constants;
pub mod dto;
pub mod error;
pub mod layers;
pub mod info;
pub mod spend;
pub mod wasm;

// Compatibility facades so historical `crate::builders::*` and
// `crate::discovery::*` paths continue to resolve.
pub use composition::discovery;
pub use composition::spend as builders;

pub use error::{Error, Result};
pub use info::{AnnuityInfo, StreamCurry, StreamSolution};
pub use layers::stream::StreamLayer;
