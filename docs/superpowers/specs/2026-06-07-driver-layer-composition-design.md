# Driver Layer Composition — Design Spec

**Date:** 2026-06-07
**Scope:** `xchannuity-core` Rust driver only. No on-chain puzzle change, no wasm API change, no offer/discovery semantics change.

## Goal

Restructure the streaming-annuity driver so every puzzle layer is a **hard, independently
auditable boundary**, and a single **composition layer** snaps the boundaries into the working
smart coin (puzzle hash) and spend bundles.

The driving requirement is peer review. A reviewer should be able to open one file per layer and
audit it in isolation:

- Pre-audited / SDK-backed layers (CAT, the owner p2, settlement) collapse to near-nothing — a
  re-export plus a doc line — signalling "nothing custom here, trust the audited primitive."
- Custom layers (the `stream.rue` ownership+vesting layer, the clawback authorization) hold all
  the bespoke logic and are where scrutiny concentrates.
- Composition is confined to one place, so "how the coin is assembled" is never tangled with
  "what a layer does."

Each layer models the real on-chain boundary 1:1 — a driver layer never invents a boundary that
doesn't exist in CLVM.

## Constraints (hard)

1. **On-chain bytes unchanged.** `StreamCurry` fields, curry order, and `StreamSolution` wire
   format are preserved exactly ⇒ the stream mod hash `0x39ec8ca9b00348fe658c78d390032921f989ae3a696d5578c3866c6a803c5046`
   and every derived puzzle/coin hash are identical. This is a pure Rust reorganization.
2. **All tests stay green, unmodified:** 44 `cargo test` + 4 `rue test`. The existing
   `roundtrip.rs`, `adversarial.rs`, `exploits.rs`, `builders.rs`, `redteam.rs` recompute hashes
   and run real CLVM/BLS, so they are the behavior-preservation oracle.
3. **Public surface preserved.** `wasm.rs` and the `build_*` entry points keep their signatures;
   `crate::builders::*` and `crate::{AnnuityInfo, ...}` keep resolving (via re-exports / alias).
4. **WASM-safe deps only** — `chia-sdk-driver`/`-types`/`-utils` sub-crates (already pinned), no
   umbrella `chia-wallet-sdk`.

## Architecture

The annuity smart coin is, on-chain:

```
CatLayer<StreamLayer>                ← composed puzzle identity + discovery (SDK generics)
   │  asset_id
   └─ StreamLayer                    ← stream.rue: curries owner_HASH + (clawback_ph, end, last)
        owner_puzzle_hash            ← ownership boundary, by HASH (sendable to any address)
        └─ owner authorization       ← revealed in StreamLayer::Solution at SPEND time
             (StandardLayer | SettlementLayer)
```

Three real boundaries. `StreamLayer` is the new custom layer. CAT (outer) and the owner p2
(inner, revealed in the solution — not a curried inner puzzle) are SDK layers. Decision rationale
(resolved during brainstorming):

- **Real SDK `chia_sdk_driver::Layer` trait** for `StreamLayer`, so the coin composes as
  `CatLayer<StreamLayer>` through the SDK's own generics — same idiom as `CatLayer`/`StandardLayer`
  and the action layer. The trait *is* the hard boundary.
- **Owner = spend-time layer, not a generic type param.** `stream.rue` curries the owner *hash*
  (a `Bytes32`), and annuities are sent to addresses whose p2 the sender doesn't control. So
  `StreamLayer` is non-generic and holds `owner_puzzle_hash`; the owner's authorization is built at
  spend time from an SDK layer and embedded in `StreamLayer::Solution`. (A generic
  `StreamLayer<I>` would force an awkward hash-only dummy inner for send-to-stranger, discovery,
  and clawback.)

## Module layout

