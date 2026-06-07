# Driver Layer Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the `xchannuity-core` Rust driver so every puzzle layer is its own concise, independently-auditable module, composed via the SDK `Layer` trait into `CatLayer<StreamLayer>`, with all composition confined to a `composition/` module.

**Architecture:** `layers/{cat,owner,clawback,stream}.rs` are the hard boundaries (SDK-backed layers are tiny; the custom `stream.rs` is the meaty one). `composition/{puzzle,spend,discovery}.rs` assemble them into the smart coin + spend bundles. Pure reorganization: on-chain bytes are byte-identical, so the mod hash `0x39ec8ca9b00348fe658c78d390032921f989ae3a696d5578c3866c6a803c5046` and all 44 cargo + 4 rue tests stay green unmodified after every task.

**Tech Stack:** Rust, `chia-sdk-driver`/`-types`/`-utils` 0.33 (wasm-safe sub-crates), Rue 0.8.4, `chia-sdk-test` simulator.

---

## Reference: exact 0.33 APIs (verified against the registry source)

```rust
// chia_sdk_driver::Layer
pub trait Layer {
    type Solution;
    fn parse_puzzle(allocator: &Allocator, puzzle: Puzzle) -> Result<Option<Self>, DriverError> where Self: Sized;
    fn parse_solution(allocator: &Allocator, solution: NodePtr) -> Result<Self::Solution, DriverError>;
    fn construct_puzzle(&self, ctx: &mut SpendContext) -> Result<NodePtr, DriverError>;
    fn construct_solution(&self, ctx: &mut SpendContext, solution: Self::Solution) -> Result<NodePtr, DriverError>;
}
// CatLayer<I: Layer>: type Solution = CatSolution<I::Solution>; construct_puzzle uses ctx.curry(CatArgs::new(asset_id, inner));
// parse_puzzle: puzzle.as_curried() → compare mod_hash to CAT_PUZZLE_HASH → CatArgs::from_clvm → I::parse_puzzle(inner_puzzle).
```

`Puzzle` exposes `.as_curried() -> Option<CurriedPuzzle>` where `CurriedPuzzle { mod_hash: TreeHash, args: NodePtr }`. Curried-args structs use `Struct::from_clvm(allocator, args)`. `SpendContext` exposes `ctx.curry(args)` (args must `impl Mod`), `ctx.alloc(&value)`, `ctx.puzzle(hash, bytes)`, `ctx.tree_hash(ptr) -> TreeHash`, `ctx.extract::<T>(ptr)`.

To keep the curried bytes byte-identical to today, `StreamLayer::construct_puzzle` reuses the **existing** mechanism (`ctx.puzzle` + `CurriedProgram`), NOT `ctx.curry`.

---

## Task 1: Create the `stream` layer module (custom, meaty)

Move `StreamCurry`, `StreamSolution`, and the `AnnuityInfo` body into `layers/stream.rs`, rename the struct to `StreamLayer` with an `AnnuityInfo` alias, add the `Layer` impl, and add regression tests. Keep `info.rs` as a re-export shim so nothing else breaks.

**Files:**
- Create: `core/src/layers/mod.rs`
- Create: `core/src/layers/stream.rs`
- Modify: `core/src/info.rs` (becomes a shim)
- Modify: `core/src/lib.rs` (add `pub mod layers;`, re-exports)
- Test: `core/tests/layers.rs` (new)

- [ ] **Step 1: Write the failing regression tests**

Create `core/tests/layers.rs`:

