//! wasm-bindgen surface for the browser dApp. Pure, deterministic helpers that
//! the Next.js app imports via `@wasm`. The full Sage-facing spend builders
//! (build_create_annuity / build_claim / build_transfer / build_sell_offer)
//! layer on top of `info`/`spend` and the request DTOs in `dto.rs`.

use chia_bls::Signature;
use chia_protocol::Bytes32;
use chia_sdk_driver::SpendContext;
use chia_sdk_utils::Address;
use serde_wasm_bindgen::{from_value, to_value};
use wasm_bindgen::prelude::*;

use crate::composition::discovery;
use crate::composition::spend::{self as builders, UnsignedBundle};
use crate::constants::{PROTOCOL_FEE_BPS, STREAM_MOD_HASH_HEX};
use crate::dto::{
    self, BundleJson, CreateRequest, EncodeOfferRequest, FlowRequest, OfferDraftJson,
    OpenOfferRequest, TakeFromOfferRequest,
};
use crate::layers::cat::{CatArgs, Cat, CatInfo};
use crate::layers::stream::StreamLayer;

fn je<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn parse_b32(s: &str) -> Result<Bytes32, JsValue> {
    let raw = hex::decode(s.trim().trim_start_matches("0x")).map_err(je)?;
    let arr: [u8; 32] = raw.try_into().map_err(|_| JsValue::from_str("expected 32 bytes"))?;
    Ok(Bytes32::new(arr))
}

fn parse_clawback(opt: Option<String>) -> Result<Option<Bytes32>, JsValue> {
    match opt {
        Some(h) if !h.trim().is_empty() => Ok(Some(parse_b32(&h)?)),
        _ => Ok(None),
    }
}

/// Tree hash of the uncurried streaming puzzle (`tree_hash(main)`), 0x-hex.
#[wasm_bindgen]
pub fn stream_puzzle_hash_hex() -> String {
    format!("0x{}", STREAM_MOD_HASH_HEX.trim())
}

/// Protocol fee in basis points (50 = 0.5%, on create only).
#[wasm_bindgen]
pub fn protocol_fee_bps() -> u64 {
    PROTOCOL_FEE_BPS
}

/// Inner (pre-CAT) annuity puzzle hash for the given curried state — used to
/// recognize an annuity coin and to target it on create.
#[wasm_bindgen]
pub fn annuity_inner_puzzle_hash(
    recipient_hex: String,
    clawback_hex: Option<String>,
    end_time: u64,
    last_payment_time: u64,
) -> Result<String, JsValue> {
    let info = StreamLayer::new(
        parse_b32(&recipient_hex)?,
        parse_clawback(clawback_hex)?,
        end_time,
        last_payment_time,
    );
    let ph: Bytes32 = crate::composition::puzzle::annuity_inner_puzzle_hash(&info).into();
    Ok(format!("0x{}", hex::encode(ph)))
}

/// CAT-wrapped annuity puzzle hash for a given asset id — the on-chain coin
/// puzzle hash the dApp scans for when discovering a wallet's annuities.
#[wasm_bindgen]
pub fn annuity_cat_puzzle_hash(
    asset_id_hex: String,
    recipient_hex: String,
    clawback_hex: Option<String>,
    end_time: u64,
    last_payment_time: u64,
) -> Result<String, JsValue> {
    let info = StreamLayer::new(
        parse_b32(&recipient_hex)?,
        parse_clawback(clawback_hex)?,
        end_time,
        last_payment_time,
    );
    let asset_id = parse_b32(&asset_id_hex)?;
    let cat_ph: Bytes32 = crate::composition::puzzle::annuity_cat_puzzle_hash(asset_id, &info);
    Ok(format!("0x{}", hex::encode(cat_ph)))
}

/// Vested-now amount for an annuity coin of `my_amount`, at unix time `now`.
#[wasm_bindgen]
pub fn claimable_now(
    my_amount: u64,
    end_time: u64,
    last_payment_time: u64,
    now: u64,
) -> u64 {
    // recipient/clawback don't affect the math; use placeholders
    let info = StreamLayer::new(Bytes32::default(), None, end_time, last_payment_time);
    info.claimable(my_amount, now)
}

/// bech32m Chia address -> 0x puzzle hash.
#[wasm_bindgen]
pub fn address_to_puzzle_hash(address: String) -> Result<String, JsValue> {
    let a = Address::decode(&address).map_err(je)?;
    Ok(format!("0x{}", hex::encode(a.puzzle_hash)))
}

