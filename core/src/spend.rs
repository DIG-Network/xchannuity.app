//! Compatibility shim. Spend constructors now live in the per-layer modules:
//! owner authorization → `crate::layers::owner`, clawback (message + nil-owner
//! solution) → `crate::layers::clawback`. This is a stable re-export seam kept so
//! `crate::spend::*` call-sites (and `crate::spend::u64_to_atom` in the stream
//! layer) keep resolving; new code should prefer the canonical `layers::*` paths.
pub use crate::layers::clawback::{
    authorize_message, clawback_message, clawback_solution, u64_to_atom, CLAWBACK_TAG,
};
pub use crate::layers::owner::{
    claim_solution, inner_spend, transfer_solution, transfer_solution_with_owner,
};