```rust
//! Regression guards for the layer refactor: the composed CatLayer<StreamLayer>
//! must produce byte-identical puzzle hashes and round-trip through parse.
use chia_protocol::Bytes32;
use chia_sdk_driver::{CatLayer, Layer, Puzzle, SpendContext};
use xchannuity_core::layers::stream::StreamLayer;

const START: u64 = 1000;
const END: u64 = 2000;

fn fixture() -> StreamLayer {
    StreamLayer::new(Bytes32::new([3u8; 32]), Some(Bytes32::new([9u8; 32])), END, START)
}

#[test]
fn stream_layer_construct_matches_curry_hash() {
    // construct_puzzle (real CLVM currying) must hash to inner_puzzle_hash (the
    // CurriedProgram tree-hash path) — guards that the two never diverge.
    let mut ctx = SpendContext::new();
    let layer = fixture();
    let ptr = layer.construct_puzzle(&mut ctx).unwrap();
    let constructed: Bytes32 = ctx.tree_hash(ptr).into();
    let declared: Bytes32 = layer.inner_puzzle_hash().into();
    assert_eq!(constructed, declared, "construct_puzzle hash must equal inner_puzzle_hash");
}

#[test]
fn cat_stream_parse_round_trips() {
    // CatLayer<StreamLayer>::parse_puzzle ∘ construct_puzzle recovers every field.
    let mut ctx = SpendContext::new();
    let asset_id = Bytes32::new([7u8; 32]);
    let layer = CatLayer::new(asset_id, fixture());
    let ptr = layer.construct_puzzle(&mut ctx).unwrap();
    let parsed = CatLayer::<StreamLayer>::parse_puzzle(&ctx, Puzzle::parse(&ctx, ptr))
        .unwrap()
        .expect("parses as CatLayer<StreamLayer>");
    assert_eq!(parsed.asset_id, asset_id);
    assert_eq!(parsed.inner_puzzle.owner_puzzle_hash, fixture().owner_puzzle_hash);
    assert_eq!(parsed.inner_puzzle.clawback_ph, fixture().clawback_ph);
    assert_eq!(parsed.inner_puzzle.end_time, END);
    assert_eq!(parsed.inner_puzzle.last_payment_time, START);
}
```

