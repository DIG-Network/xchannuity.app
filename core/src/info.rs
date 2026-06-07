//! Compatibility shim. The annuity's curried state + math now live in the
//! `stream` layer; this re-exports them under the historical names.
pub use crate::layers::stream::{StreamCurry, StreamSolution};
pub use crate::layers::stream::StreamLayer as AnnuityInfo;
