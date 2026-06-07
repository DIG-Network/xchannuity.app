//! Puzzle composition — assemble the layers into the annuity smart-coin puzzle
//! hashes. The on-chain coin is `CatLayer<StreamLayer>`: a CAT outer layer
//! wrapping the stream/ownership inner layer.
use chia_protocol::Bytes32;
use chia_puzzle_types::cat::CatArgs;
use clvm_utils::TreeHash;

use crate::layers::stream::StreamLayer;

/// Inner (pre-CAT) annuity puzzle hash. Canonical entry point — call this rather
/// than `StreamLayer::inner_puzzle_hash()` directly so all annuity hash derivation
/// is traceable through `composition::puzzle`.
pub fn annuity_inner_puzzle_hash(layer: &StreamLayer) -> TreeHash {
    layer.inner_puzzle_hash()
}

/// CAT-wrapped annuity puzzle hash for an asset id — the on-chain coin puzzle hash
/// the dApp scans for. This expresses the `CatLayer<StreamLayer>` composition.
/// Named `annuity_*` to distinguish it from `wasm::cat_puzzle_hash`, the generic
/// helper that wraps an arbitrary inner hash.
pub fn annuity_cat_puzzle_hash(asset_id: Bytes32, layer: &StreamLayer) -> Bytes32 {
    CatArgs::curry_tree_hash(asset_id, layer.inner_puzzle_hash()).into()
}