- [ ] **Step 2: Run to verify it fails (module doesn't exist yet)**

Run: `cd core && cargo test --test layers 2>&1 | tail -5`
Expected: FAIL — `unresolved import xchannuity_core::layers`.

- [ ] **Step 3: Create `core/src/layers/mod.rs`**

```rust
//! Puzzle layers — each module is ONE on-chain boundary, auditable in isolation.
//! SDK-backed layers (CAT, owner p2, settlement) are thin re-exports; the custom
//! stream/ownership layer (`stream`) carries all the bespoke logic.

pub mod cat;
pub mod clawback;
pub mod owner;
pub mod stream;
```

(`cat`, `clawback`, `owner` are created in Task 2; add empty stubs now so `mod.rs` compiles.)
Create `core/src/layers/cat.rs`, `core/src/layers/owner.rs`, `core/src/layers/clawback.rs` each containing only a doc line `//! placeholder, filled in Task 2` for now.

- [ ] **Step 4: Create `core/src/layers/stream.rs`**

Move the entire current contents of `core/src/info.rs` here, with three changes:
1. Rename `struct AnnuityInfo` → `struct StreamLayer`; rename its field `recipient` → `owner_puzzle_hash`. Add `pub fn recipient(&self) -> Bytes32 { self.owner_puzzle_hash }` for compat, and update internal uses (`from_curry`, `to_curry`, `after_transfer`) to the new field name.
2. Keep `StreamCurry` and `StreamSolution` here (moved from info.rs).
3. Add the `Layer` impl below the inherent impl:

```rust
use chia_sdk_driver::{DriverError, Layer, Puzzle};
use clvmr::{Allocator, NodePtr};
use clvm_traits::FromClvm;

impl Layer for StreamLayer {
    type Solution = StreamSolution<NodePtr, NodePtr>;

    fn construct_puzzle(&self, ctx: &mut SpendContext) -> Result<NodePtr, DriverError> {
        // Reuse the existing currying mechanism for byte-identical output.
        self.construct_puzzle(ctx) // inherent method (see note below)
    }

    fn construct_solution(
        &self,
        ctx: &mut SpendContext,
        solution: Self::Solution,
    ) -> Result<NodePtr, DriverError> {
        ctx.alloc(&solution)
    }

    fn parse_puzzle(allocator: &Allocator, puzzle: Puzzle) -> Result<Option<Self>, DriverError> {
        let Some(curried) = puzzle.as_curried() else { return Ok(None) };
        if curried.mod_hash != stream_mod_tree_hash() {
            return Ok(None);
        }
        let sc = StreamCurry::from_clvm(allocator, curried.args)?;
        Ok(Some(StreamLayer::from_curry(&sc)))
    }

    fn parse_solution(allocator: &Allocator, solution: NodePtr) -> Result<Self::Solution, DriverError> {
        Ok(StreamSolution::<NodePtr, NodePtr>::from_clvm(allocator, solution)?)
    }
}
```

Note on the inherent vs trait `construct_puzzle` name clash: rename the EXISTING inherent method `construct_puzzle` → `curried_puzzle` (it currently does `ctx.puzzle(...)` + `ctx.alloc(CurriedProgram{...})`), and have the trait impl call `self.curried_puzzle(ctx)`. Update the one caller in `spend.rs` (`info.construct_puzzle(ctx)`) to `info.curried_puzzle(ctx)` in this task (it still lives in spend.rs; just rename the call). Keep `inner_puzzle_hash`, `claimable`, `clamp_time`, `after_claim`, `after_transfer`, `launch_hints` unchanged.

- [ ] **Step 5: Convert `core/src/info.rs` into a shim**

Replace the entire file with:

```rust
//! Compatibility shim. The annuity's curried state + math now live in the
//! `stream` layer; this re-exports them under the historical names.
pub use crate::layers::stream::{StreamCurry, StreamSolution};
pub use crate::layers::stream::StreamLayer as AnnuityInfo;
```

- [ ] **Step 6: Wire `core/src/lib.rs`**

Add `pub mod layers;` (before `pub mod info;`). Keep the existing `pub use info::{AnnuityInfo, StreamCurry, StreamSolution};` line — it now resolves through the shim. Add `pub use layers::stream::StreamLayer;`.

- [ ] **Step 7: Build + run the new tests**

Run: `cd core && cargo test --test layers 2>&1 | tail -8`
Expected: PASS — `stream_layer_construct_matches_curry_hash` + `cat_stream_parse_round_trips` ok.

- [ ] **Step 8: Run the full suite (must be unchanged)**

Run: `cd core && cargo test 2>&1 | grep "test result:"`
Expected: every line `ok`; totals 13 + 7 + 18 + 5 + 1 + 2(layers) across binaries, 0 failed.

- [ ] **Step 9: Commit**

```bash
git add core/src/layers/ core/src/info.rs core/src/lib.rs core/tests/layers.rs
git commit -m "refactor(core): extract StreamLayer with SDK Layer impl"
```

---

## Task 2: Fill the SDK-backed + clawback layer modules

Move the owner-spend constructors and the clawback message helpers out of `spend.rs` into the per-layer modules; `spend.rs` re-exports them so callers are unaffected.

**Files:**
- Modify: `core/src/layers/cat.rs`, `core/src/layers/owner.rs`, `core/src/layers/clawback.rs`
- Modify: `core/src/spend.rs` (becomes thin re-export of the moved items)

- [ ] **Step 1: Fill `core/src/layers/cat.rs` (audited, tiny)**

```rust
//! CAT (outer) layer — the audited Chia CAT puzzle (chia-puzzles). No custom
//! logic lives here: the annuity's CAT wrapping, value-conservation ring, and
//! lineage proofs are handled by the SDK primitives below. The denomination
//! allow-list (a UX convenience, not consensus) lives in `crate::assets`.
pub use chia_sdk_driver::{Cat, CatInfo, CatLayer, CatSpend};
```

- [ ] **Step 2: Fill `core/src/layers/clawback.rs` (custom, small)**

Move `CLAWBACK_TAG`, `u64_to_atom`, `clawback_message`, and `authorize_message` verbatim from `spend.rs` into this file (unchanged bodies), with this module doc prepended:

```rust
//! Clawback authorization layer (CUSTOM). The issuer terminates an annuity by
//! sending a mode-23 message bound to (CLAWBACK_TAG ++ my_amount ++ pt) and, via
//! RECEIVER_COIN, to the exact coin. This module owns the message format and the
//! issuer-coin spend that emits it.
```

Keep the same `use` imports those functions need (chia_bls, chia_protocol, chia_sdk_types::Conditions, STREAM_MSG_MODE, etc.).

- [ ] **Step 3: Fill `core/src/layers/owner.rs` (audited, small)**

Move `claim_solution`, `transfer_solution`, `transfer_solution_with_owner`, `clawback_solution`, and `inner_spend` verbatim from `spend.rs` into this file. Prepend:

```rust
//! Owner-authorization layer (AUDITED inner puzzles). The annuity curries the
//! owner's puzzle HASH; the owner is REVEALED in the stream solution and run for
//! authorization. CLAIM/TRANSFER reveal the owner's standard p2 (SDK
//! `StandardLayer`) or, for offers, the settlement puzzle (SDK `SettlementLayer`).
//! These constructors build the `StreamSolution` for each owner kind. CLAWBACK
//! supplies a nil owner (see `crate::layers::clawback`).
```

Update the internal call `info.construct_puzzle(ctx)` inside `inner_spend` to `info.curried_puzzle(ctx)` (the rename from Task 1). Keep all other bodies unchanged.

- [ ] **Step 4: Convert `core/src/spend.rs` into a re-export shim**

Replace the file with:

```rust
//! Compatibility shim. Spend constructors moved into the per-layer modules:
//! owner authorization → `crate::layers::owner`, clawback message →
//! `crate::layers::clawback`.
pub use crate::layers::clawback::{authorize_message, clawback_message, u64_to_atom, CLAWBACK_TAG};
pub use crate::layers::owner::{
    claim_solution, clawback_solution, inner_spend, transfer_solution, transfer_solution_with_owner,
};
```

- [ ] **Step 5: Build**

Run: `cd core && cargo build 2>&1 | tail -5`
Expected: compiles clean (the shim preserves `crate::spend::*` paths used by `builders.rs` and the test suite).

- [ ] **Step 6: Run the full suite**

Run: `cd core && cargo test 2>&1 | grep -E "test result:|error" | grep -v "0 failed" || echo ALL_OK_OR_SEE_ABOVE`
Then: `cd core && cargo test 2>&1 | grep "test result:"`
Expected: all `ok`, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add core/src/layers/ core/src/spend.rs
git commit -m "refactor(core): move owner + clawback helpers into layer modules"
```

---

## Task 3: Introduce the `composition` module

Relocate `builders.rs` → `composition/spend.rs` and `discovery.rs` → `composition/discovery.rs`, add `composition/puzzle.rs` for puzzle-hash composition, and wire `lib.rs` re-exports so `crate::builders`/`crate::discovery` keep resolving.

**Files:**
- Create: `core/src/composition/mod.rs`, `core/src/composition/spend.rs`, `core/src/composition/discovery.rs`, `core/src/composition/puzzle.rs`
- Delete: `core/src/builders.rs`, `core/src/discovery.rs`
- Modify: `core/src/lib.rs`

- [ ] **Step 1: Move the files**

```bash
cd core
git mv src/builders.rs src/composition/spend.rs 2>/dev/null || (mkdir -p src/composition && git mv src/builders.rs src/composition/spend.rs)
git mv src/discovery.rs src/composition/discovery.rs
```

In `src/composition/spend.rs` and `src/composition/discovery.rs`, fix the now-relative imports: any `use crate::discovery::...` in spend.rs becomes `use crate::composition::discovery::...`; internal `crate::builders::` references (if any) become `crate::composition::spend::`. Leave everything else unchanged.

- [ ] **Step 2: Create `core/src/composition/puzzle.rs`**

```rust
//! Puzzle composition — assemble the layers into the annuity smart-coin puzzle
//! hashes. The on-chain coin is `CatLayer<StreamLayer>`.
use chia_protocol::Bytes32;
use chia_puzzle_types::cat::CatArgs;
use clvm_utils::TreeHash;

use crate::layers::stream::StreamLayer;

/// Inner (pre-CAT) annuity puzzle hash for the given curried state.
pub fn inner_puzzle_hash(layer: &StreamLayer) -> TreeHash {
    layer.inner_puzzle_hash()
}

/// CAT-wrapped annuity puzzle hash for an asset id — the on-chain coin puzzle
/// hash the dApp scans for. This is the `CatLayer<StreamLayer>` composition.
pub fn cat_puzzle_hash(asset_id: Bytes32, layer: &StreamLayer) -> Bytes32 {
    CatArgs::curry_tree_hash(asset_id, layer.inner_puzzle_hash()).into()
}
```

- [ ] **Step 3: Create `core/src/composition/mod.rs`**

```rust
//! Composition — the ONLY place puzzle layers are assembled into the working
//! smart coin and spend bundles.
//!   - `puzzle`    : layers → coin puzzle hashes (CatLayer<StreamLayer>)
//!   - `spend`     : layers → create/claim/transfer/clawback/offer spend bundles
//!   - `discovery` : parse a parent spend → reconstruct the live annuity coin
pub mod discovery;
pub mod puzzle;
pub mod spend;
```

- [ ] **Step 4: Wire `core/src/lib.rs`**

Remove `pub mod builders;` and `pub mod discovery;`. Add:

```rust
pub mod composition;
// Compatibility facade: keep the historical paths resolving.
pub use composition::discovery;
pub use composition::spend as builders;
```

- [ ] **Step 5: Build**

Run: `cd core && cargo build 2>&1 | tail -8`
Expected: clean. (`wasm.rs` uses `crate::builders::*` and `crate::discovery::*` — both resolve via the facade.)

- [ ] **Step 6: Run the full suite**

Run: `cd core && cargo test 2>&1 | grep "test result:"`
Expected: all `ok`, 0 failed. (Test files import `xchannuity_core::builders::*` and `xchannuity_core::discovery::*` — unchanged via the facade.)

- [ ] **Step 7: Commit**

```bash
git add -A core/src
git commit -m "refactor(core): introduce composition module (puzzle/spend/discovery)"
```

---

## Task 4: Rewrite discovery peeling via the composed layer

Replace the hand-rolled CAT→curried-mod→solution extraction in `composition/discovery.rs` (Case A) with `CatLayer::<StreamLayer>::parse_puzzle` + `parse_solution`. The creation/launch-hint path (Case B) is unchanged.

**Files:**
- Modify: `core/src/composition/discovery.rs`

- [ ] **Step 1: Replace the Case-A parse block**

In `child_from_parent_spend`, the current Case A manually does `CatLayer::<HashedPtr>::parse_puzzle`, then `inner.as_curried()`, then `curried.mod_hash == stream_mod_tree_hash()`, then `ctx.extract::<StreamCurry>` and `ctx.extract::<CatSolution<StreamSolution<...>>>`. Replace that block with the composed parse:

```rust
use chia_sdk_driver::{CatLayer, Layer, Puzzle};
use crate::layers::stream::StreamLayer;

// --- Case A: parent IS a CAT-wrapped annuity (claim/transfer recreated it) ---
let parent_puzzle = Puzzle::parse(ctx, puzzle_reveal);
if let Some(cat) = CatLayer::<StreamLayer>::parse_puzzle(ctx, parent_puzzle)? {
    let asset_id = cat.asset_id;
    let parent_info = cat.inner_puzzle; // StreamLayer (= AnnuityInfo)
    let cat_sol = CatLayer::<StreamLayer>::parse_solution(ctx, solution)?;
    let inner_sol = cat_sol.inner_puzzle_solution; // StreamSolution<NodePtr, NodePtr>

    // ... existing match inner_sol.mode { MODE_TRANSFER => ..., MODE_CLAIM => ..., _ => None }
    //     body is UNCHANGED below this point (it already uses `parent_info` + `inner_sol`).
}
```

Keep the existing `match inner_sol.mode { ... }` reconstruction, the `transfer_new_owner` helper, and the lineage-proof construction exactly as they are — only the puzzle/solution PARSING changed from manual extraction to the composed `Layer` calls. `parse_puzzle`/`parse_solution` take `&Allocator`; `SpendContext` derefs to `&Allocator`, so pass `ctx` (or `&*ctx`/`ctx.allocator()` if the deref isn't inferred — verify at compile).

- [ ] **Step 2: Build, fixing any allocator/deref mismatch**

Run: `cd core && cargo build 2>&1 | tail -10`
Expected: clean. If `parse_puzzle(ctx, ...)` fails to coerce, use `parse_puzzle(&ctx.allocator, ...)` (the `SpendContext` field) or the documented accessor.

- [ ] **Step 3: Run the discovery-exercising tests specifically**

Run: `cd core && cargo test --test builders --test exploits 2>&1 | grep -E "discover|test result:"`
Expected: `discover_from_create_then_from_claim` (or equivalently named) + the offer/large-annuity discovery tests `ok`.

- [ ] **Step 4: Run the full suite**

Run: `cd core && cargo test 2>&1 | grep "test result:"`
Expected: all `ok`, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add core/src/composition/discovery.rs
git commit -m "refactor(core): parse discovery via composed CatLayer<StreamLayer>"
```

---

## Task 5: Finalize — full verification + docs

**Files:**
- Modify: `STATUS.md`

- [ ] **Step 1: Run the full Rust + Rue suites**

Run: `cd core && cargo test 2>&1 | grep "test result:"`
Expected: all `ok`; binaries: adversarial 13, builders 7, exploits 18, redteam 5, roundtrip 1, layers 2 — 0 failed.
Run: `cd core && rue test puzzles/stream.rue 2>&1 | grep -c "Running test"`
Expected: `4`.

- [ ] **Step 2: Confirm the on-chain hash is unchanged**

Run: `cd core && cat puzzles/stream.rue.hash`
Expected: `0x39ec8ca9b00348fe658c78d390032921f989ae3a696d5578c3866c6a803c5046` (unchanged — the refactor never touched the puzzle).

- [ ] **Step 3: Update `STATUS.md` Layout section**

In the `## Layout` code block, update the `core/` tree to show the new module structure:

```
│   ├── src/
│   │   ├── layers/{cat,owner,clawback,stream}.rs   # one file per puzzle boundary
│   │   ├── composition/{puzzle,spend,discovery}.rs # the only place layers compose
│   │   ├── constants.rs · assets.rs · dto.rs · error.rs · info.rs (shim) · spend.rs (shim) · wasm.rs
```

And add one line under the on-chain/Rust-core section noting the driver is now layer-composed (`CatLayer<StreamLayer>`), each layer independently auditable.

- [ ] **Step 4: Commit**

```bash
git add STATUS.md
git commit -m "docs: STATUS reflects layer-composed driver structure"
```

---

## Self-review checklist (run before handoff)

- **Spec coverage:** layers/{cat,owner,clawback,stream} (Tasks 1–2), composition/{puzzle,spend,discovery} (Tasks 3–4), AnnuityInfo→StreamLayer alias (Task 1), re-export facade (Tasks 1–3), composed discovery (Task 4), regression tests (Task 1), behavior oracle = unmodified suite (every task), hash unchanged (Task 5). All spec sections covered.
- **No placeholders:** the only "move verbatim" steps reference code that already exists at named paths; all new code (Layer impl, modules, facade, tests) is shown in full.
- **Type consistency:** `StreamLayer` field `owner_puzzle_hash`, inherent `curried_puzzle` (renamed from `construct_puzzle`), trait `construct_puzzle` delegating to it, `inner_puzzle_hash`, alias `AnnuityInfo = StreamLayer` — consistent across Tasks 1–4. `CatLayer::<StreamLayer>::parse_*` used identically in Task 1 test and Task 4.
```