```
src/
  layers/
    mod.rs        re-exports; module doc: "each file = one on-chain layer, audit in isolation"
    cat.rs        AUDITED (~tiny): re-export SDK Cat/CatLayer/CatSpend + doc. No custom logic.
    owner.rs      AUDITED (~small): owner authorization = SDK StandardLayer | SettlementLayer,
                  thin adapters producing the (owner_puzzle, owner_solution) revealed in the
                  stream solution. Encodes the three owner kinds (standard claim/transfer,
                  settlement maker-park, settlement taker-route, raw escape hatch).
    clawback.rs   CUSTOM (~small): mode-23 issuer authorization — CLAWBACK_TAG, the
                  sha256(TAG ++ my_amount ++ pt) message body, and authorize_message (the
                  issuer coin spend that emits the SEND_MESSAGE).
    stream.rs     CUSTOM (MEATY): the stream.rue boundary, self-contained —
                    - StreamLayer { clawback_ph, end_time, last_payment_time, owner_puzzle_hash }
                    - StreamCurry (#[clvm(curry)]), StreamSolution (#[clvm(list)])
                    - impl chia_sdk_driver::Layer for StreamLayer
                      (construct_puzzle / construct_solution / parse_puzzle / parse_solution)
                    - vesting math: claimable, clamp_time, after_claim, after_transfer,
                      launch_hints, inner_puzzle_hash
  composition/
    mod.rs        re-exports
    puzzle.rs     compose CatLayer<StreamLayer> → inner + CAT smart-coin puzzle hashes
    spend.rs      (= today's builders.rs) compose owner + stream + CAT → spend bundles:
                  build_create(_inner) / build_claim / build_clawback / build_transfer /
                  build_open_offer / build_take_offer / take_from_offer / parse_offer /
                  inspect_offer / maker_spends_from_offer; UnsignedBundle / OfferUnsigned
    discovery.rs  compose-parse CatLayer<StreamLayer> → child_from_parent_spend
  constants.rs · assets.rs · dto.rs · error.rs · wasm.rs   (unchanged)
```

### `AnnuityInfo`

Absorbed into `StreamLayer` — params + math + `Layer` impl live together in `stream.rs`, so the
custom layer reads top-to-bottom as one unit. Backward compatibility:

- `pub type AnnuityInfo = StreamLayer;` (kept in `info.rs`, or re-exported from `lib.rs`), so
  `wasm.rs`, `composition/*`, and the test suite compile unchanged.
