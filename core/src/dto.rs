//! Serde DTOs for the wasm edge: parse Sage/dApp JSON into driver types and
//! serialize unsigned bundles back out.

use chia_bls::PublicKey;
use chia_protocol::{Bytes32, Coin, CoinSpend};
use chia_puzzle_types::LineageProof;
use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;

use crate::builders::UnsignedBundle;

fn err(m: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&m.to_string())
}

pub fn b32(s: &str) -> Result<Bytes32, JsValue> {
    let raw = hex::decode(s.trim().trim_start_matches("0x")).map_err(err)?;
    let arr: [u8; 32] = raw.try_into().map_err(|_| err("expected 32 bytes"))?;
    Ok(Bytes32::new(arr))
}

pub fn opt_b32(s: &Option<String>) -> Result<Option<Bytes32>, JsValue> {
    match s {
        Some(h) if !h.trim().is_empty() => Ok(Some(b32(h)?)),
        _ => Ok(None),
    }
}

pub fn pk(s: &str) -> Result<PublicKey, JsValue> {
    let raw = hex::decode(s.trim().trim_start_matches("0x")).map_err(err)?;
    let arr: [u8; 48] = raw.try_into().map_err(|_| err("expected 48-byte G1 key"))?;
    PublicKey::from_bytes(&arr).map_err(|_| err("invalid public key"))
}

#[derive(Deserialize)]
pub struct CoinJson {
    pub parent_coin_info: String,
    pub puzzle_hash: String,
    pub amount: u64,
}
impl CoinJson {
    pub fn to_coin(&self) -> Result<Coin, JsValue> {
        Ok(Coin::new(b32(&self.parent_coin_info)?, b32(&self.puzzle_hash)?, self.amount))
    }
}

#[derive(Deserialize)]
pub struct LineageJson {
    pub parent_parent_coin_info: String,
    pub parent_inner_puzzle_hash: String,
    pub parent_amount: u64,
}
impl LineageJson {
    pub fn to_lineage(&self) -> Result<LineageProof, JsValue> {
        Ok(LineageProof {
            parent_parent_coin_info: b32(&self.parent_parent_coin_info)?,
            parent_inner_puzzle_hash: b32(&self.parent_inner_puzzle_hash)?,
            parent_amount: self.parent_amount,
        })
    }
}

/// Curried annuity state shared by every per-coin flow.
#[derive(Deserialize)]
pub struct AnnuityParamsJson {
    pub recipient: String,
    pub clawback_ph: Option<String>,
    pub end_time: u64,
    pub last_payment_time: u64,
}

#[derive(Deserialize)]
pub struct FlowRequest {
    pub params: AnnuityParamsJson,
    pub annuity_coin: CoinJson,
    pub lineage_proof: LineageJson,
    pub asset_id: String,
    /// The owner's (claim/transfer) or issuer's (clawback) synthetic key. For
    /// claim/transfer this is the beneficiary key that authorizes by revealing +
    /// running its standard p2; for clawback it is the issuer's signing key.
    pub owner_synthetic_key: String,
    /// CLAWBACK only: the issuer's coin that emits the authorizing message.
    #[serde(default)]
    pub owner_coin: Option<CoinJson>,
    /// claim/clawback: the payment time. transfer: ignored.
    pub time: Option<u64>,
    /// transfer only.
    pub new_recipient: Option<String>,
}

#[derive(Deserialize)]
pub struct CatCoinJson {
    pub coin: CoinJson,
    pub lineage_proof: LineageJson,
    pub p2_puzzle_hash: String,
    /// The synthetic key that controls this funding coin (its p2). Funding may
    /// span multiple keys, so each coin carries its own.
    pub synthetic_key: String,
}

#[derive(Deserialize)]
pub struct CreateRequest {
    pub asset_id: String,
    pub funding: Vec<CatCoinJson>,
    pub recipient: String,
    pub clawback_ph: Option<String>,
    pub end_time: u64,
    pub start_time: u64,
    pub principal: u64,
    #[serde(default)]
    pub network_fee_mojos: u64,
    #[serde(default)]
    pub xch_fee_coin: Option<CoinJson>,
    #[serde(default)]
    pub xch_fee_key: Option<String>,
}

/// Maker side of an OPEN sell offer (no named buyer): the maker's revealed p2
/// parks the annuity under the settlement puzzle, gated on the requested
/// `xch_amount` to `maker_puzzle_hash`. The taker names themselves the new owner.
#[derive(Deserialize)]
pub struct OpenOfferRequest {
    pub params: AnnuityParamsJson,
    pub annuity_coin: CoinJson,
    pub lineage_proof: LineageJson,
    pub asset_id: String,
    pub owner_synthetic_key: String,
    pub maker_puzzle_hash: String,
    pub xch_amount: u64,
}

/// Take an offer from ONLY the `offer1` string. Everything else (the annuity
/// params, the parked coin + lineage, the requested XCH amount and where it is
/// paid) is recovered by decoding the offer. The taker supplies only their own
/// choices: where they want to own the annuity (`taker_recipient`), which XCH
/// coin pays for it (`taker_xch_coin`), and the key that signs that payment.
#[derive(Deserialize)]
pub struct TakeFromOfferRequest {
    pub offer: String,
    pub taker_recipient: String,
    pub taker_xch_coin: CoinJson,
    pub taker_synthetic_key: String,
}

