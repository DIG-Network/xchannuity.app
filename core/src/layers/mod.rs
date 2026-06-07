//! Puzzle layers — each module is ONE on-chain boundary, auditable in isolation.
//! SDK-backed layers (CAT, owner p2, settlement) are thin re-exports; the custom
//! stream/ownership layer (`stream`) carries all the bespoke logic.

pub mod cat;
pub mod clawback;
pub mod owner;
pub mod stream;

// Surface the custom stream layer + its wire types at the `layers` path.
pub use stream::{StreamCurry, StreamLayer, StreamSolution};