- The field `recipient` becomes `owner_puzzle_hash`. Provide a `recipient()` accessor (and keep a
  `recipient` field name if a rename would churn the tests more than it clarifies — implementer's
  call, but the public constructor `StreamLayer::new(owner_puzzle_hash, clawback_ph, end_time, last_payment_time)`
  must keep positional parity with today's `AnnuityInfo::new(recipient, clawback_ph, end_time, last_payment_time)`).

### `lib.rs` re-exports (surface preservation)

```rust
pub mod layers;
pub mod composition;
// compatibility facade so existing paths resolve:
pub use composition::spend as builders;       // crate::builders::build_* unchanged
pub use composition::discovery;               // crate::discovery::child_from_parent_spend unchanged
pub use layers::stream::{StreamLayer, StreamCurry, StreamSolution};
pub use layers::stream::StreamLayer as AnnuityInfo;
pub use error::{Error, Result};
```

(`spend.rs`'s former home `crate::spend::{claim_solution, ...}` is preserved either by keeping a
`spend` re-export module or by moving those constructors onto `OwnerAuthorization` / `StreamLayer`
and re-exporting. The test suite imports `xchannuity_core::spend::{...}` and
`xchannuity_core::builders::{...}` and `xchannuity_core::discovery::{...}` — all three must keep
resolving.)

## Data flow

**Spend (e.g. claim/transfer):**
1. `StreamLayer` (from `AnnuityInfo`/params) describes the coin's curried state.
2. `layers::owner` builds the owner authorization → the `(owner_puzzle, owner_solution)` pair (+ any
   extra conditions, e.g. the offer settlement announcement).
3. Assemble `StreamSolution { mode, my_amount, payment_time, owner_puzzle, owner_solution }`.
4. `inner = Spend::new(stream_layer.construct_puzzle(ctx)?, stream_layer.construct_solution(ctx, sol)?)`.
5. `Cat::spend_all(ctx, &[CatSpend::new(cat, inner)])` — **kept**, because the high-level `Cat`
   primitive owns the CAT value-conservation ring + lineage proofs; `CatLayer` alone does not.

**Clawback:** no owner authorization is run; `layers::clawback` builds the issuer message spend and
the `StreamSolution` has nil owner fields.

**Discovery (parse):** `CatLayer::<StreamLayer>::parse_puzzle(parent_puzzle)` yields a typed
`CatLayer<StreamLayer>`; `parse_solution` yields `CatSolution<StreamSolution>`. The mode drives
child reconstruction (claim advances `last_payment_time`; transfer reads the re-wrapped owner from
the continuation; clawback terminates). The creation/launch-hint path (parent is a funding CAT
spend, read `launch_hints` memos) is unchanged.

## Error handling

No new error semantics. `parse_puzzle` returns `Ok(None)` for non-matching puzzles (per the `Layer`
trait contract) so composed parsing degrades gracefully; `DriverError`/`crate::Error` propagation is
unchanged. The clawback/offer guards (`ClawbackableNotSellable`, degenerate-window, allow-list)
stay in their current locations (`composition/spend.rs`).

## Testing

- **Behavior oracle:** run the full suite after each migration step; it must stay 44 cargo + 4 rue,
  all green, with no test edits. Any hash drift = a mistake (curry/solution must be byte-identical).
- **New regression unit tests (in `layers/stream.rs` or a `tests/layers.rs`):**
  1. `StreamLayer.construct_puzzle` tree hash == the legacy `AnnuityInfo::inner_puzzle_hash` value
     for a fixed fixture (guards the curry).
  2. `CatLayer::<StreamLayer>::parse_puzzle` ∘ `construct_puzzle` round-trips a constructed annuity
     (asset_id + all four curried fields recovered).
  3. `parse_solution` round-trips a `StreamSolution` for each mode.

## Migration order (high level; detailed steps go to the implementation plan)

1. Create `layers/stream.rs`: move `StreamCurry`/`StreamSolution` + `AnnuityInfo` body, add the
   `Layer` impl. Add the `AnnuityInfo` alias. Keep everything else importing as before. Tests green.
2. Add `layers/cat.rs`, `layers/owner.rs`, `layers/clawback.rs`; move the owner-spend constructors
   and the clawback message helpers out of `spend.rs` into them. Tests green.
3. Create `composition/` and move `builders.rs` → `composition/spend.rs`, `discovery.rs` →
   `composition/discovery.rs`; add `composition/puzzle.rs`. Wire `lib.rs` re-exports. Tests green.
4. Rewrite `composition/discovery.rs` peeling to use `CatLayer::<StreamLayer>::parse_puzzle` +
   `parse_solution`. Tests green.
5. Add the regression unit tests. Final full `cargo test` + `rue test`. Update `STATUS.md` layout.

Each step is independently compilable and test-green, so review/bisect is clean.

## Risks & mitigations

- **Hash drift** from an accidental curry/field reorder → caught immediately by `roundtrip.rs` +
  the new regression test (1).
- **Re-export gaps** breaking `wasm.rs`/tests → caught by `cargo build` + the suite; the compat
  facade in `lib.rs` is explicit.
- **Scope creep** (touching the puzzle or offer semantics) → out of scope; the spec forbids it and
  the unchanged tests enforce it.

## Out of scope

On-chain puzzle changes; action-layer adoption; wasm API changes; offer protocol changes; the
dApp/`app/`. Pure driver-side reorganization for auditability.