/// 0x puzzle hash -> bech32m address with the given prefix (e.g. "xch", "txch").
#[wasm_bindgen]
pub fn puzzle_hash_to_address(puzzle_hash_hex: String, prefix: String) -> Result<String, JsValue> {
    Address::new(parse_b32(&puzzle_hash_hex)?, prefix).encode().map_err(je)
}

/// Coin id (name) from parent / puzzle hash / amount.
#[wasm_bindgen]
pub fn coin_id(parent_hex: String, puzzle_hash_hex: String, amount: u64) -> Result<String, JsValue> {
    let coin = chia_protocol::Coin::new(parse_b32(&parent_hex)?, parse_b32(&puzzle_hash_hex)?, amount);
    Ok(format!("0x{}", hex::encode(coin.coin_id())))
}

/// Standard (p2) puzzle hash for a synthetic public key — the inner puzzle hash
/// of a wallet's coins. Used to resolve which key controls a coin and as the
/// inner p2 hash a CAT coin wraps.
#[wasm_bindgen]
pub fn standard_puzzle_hash(synthetic_key_hex: String) -> Result<String, JsValue> {
    let pk = dto::pk(&synthetic_key_hex)?;
    let ph: Bytes32 = chia_puzzle_types::standard::StandardArgs::curry_tree_hash(pk).into();
    Ok(format!("0x{}", hex::encode(ph)))
}

/// CAT (outer) puzzle hash wrapping an arbitrary inner puzzle hash for an asset.
#[wasm_bindgen]
pub fn cat_puzzle_hash(asset_id_hex: String, inner_puzzle_hash_hex: String) -> Result<String, JsValue> {
    let asset_id = parse_b32(&asset_id_hex)?;
    let inner_raw = hex::decode(inner_puzzle_hash_hex.trim().trim_start_matches("0x")).map_err(je)?;
    let inner_arr: [u8; 32] = inner_raw.try_into().map_err(|_| JsValue::from_str("inner hash must be 32 bytes"))?;
    let ph: Bytes32 = CatArgs::curry_tree_hash(asset_id, clvm_utils::TreeHash::new(inner_arr)).into();
    Ok(format!("0x{}", hex::encode(ph)))
}

/// The allow-listed denomination CATs (symbol, name, 0x asset id, decimals).
#[wasm_bindgen]
pub fn supported_assets() -> Result<JsValue, JsValue> {
    #[derive(serde::Serialize)]
    struct A {
        symbol: String,
        name: String,
        asset_id: String,
        decimals: u8,
    }
    let list: Vec<A> = crate::assets::supported()
        .iter()
        .map(|a| A {
            symbol: a.symbol.to_string(),
            name: a.name.to_string(),
            asset_id: format!("0x{}", hex::encode(a.asset_id)),
            decimals: a.decimals,
        })
        .collect();
    to_value(&list).map_err(je)
}

fn bundle_js(b: UnsignedBundle) -> Result<JsValue, JsValue> {
    to_value(&BundleJson::from(b)).map_err(je)
}

fn info_from(p: &dto::AnnuityParamsJson) -> Result<StreamLayer, JsValue> {
    Ok(StreamLayer::new(
        dto::b32(&p.recipient)?,
        dto::opt_b32(&p.clawback_ph)?,
        p.end_time,
        p.last_payment_time,
    ))
}

/// Build an unsigned CREATE bundle (spends allow-listed CAT funding into a new annuity).
#[wasm_bindgen]
pub fn build_create_annuity(req: JsValue) -> Result<JsValue, JsValue> {
    let r: CreateRequest = from_value(req).map_err(je)?;
    let mut ctx = SpendContext::new();
    let asset_id = dto::b32(&r.asset_id)?;
    let mut funding = Vec::with_capacity(r.funding.len());
    for f in &r.funding {
        let cat = Cat {
            coin: f.coin.to_coin()?,
            lineage_proof: Some(f.lineage_proof.to_lineage()?),
            info: CatInfo {
                asset_id,
                hidden_puzzle_hash: None,
                p2_puzzle_hash: dto::b32(&f.p2_puzzle_hash)?,
            },
        };
        // Each funding coin carries its OWN controlling key so the principal can
        // be sourced across multiple wallet keys/addresses.
        funding.push((cat, dto::pk(&f.synthetic_key)?));
    }
    let xch_fee = match (&r.xch_fee_coin, &r.xch_fee_key) {
        (Some(c), Some(k)) => Some((c.to_coin()?, dto::pk(k)?)),
        _ => None,
    };
    // Accept any asset id (the dApp's allow-list is a convenience picker only).
    let bundle = builders::build_create_inner(
        &mut ctx,
        asset_id,
        funding,
        dto::b32(&r.recipient)?,
        dto::opt_b32(&r.clawback_ph)?,
        r.end_time,
        r.start_time,
        r.principal,
        r.network_fee_mojos,
        xch_fee,
    )
    .map_err(je)?;
    bundle_js(bundle)
}

