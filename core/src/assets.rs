//! Supported denomination CATs. Xchannuity annuities may ONLY be denominated in
//! these assets (decision: curated allow-list, not "any CAT"). Enforced by the
//! create builder and surfaced to the dApp token picker via `wasm::supported_assets`.
//!
//! Asset ids and decimals are cross-checked against public Chia sources; see the
//! `verify-cats` verification run. Chia CAT2 convention is 3 decimals
//! (1 token = 1000 mojos).

use chia_protocol::Bytes32;
use hex_literal::hex;

#[derive(Debug, Clone, Copy)]
pub struct SupportedAsset {
    pub symbol: &'static str,
    pub name: &'static str,
    pub asset_id: Bytes32,
    pub decimals: u8,
}

/// The allow-list. Order is the display order in the picker.
pub fn supported() -> [SupportedAsset; 4] {
    [
        SupportedAsset {
            symbol: "wUSDC",
            name: "Wrapped USDC (warp.green, Ethereum)",
            asset_id: Bytes32::new(hex!(
                "bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e"
            )),
            decimals: 3,
        },
        SupportedAsset {
            symbol: "wUSDC.b",
            name: "Wrapped USDC (warp.green, Base)",
            asset_id: Bytes32::new(hex!(
                "fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d"
            )),
            decimals: 3,
        },
        SupportedAsset {
            symbol: "BYC",
            name: "Bytecash (Circuit DAO stablecoin)",
            asset_id: Bytes32::new(hex!(
                "ae1536f56760e471ad85ead45f00d680ff9cca73b8cc3407be778f1c0c606eac"
            )),
            decimals: 3,
        },
        SupportedAsset {
            symbol: "cMOJO",
            name: "cMojo (cxch.app)",
            asset_id: Bytes32::new(hex!(
                "8808ca01803e09bf6d067075c9373b227aa8b086504ff0ac63cb3f02fe21c9ba"
            )),
            decimals: 3,
        },
    ]
}

/// Whether `asset_id` is an allowed denomination.
pub fn is_supported(asset_id: Bytes32) -> bool {
    supported().iter().any(|a| a.asset_id == asset_id)
}

/// Metadata for a supported asset, if any.
pub fn lookup(asset_id: Bytes32) -> Option<SupportedAsset> {
    supported().into_iter().find(|a| a.asset_id == asset_id)
}

/// Guard used by the create builder: reject any non-allow-listed denomination.
pub fn require_supported(asset_id: Bytes32) -> crate::Result<()> {
    if is_supported(asset_id) {
        Ok(())
    } else {
        Err(crate::Error::UnsupportedAsset(format!("0x{}", hex::encode(asset_id))))
    }
}
