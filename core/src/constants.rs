//! Compiled-puzzle constants. The CLVM hex + tree hash are produced by
//! `rue build core/puzzles/stream.rue --hex --hash` (rue-cli 0.8.4) and committed.

use chia_protocol::Bytes32;
use clvm_utils::TreeHash;

/// Serialized CLVM of `stream.rue` (the `main` mod, before currying).
pub const STREAM_PUZZLE_HEX: &str = include_str!("../puzzles/stream.rue.hex");

/// Tree hash of the uncurried `main` mod (i.e. `tree_hash(main)` in Rue).
pub const STREAM_MOD_HASH_HEX: &str = include_str!("../puzzles/stream.rue.hash");

/// Solution `mode` values — MUST match the consts in stream.rue.
pub const MODE_CLAIM: u8 = 0;
pub const MODE_TRANSFER: u8 = 1;
pub const MODE_CLAWBACK: u8 = 2;

/// Mode-23 message: sender committed by puzzle hash, receiver by full coin id.
pub const STREAM_MSG_MODE: u8 = 23;

/// Protocol fee taken on create only (0.5% = 50 bps). See whitepaper §4.8.
pub const PROTOCOL_FEE_BPS: u64 = 50;

/// Where the protocol fee is paid (decoded from the configured fee address).
pub const PROTOCOL_FEE_ADDRESS: &str =
    "xch1qza35raa2yezce9kvf5z76qgrajpa8dlv0eg63q7dpel3h78hgystyyehc";

pub fn protocol_fee_puzzle_hash() -> Bytes32 {
    chia_sdk_utils::Address::decode(PROTOCOL_FEE_ADDRESS)
        .expect("valid protocol fee address")
        .puzzle_hash
}

fn decode32(hex_str: &str) -> [u8; 32] {
    let bytes = hex::decode(hex_str.trim().trim_start_matches("0x")).expect("valid 32-byte hex");
    bytes.try_into().expect("exactly 32 bytes")
}

/// Raw CLVM bytes of the uncurried streaming puzzle.
pub fn stream_puzzle_bytes() -> Vec<u8> {
    hex::decode(STREAM_PUZZLE_HEX.trim().trim_start_matches("0x")).expect("valid puzzle hex")
}

/// `tree_hash(main)` as a `TreeHash`.
pub fn stream_mod_tree_hash() -> TreeHash {
    TreeHash::new(decode32(STREAM_MOD_HASH_HEX))
}

/// `tree_hash(main)` as a `Bytes32` — curried into the `Stream` struct so the
/// puzzle can recompute its own continuation hash.
pub fn stream_mod_hash() -> Bytes32 {
    Bytes32::new(decode32(STREAM_MOD_HASH_HEX))
}