/// Build an unsigned CLAIM bundle (annuity spend + owner authorizing message).
#[wasm_bindgen]
pub fn build_claim(req: JsValue) -> Result<JsValue, JsValue> {
    let r: FlowRequest = from_value(req).map_err(je)?;
    let mut ctx = SpendContext::new();
    let info = info_from(&r.params)?;
    let bundle = builders::build_claim(
        &mut ctx,
        &info,
        r.annuity_coin.to_coin()?,
        r.lineage_proof.to_lineage()?,
        dto::b32(&r.asset_id)?,
        dto::pk(&r.owner_synthetic_key)?,
        r.time.ok_or_else(|| JsValue::from_str("time required"))?,
    )
    .map_err(je)?;
    bundle_js(bundle)
}

/// Build an unsigned CLAWBACK bundle (issuer terminates).
#[wasm_bindgen]
pub fn build_clawback(req: JsValue) -> Result<JsValue, JsValue> {
    let r: FlowRequest = from_value(req).map_err(je)?;
    let mut ctx = SpendContext::new();
    let info = info_from(&r.params)?;
    let issuer_coin = r
        .owner_coin
        .as_ref()
        .ok_or_else(|| JsValue::from_str("clawback requires issuer owner_coin"))?
        .to_coin()?;
    let bundle = builders::build_clawback(
        &mut ctx,
        &info,
        r.annuity_coin.to_coin()?,
        r.lineage_proof.to_lineage()?,
        dto::b32(&r.asset_id)?,
        dto::pk(&r.owner_synthetic_key)?,
        issuer_coin,
        r.time.ok_or_else(|| JsValue::from_str("time required"))?,
    )
    .map_err(je)?;
    bundle_js(bundle)
}

/// Build an unsigned TRANSFER bundle (plain ownership reassignment).
#[wasm_bindgen]
pub fn build_transfer(req: JsValue) -> Result<JsValue, JsValue> {
    let r: FlowRequest = from_value(req).map_err(je)?;
    let mut ctx = SpendContext::new();
    let info = info_from(&r.params)?;
    let new_recipient = dto::b32(
        r.new_recipient.as_deref().ok_or_else(|| JsValue::from_str("new_recipient required"))?,
    )?;
    let bundle = builders::build_transfer(
        &mut ctx,
        &info,
        r.annuity_coin.to_coin()?,
        r.lineage_proof.to_lineage()?,
        dto::b32(&r.asset_id)?,
        dto::pk(&r.owner_synthetic_key)?,
        new_recipient,
    )
    .map_err(je)?;
    bundle_js(bundle)
}

/// Build the maker side of an OPEN sell offer (no named buyer). The maker's
/// revealed p2 parks the annuity under the settlement puzzle gated on the XCH
/// terms. Returns an `OfferDraftJson` whose `coin_spends` is the parking
/// transfer; Sage partial-signs it, and the dApp packages it into a shareable
/// offer payload. The taker names themselves the new owner via `build_take_offer`.
#[wasm_bindgen]
pub fn build_open_offer(req: JsValue) -> Result<JsValue, JsValue> {
    let r: OpenOfferRequest = from_value(req).map_err(je)?;
    let mut ctx = SpendContext::new();
    let info = info_from(&r.params)?;
    let offer = builders::build_open_offer(
        &mut ctx,
        &info,
        r.annuity_coin.to_coin()?,
        r.lineage_proof.to_lineage()?,
        dto::b32(&r.asset_id)?,
        dto::pk(&r.owner_synthetic_key)?,
        dto::b32(&r.maker_puzzle_hash)?,
        r.xch_amount,
    )
    .map_err(je)?;
    to_value(&OfferDraftJson::from(offer)).map_err(je)
}

/// Build the taker side of an offer from ONLY the `offer1` string. Decodes the
/// offer, recovers the annuity params + parked coin + lineage proof from the
/// maker's park spend, and recovers the requested XCH amount + payee from the
/// embedded requested-payment skeleton — no side channel needed. Returns a
/// `BundleJson` of the taker's spends (XCH payment + annuity re-route to the
/// taker). The dApp combines these with the maker's park spend + signature
/// (both inside the decoded offer) and broadcasts.
#[wasm_bindgen]
pub fn inspect_offer(offer: String) -> Result<JsValue, JsValue> {
    let i = builders::inspect_offer(&offer).map_err(je)?;
    to_value(&dto::OfferInspectionJson::from(i)).map_err(je)
}