/// The unsigned maker bundle + the settlement terms a taker needs. After Sage
/// partial-signs `coin_spends`, the dApp passes them (unchanged) plus the sig to
/// `encode_offer` to get the `offer1…` string.
#[derive(Serialize)]
pub struct OfferDraftJson {
    pub coin_spends: Vec<CoinSpend>,
    pub stream_id: String,
    pub settlement_id: String,
    pub nonce: String,
    pub maker_puzzle_hash: String,
    pub xch_amount: u64,
}

impl From<crate::builders::OfferUnsigned> for OfferDraftJson {
    fn from(o: crate::builders::OfferUnsigned) -> Self {
        OfferDraftJson {
            coin_spends: o.coin_spends,
            stream_id: format!("0x{}", hex::encode(o.stream_id)),
            settlement_id: format!("0x{}", hex::encode(o.settlement_id)),
            nonce: format!("0x{}", hex::encode(o.nonce)),
            maker_puzzle_hash: format!("0x{}", hex::encode(o.maker_puzzle_hash)),
            xch_amount: o.xch_amount,
        }
    }
}

/// Signed maker bundle → `offer1…`: the original `coin_spends` from
/// `OfferDraftJson` plus Sage's aggregated partial signature.
#[derive(Deserialize)]
pub struct EncodeOfferRequest {
    pub coin_spends: Vec<CoinSpend>,
    pub aggregated_signature: String,
}

/// Read-only summary of an offer's trade terms, for the Take-offer preview.
#[derive(Serialize)]
pub struct OfferInspectionJson {
    pub asset_id: String,
    pub amount: u64,
    pub end_time: u64,
    pub last_payment_time: u64,
    pub clawback_ph: Option<String>,
    pub maker_puzzle_hash: String,
    pub xch_amount: u64,
}

impl From<crate::builders::OfferInspection> for OfferInspectionJson {
    fn from(i: crate::builders::OfferInspection) -> Self {
        OfferInspectionJson {
            asset_id: format!("0x{}", hex::encode(i.asset_id)),
            amount: i.amount,
            end_time: i.end_time,
            last_payment_time: i.last_payment_time,
            clawback_ph: i.clawback_ph.map(|c| format!("0x{}", hex::encode(c))),
            maker_puzzle_hash: format!("0x{}", hex::encode(i.maker_puzzle_hash)),
            xch_amount: i.xch_amount,
        }
    }
}

#[derive(Serialize)]
pub struct BundleJson {
    pub coin_spends: Vec<CoinSpend>,
    pub stream_id: String,
}

/// A take bundle: maker park spend(s) + taker fill spends, plus the maker's
/// signature (from the offer) so `signAndBroadcast` can aggregate it with Sage's.
#[derive(Serialize)]
pub struct TakeBundleJson {
    pub coin_spends: Vec<CoinSpend>,
    pub stream_id: String,
    pub issuer_partial_sig_hex: String,
}

impl From<UnsignedBundle> for BundleJson {
    fn from(b: UnsignedBundle) -> Self {
        BundleJson {
            coin_spends: b.coin_spends,
            stream_id: format!("0x{}", hex::encode(b.stream_id)),
        }
    }
}

fn hx(b: Bytes32) -> String {
    format!("0x{}", hex::encode(b))
}

#[derive(Serialize)]
pub struct CoinOut {
    pub parent_coin_info: String,
    pub puzzle_hash: String,
    pub amount: u64,
}

#[derive(Serialize)]
pub struct LineageOut {
    pub parent_parent_coin_info: String,
    pub parent_inner_puzzle_hash: String,
    pub parent_amount: u64,
}

/// A discovered live annuity, ready for the dApp to render + build spends from.
#[derive(Serialize)]
pub struct DiscoveredJson {
    pub coin: CoinOut,
    pub stream_id: String,
    pub asset_id: String,
    pub recipient: String,
    pub clawback_ph: Option<String>,
    pub end_time: u64,
    pub last_payment_time: u64,
    pub amount: u64,
    pub lineage_proof: LineageOut,
}

pub fn discovered_json(d: &crate::discovery::Discovered) -> DiscoveredJson {
    DiscoveredJson {
        coin: CoinOut {
            parent_coin_info: hx(d.coin.parent_coin_info),
            puzzle_hash: hx(d.coin.puzzle_hash),
            amount: d.coin.amount,
        },
        stream_id: hx(d.coin.coin_id()),
        asset_id: hx(d.asset_id),
        recipient: hx(d.info.recipient),
        clawback_ph: d.info.clawback_ph.map(hx),
        end_time: d.info.end_time,
        last_payment_time: d.info.last_payment_time,
        amount: d.coin.amount,
        lineage_proof: LineageOut {
            parent_parent_coin_info: hx(d.lineage_proof.parent_parent_coin_info),
            parent_inner_puzzle_hash: hx(d.lineage_proof.parent_inner_puzzle_hash),
            parent_amount: d.lineage_proof.parent_amount,
        },
    }
}
