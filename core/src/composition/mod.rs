//! Composition — the ONLY place puzzle layers are assembled into the working
//! smart coin and spend bundles.
//!   - `puzzle`    : layers → coin puzzle hashes (CatLayer<StreamLayer>)
//!   - `spend`     : layers → create/claim/transfer/clawback/offer spend bundles
//!   - `discovery` : parse a parent spend → reconstruct the live annuity coin
pub mod discovery;
pub mod puzzle;
pub mod spend;