#[wasm_bindgen]
pub fn build_take_from_offer(req: JsValue) -> Result<JsValue, JsValue> {
    let r: TakeFromOfferRequest = from_value(req).map_err(je)?;
    let mut ctx = SpendContext::new();
    // Taker fill spends (XCH payment + settlement + annuity transfer to taker).
    let taker = builders::take_from_offer(
        &mut ctx,
        &r.offer,
        dto::b32(&r.taker_recipient)?,
        r.taker_xch_coin.to_coin()?,
        dto::pk(&r.taker_synthetic_key)?,
    )
    .map_err(je)?;
    // Maker's (already signed) park spend + signature, recovered from the offer.
    let (maker_spends, maker_sig) = builders::maker_spends_from_offer(&r.offer).map_err(je)?;

    // Combine into one broadcastable bundle: maker park spend first, then the
    // taker spends. Sage partial-signs the taker's XCH payment; the maker's
    // signature aggregates with the wallet's at push.
    let mut coin_spends = maker_spends;
    coin_spends.extend(taker.coin_spends);
    let out = dto::TakeBundleJson {
        coin_spends,
        stream_id: format!("0x{}", hex::encode(taker.stream_id)),
        issuer_partial_sig_hex: format!("0x{}", hex::encode(maker_sig.to_bytes())),
    };
    to_value(&out).map_err(je)
}

/// Compress + bech32-encode a signed maker bundle into a standard `offer1…`
/// string. `req.coin_spends` are the (unchanged) spends from `build_sell_offer`;
/// `req.aggregated_signature` is Sage's partial signature over them.
#[wasm_bindgen]
pub fn encode_offer(req: JsValue) -> Result<String, JsValue> {
    let r: EncodeOfferRequest = from_value(req).map_err(je)?;
    let raw = hex::decode(r.aggregated_signature.trim().trim_start_matches("0x")).map_err(je)?;
    let arr: [u8; 96] =
        raw.try_into().map_err(|_| JsValue::from_str("bad signature length"))?;
    let sig = Signature::from_bytes(&arr).map_err(|_| JsValue::from_str("invalid signature"))?;
    let bundle = chia_protocol::SpendBundle::new(r.coin_spends, sig);
    chia_sdk_driver::encode_offer(&bundle).map_err(je)
}

/// Reconstruct a live annuity from its PARENT coin's spend (puzzle_reveal +
/// solution). Returns null if the parent did not create/recreate an annuity.
/// This is the heart of stateless on-chain discovery.
#[wasm_bindgen]
pub fn discover_from_parent(
    parent_coin: JsValue,
    puzzle_reveal_hex: String,
    solution_hex: String,
) -> Result<JsValue, JsValue> {
    let pc: dto::CoinJson = from_value(parent_coin).map_err(je)?;
    let coin = pc.to_coin()?;
    let mut ctx = SpendContext::new();
    let pr_bytes = hex::decode(puzzle_reveal_hex.trim().trim_start_matches("0x")).map_err(je)?;
    let sol_bytes = hex::decode(solution_hex.trim().trim_start_matches("0x")).map_err(je)?;
    let pr = clvmr::serde::node_from_bytes(&mut ctx, &pr_bytes).map_err(je)?;
    let sol = clvmr::serde::node_from_bytes(&mut ctx, &sol_bytes).map_err(je)?;
    match discovery::child_from_parent_spend(&mut ctx, coin, pr, sol).map_err(je)? {
        Some(d) => to_value(&dto::discovered_json(&d)).map_err(je),
        None => Ok(JsValue::NULL),
    }
}

/// Aggregate 0x-hex BLS signatures (the wallet's partial sig with any others).
#[wasm_bindgen]
pub fn aggregate_signatures(sigs: Vec<String>) -> Result<String, JsValue> {
    let mut agg = Signature::default();
    for s in sigs {
        let raw = hex::decode(s.trim().trim_start_matches("0x")).map_err(je)?;
        let arr: [u8; 96] = raw.try_into().map_err(|_| JsValue::from_str("bad signature length"))?;
        let sig = Signature::from_bytes(&arr).map_err(|_| JsValue::from_str("invalid signature"))?;
        agg += &sig;
    }
    Ok(format!("0x{}", hex::encode(agg.to_bytes())))
}
