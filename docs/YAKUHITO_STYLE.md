# Yakuhito Style Guide

A practical guide for making the Xchannuity codebase match Yakuhito's structure, naming,
and idioms, derived from analyzing:

- `Yakuhito/streaming` — the streamed-CAT puzzle + a thin CLI driver (testnet tool)
- `Yakuhito/streaming-ui` — the Next.js frontend ("Streaming Dashboard")
- `xch-dev/chia-wallet-sdk` — where the *real* streamed-CAT driver lives
  (`StreamLayer`, `StreamedAsset`, `StreamingPuzzleInfo`). This is the canonical
  reference for his Rust/`Layer`-trait conventions.
- `Yakuhito/slot-machine` — broader Rust/CLI conventions (CATalog/XCHandles).

The single most important structural fact: **Yakuhito does not keep puzzle drivers in the
app repo.** Puzzle layers and primitives live *upstream in `chia-wallet-sdk`* and are
re-exported through `chia_wallet_sdk::driver`. The app repo (`streaming`) is a thin CLI
that *consumes* them. Where we cannot upstream, we mirror the SDK's module shape locally.

---

## 1. Rust Driver Conventions

### 1.1 The two-file split: Layer vs Primitive

Every puzzle is modeled as **two artifacts in two directories**:

| Concern | Directory | File | Example types |
|---|---|---|---|
| **Layer** — CLVM curry/solution shape + `Layer` trait impl | `src/layers/` | `streaming_layer.rs` | `StreamLayer`, `StreamPuzzle1stCurryArgs`, `StreamPuzzle2ndCurryArgs`, `StreamPuzzleSolution` |
| **Primitive** — high-level coin object with `new`/`spend`/`from_parent_spend`/`child` | `src/primitives/` | `streamed_asset.rs` | `StreamedAsset`, `StreamingPuzzleInfo` |

One puzzle → one `*_layer.rs` and (if it's a standalone coin) one primitive file. File
names are **snake_case singular nouns** matching the type (`streaming_layer.rs`,
`streamed_asset.rs`, `cat_layer.rs`, `action_layer.rs`).

### 1.2 Modeling a Layer

A layer is a small `Copy` struct of the *high-level* curried values, plus separate
`#[clvm(curry)]` arg structs that mirror the **exact** CLVM layout (including multi-curry).

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamLayer {
    pub recipient: Bytes32,
    pub clawback_ph: Option<Bytes32>,
    pub end_time: u64,
    pub last_payment_time: u64,
}

#[derive(ToClvm, FromClvm, Debug, Clone, Copy, PartialEq, Eq)]
#[clvm(curry)]
pub struct StreamPuzzle1stCurryArgs {
    pub recipient: Bytes32,
    pub clawback_ph: Option<Bytes32>,
    pub end_time: u64,
}

#[derive(ToClvm, FromClvm, Debug, Clone, Copy, PartialEq, Eq)]
#[clvm(curry)]
pub struct StreamPuzzle2ndCurryArgs {
    pub self_hash: Bytes32,
    pub last_payment_time: u64,
}

#[derive(ToClvm, FromClvm, Debug, Clone, PartialEq, Copy, Eq)]
#[clvm(list)]
pub struct StreamPuzzleSolution {
    pub my_amount: u64,
    pub payment_time: u64,
    pub to_pay: u64,
    #[clvm(rest)]
    pub clawback: bool,
}
```

**Naming rules (verbatim from his code):**

- Curry-arg structs: `<Puzzle>Args` or, for multi-curry puzzles, `<Puzzle>1stCurryArgs` /
  `<Puzzle>2ndCurryArgs`. Field order **must** match puzzle order.
- Solution struct: `<Puzzle>Solution` (e.g. `StreamPuzzleSolution`), `#[clvm(list)]`,
  with `#[clvm(rest)]` on the final tail field.
- Curry args derive `#[clvm(curry)]`; solutions derive `#[clvm(list)]`.
- Layer struct is `Copy` and holds **decoded** values (`u64`, `Bytes32`,
  `Option<Bytes32>`), not raw atoms.

**Mod reveal + hash** live as module constants and a `Mod` impl, not free helpers:

```rust
pub const STREAM_PUZZLE: [u8; 587] = hex!("ff02ffff01ff02...");
pub const STREAM_PUZZLE_HASH: TreeHash = TreeHash::new(hex!(
    "e0e312a612aa14357e225c0dc21d351610c2377efab14406da6c7424d48feff8"
));

impl Mod for StreamPuzzle1stCurryArgs {
    fn mod_reveal() -> Cow<'static, [u8]> {
        Cow::Borrowed(&STREAM_PUZZLE)
    }
    fn mod_hash() -> TreeHash {
        STREAM_PUZZLE_HASH
    }
}
```

- Const names: `SCREAMING_SNAKE`, `<PUZZLE>_PUZZLE` for the reveal bytes and
  `<PUZZLE>_PUZZLE_HASH` for the `TreeHash`.
- The reveal is typed `[u8; N]` (exact length baked into the type) via `hex!()`.
- Hash is a `TreeHash::new(hex!( ... ))`.

### 1.3 Implementing the chia-sdk `Layer` trait

The trait (from `chia-sdk-driver/src/layer.rs`):

```rust
pub trait Layer {
    type Solution;
    fn parse_puzzle(allocator: &Allocator, puzzle: Puzzle) -> Result<Option<Self>, DriverError>
        where Self: Sized;
    fn parse_solution(allocator: &Allocator, solution: NodePtr) -> Result<Self::Solution, DriverError>;
    fn construct_puzzle(&self, ctx: &mut SpendContext) -> Result<NodePtr, DriverError>;
    fn construct_solution(&self, ctx: &mut SpendContext, solution: Self::Solution)
        -> Result<NodePtr, DriverError>;
    // construct_spend is provided (calls construct_solution + construct_puzzle).
}
```

Conventions when implementing:

- `type Solution = StreamPuzzleSolution;` — the layer's solution struct.
- `construct_puzzle` curries via the `SpendContext` and caches:
  `let puzzle_1st_curry = ctx.curry(StreamPuzzle1stCurryArgs::new(...))?;` then composes
  the 2nd curry. **Use `ctx.curry(...)` and `ctx.alloc(...)`**, never hand-roll currying.
- `parse_puzzle` returns `Ok(None)` (not an error) when the puzzle isn't a match — this is
  how primitives probe alternative layers. Use `let ... else { return Ok(None); };`:
  ```rust
  let Ok(program_2nd_curry) =
      CurriedProgram::<NodePtr, NodePtr>::from_clvm(allocator, puzzle_2nd_curry.curried_ptr)
  else { return Ok(None); };
  ```
  But return a real error for a *structural* mismatch you do care about:
  ```rust
  if puzzle_1st_curry.mod_hash != STREAM_PUZZLE_HASH {
      return Err(DriverError::InvalidModHash);
  }
  ```
- Errors are always `DriverError` variants (`InvalidModHash`, etc.) — never `String`,
  never `unwrap()` in driver code.

### 1.4 The Primitive: `new`/`spend`/`from_parent_spend`/`child`

`StreamedAsset` is the model. A primitive is a plain `#[must_use]` struct holding the coin
state, with an `info` field carrying the high-level params:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
#[must_use]
pub struct StreamedAsset {
    pub coin: Coin,
    pub asset_id: Option<Bytes32>,
    pub proof: Option<LineageProof>,
    pub info: StreamingPuzzleInfo,
}
```

Method conventions (all observed verbatim):

- **Constructors are named by variant**, not `new` only:
  `StreamedAsset::cat(coin, asset_id, proof, info)` and `::xch(...)`. The high-level params
  struct uses `StreamingPuzzleInfo::new(recipient, clawback_ph, end_time, last_payment_time)`.
- **`spend(&self, ctx, payment_time, clawback) -> Result<(), DriverError>`** — builds puzzle
  + solution and **inserts the `CoinSpend` into the `ctx`** (returns `()`, side-effecting on
  the context). Internally calls `construct_puzzle` + `construct_solution`.
- **`construct_puzzle` / `construct_solution`** also exist on the primitive (mirroring the
  layer) and delegate to `self.info.into_layer()`:
  ```rust
  pub fn construct_puzzle(&self, ctx: &mut SpendContext) -> Result<NodePtr, DriverError> {
      let inner_layer = self.info.into_layer();
      if let Some(asset_id) = self.asset_id {
          CatLayer::new(asset_id, inner_layer).construct_puzzle(ctx)
      } else {
          inner_layer.construct_puzzle(ctx)
      }
  }
  ```
- **`from_parent_spend(ctx, parent_spend) -> Result<(Option<Self>, bool, u64), DriverError>`**
  — the discovery/parse entrypoint. Returns a **tuple**: `(next_state, clawbacked,
  paid_amount_if_clawback)`. `next_state` is `None` when the stream ended/was clawed back.
  It probes layers in order (`CatLayer<StreamLayer>` then bare `StreamLayer`) using
  `StreamLayer::parse_puzzle` and returns `None` on no match.
- **`inner_puzzle_hash(&self) -> TreeHash`** delegates: `self.into_layer().puzzle_hash()`.
- The params struct exposes domain math as methods: `amount_to_be_paid(amount, time)`,
  `from_memos(&memos)`, `into_layer()`.

### 1.5 `SpendContext` usage

- Always thread `&mut SpendContext` (named `ctx`) as the first non-`self` arg.
- Allocate with `ctx.alloc(&value)`, curry with `ctx.curry(args)`, extract with
  `ctx.extract::<T>(ptr)` (e.g. `ctx.extract::<CatSolution<StreamPuzzleSolution>>(parent_solution)?`).
- `spend()` methods push into `ctx` rather than returning `CoinSpend`s directly; the CLI
  later pulls them out (`ctx.take()` style).

### 1.6 Naming, doc-comments, derives

- Functions/methods/fields: `snake_case`. Types: `UpperCamel`. Consts: `SCREAMING_SNAKE`.
- Type prefixes track the puzzle name: `Stream*`, `Cat*`, `Action*`.
- Standard derive line for CLVM structs:
  `#[derive(ToClvm, FromClvm, Debug, Clone, Copy, PartialEq, Eq)]` then the `#[clvm(...)]`.
- Doc comments are terse `///` one-liners on public items; module headers are minimal.
  (Note: Yakuhito's own SDK comments are **sparse**. Our codebase is much more heavily
  documented — see §5 mapping; keep our docs but match his *structure*.)

### 1.7 Tests

- Tests live **inline at the bottom of the primitive file**, in `#[cfg(test)] mod tests`,
  not in a separate `tests/` tree (that's the SDK convention). `streamed_asset.rs` contains
  its own end-to-end launch→spend→clawback test.
- Tests drive a real simulator + `SpendContext`, asserting full struct equality:
  ```rust
  let (new_streamed_asset, clawback, _paid_amount_if_clawback) =
      StreamedAsset::from_parent_spend(&mut ctx, &streamed_asset_spend)?;
  assert_eq!(streamed_asset, StreamedAsset { coin: ..., info: StreamingPuzzleInfo::new(...), .. });
  ```
- Test fn names are plain verbs: `fn test_streamed_cat()`; unused tuple fields prefixed `_`.

---

## 2. Puzzle Conventions

### 2.1 Chialisp vs Rue, file layout

Yakuhito's public streaming puzzle is **Chialisp** (`puzzles/stream.clsp`), compiled to a
committed `puzzles/stream.clsp.hex`, with shared includes in `include/` (`condition_codes.clsp`,
`curry.clsp`). A `main.sym` symbol file is also committed.

```
puzzles/stream.clsp        # source
puzzles/stream.clsp.hex    # compiled, committed alongside
include/condition_codes.clsp
include/curry.clsp
main.sym
```

> We author in **Rue** (`puzzles/stream.rue`), not Chialisp — this is a deliberate
> divergence locked in by project constraints. Keep our Rue source, but **commit the
> compiled hex next to it** the way he commits `.clsp.hex`, and keep includes/helpers in
> their own files.

### 2.2 Puzzle header + structure (`stream.clsp`)

```lisp
; stream.clsp by yakuhito

;; Used to 'stream' CATs/XCH to a user over time.

(mod (
    RECIPIENT
    CLAWBACK_PH
    END_TIME
    ; 2nd curry
    SELF_HASH
    LAST_PAYMENT_TIME
    my_amount
    payment_time
    to_pay .
    clawback
)
    (include condition_codes.clsp)
    (include curry.clsp)
    ...
```

- **First comment line:** `; <file> by yakuhito`.
- **Curried args are `SCREAMING_SNAKE`**, solution args are `snake_case`. The boundary
  between curry rounds is marked with a `; 2nd curry` comment.
- The solution's final dotted tail (`to_pay . clawback`) mirrors the `#[clvm(rest)]` field.
- Doc comment uses `;;` (double), inline notes use `;` (single).

### 2.3 Mode / condition naming

- Modes are small integer constants. In the SDK these surface as a `bool clawback` rest
  field; in richer puzzles (ours) they're named integer modes (`CLAIM`/`TRANSFER`/`CLAWBACK`).
- Reuse SDK / chia helper names for conditions rather than inventing: `CREATE_COIN`,
  `ASSERT_MY_AMOUNT`, etc. via the `condition_codes.clsp` include.

---

## 3. Frontend Conventions (`streaming-ui`)

### 3.1 Stack

- **Next.js 15 (App Router) + React 19 + TypeScript**, Tailwind v4 (`@tailwindcss/postcss`).
- **Redux Toolkit** (`@reduxjs/toolkit` + `react-redux`) for state — *not* React Context.
- **WalletConnect** (`@walletconnect/sign-client`) for wallet (Sage) connection.
- `chia-wallet-sdk-wasm` for all puzzle/driver logic in the browser (client-only dApp —
  README: *"a demonstration of the chia-wallet-sdk + coinset + Sage stack for client-only
  dApps"*).
- `qrcode.react` for the WalletConnect pairing QR, `react-hot-toast` for notifications.

### 3.2 Folder structure (verbatim)

```
app/
  layout.tsx
  page.tsx                      # landing + dashboard
  globals.css
  favicon.ico
  StoreProvider.tsx             # wraps app in Redux <Provider>
  components/
    Navbar.tsx
    Footer.tsx
    Modal.tsx
    WalletConnector.tsx         # the connect-flow UI (QR, sessions)
    WalletInitializer.tsx       # mounts/rehydrates wallet session on load
    NewStreamForm.tsx           # the primary action form
  lib/
    WalletConnect.ts            # the WalletConnect client wrapper/class
    walletConnectInstance.ts    # singleton sign-client instance
  redux/
    store.ts
    hooks.ts                    # typed useAppDispatch / useAppSelector
    stream/[id]/page.tsx        # dynamic per-stream detail route
  redux/walletSlice.ts          # wallet connection state slice
```

(Everything lives under `app/`; no top-level `src/`. `public/` holds the default svgs.)

### 3.3 Component & state conventions

- Components: `PascalCase.tsx`, one component per file, named exactly for their role
  (`WalletConnector`, `WalletInitializer`, `NewStreamForm`, `Modal`).
- The wallet lifecycle is split into **two** components: `WalletConnector` (UI/connect
  action) and `WalletInitializer` (mount-time session rehydrate). Mirror this split.
- Redux: a single `walletSlice` holds connection state; typed hooks in `redux/hooks.ts`;
  `StoreProvider.tsx` is a thin `'use client'` wrapper around `<Provider store={store}>`.
- The WalletConnect client is a class in `lib/WalletConnect.ts` with a **singleton
  instance** module (`lib/walletConnectInstance.ts`) — connection logic is not inlined in
  components.
- Routing: landing/dashboard at `app/page.tsx`; per-entity detail at
  `app/stream/[id]/page.tsx` (dynamic segment named `[id]`).

### 3.4 Flow organization

- **Connect flow:** `WalletConnector` renders a `Modal` containing the QR
  (`qrcode.react`); on approval the session is stored in `walletSlice`.
- **Landing → app:** `page.tsx` conditionally renders the marketing/landing content vs the
  dashboard based on the wallet-connected selector from Redux.
- **Action flow:** `NewStreamForm` collects inputs, builds the spend via
  `chia-wallet-sdk-wasm`, and requests signing through the WalletConnect client.

---

## 4. General Mannerisms

- **README:** short. Title = product name (`# Streaming`, `## Streaming Dashboard`),
  one-line description, then a `## Testing` section that is literally a copy-pasteable CLI
  walkthrough (`cargo r --release launch <ARGS>`, `view`, `claim`, `clawback`). No badges,
  no architecture diagrams. Frontend README is ~2 sentences + a CHIP link.
- **Repo / crate naming:** lowercase, hyphenated, descriptive of the *thing*
  (`streaming`, `streaming-ui`, `slot-machine`). Crate `name` matches repo. `version =
  "0.1.0"`, `edition = "2021"`.
- **CLI verbs** are bare nouns/verbs: `launch`, `view`, `claim`, `clawback` (via `clap`
  derive). IDs are bech32-ish with a network prefix: `ts1…` testnet, `s1…` mainnet.
- **License:** MIT (1083-byte `LICENSE` in both repos). No per-file license headers — the
  only file header is the `; <file> by yakuhito` line in puzzles.
- **Recurring idioms / helper names to adopt:**
  - `u64_to_bytes` / `u64_to_atom` for CLVM-canonical u64 encoding.
  - `from_parent_spend` returning `(Option<Self>, …)` for discovery.
  - `into_layer()` to go from a params/info struct to its `Layer`.
  - `child` / `child_from_parent_spend` for "next coin in the lineage."
  - `*Info` / `*PuzzleInfo` for the high-level params struct; `*Layer` for the layer;
    `*Args` / `*CurryArgs` for curried structs; `*Solution` for solutions.
  - `#[must_use]` on primitive structs.
  - `Option<Bytes32>` for an optional clawback puzzle hash (nil → `None`).

---

## 5. Mapping: Our Current X → Yakuhito-style Y

Our core (`xchannuity-core/src/{info,builders,spend,discovery}.rs`) is already close in
spirit (decoded-value structs, `#[clvm(curry)]`/`#[clvm(list)]`, `construct_puzzle`,
`child_from_parent_spend`, `u64_to_atom`). The gaps are **module shape** and **trait
conformance**, not philosophy.

| Area | Our current state | Yakuhito-style target | Action |
|---|---|---|---|
| **Module layout** | Flat: `info.rs`, `builders.rs`, `spend.rs`, `discovery.rs` under one crate root | `src/layers/<puzzle>_layer.rs` + `src/primitives/<puzzle>.rs` split | Create `src/layers/stream_layer.rs` (curry/solution structs + `Layer` impl) and `src/primitives/annuity.rs` (the coin object). Keep `builders.rs` as the CLI-facing flow assembler. |
| **`StreamCurry`** (in `info.rs`) | Single `#[clvm(curry)]` struct: `mod_hash, clawback_ph, end_time, last_payment_time, owner_hash` | `StreamPuzzle1stCurryArgs` / `2ndCurryArgs` *if* the puzzle curries in two rounds; else `StreamArgs` | Rename `StreamCurry` → `StreamArgs` (or split into `1st`/`2nd` to match the `self_hash`/`last_payment_time` second-curry pattern our Rue `stream_hash` already implies). Drop the explicit `mod_hash` field if you adopt a `Mod` impl that supplies it. |
| **`StreamSolution<P,S>`** | Good — `#[clvm(list)]`, named modes | Keep, but name `StreamPuzzleSolution` to match his `<Puzzle>Solution` convention | Rename `StreamSolution` → `StreamPuzzleSolution`. Keep the generic `<P,S>` (his is non-generic only because reveal is curried; ours reveals owner puzzle, so generics are justified). |
| **`AnnuityInfo`** | High-level params struct with `recipient/clawback_ph/end_time/last_payment_time`, `new`, `inner_puzzle_hash`, `construct_puzzle`, `claimable`, `after_claim` | His `StreamingPuzzleInfo` (params) + an `into_layer()` | Rename `AnnuityInfo` → `StreamingPuzzleInfo` (or keep `AnnuityInfo` as the product name but add the method set). Add `fn into_layer(&self) -> StreamLayer` and `fn from_memos(&[Bytes]) -> Result<Option<Self>>`. `claimable` ↔ his `amount_to_be_paid`. |
| **No `Layer` impl** | `AnnuityInfo::construct_puzzle` is a free-standing method | A real `impl Layer for StreamLayer` with `type Solution`, `construct_puzzle`, `construct_solution`, `parse_puzzle`, `parse_solution` | Introduce `struct StreamLayer { recipient, clawback_ph, end_time, last_payment_time }` and `impl Layer for StreamLayer`. Move currying into `construct_puzzle`; move the discovery parse in `discovery.rs` into `StreamLayer::parse_puzzle`/`parse_solution`. |
| **No primitive object** | `discovery::Discovered { coin, asset_id, info, lineage_proof }` + free `child_from_parent_spend` | `StreamedAsset { coin, asset_id: Option, proof: Option, info }` with `cat()/xch()`, `spend()`, `from_parent_spend()`, `child()`, `inner_puzzle_hash()` | Rename `Discovered` → `Annuity` (or `StreamedAnnuity`), add `#[must_use]`, make `asset_id`/`proof` `Option`, move `child_from_parent_spend` to `Annuity::from_parent_spend(ctx, parent_spend) -> Result<(Option<Self>, bool, u64)>` returning his 3-tuple shape. |
| **Mode constants** | Duplicated: `MODE_CLAIM`/`MODE_TRANSFER` in `discovery.rs` *and* `constants.rs` | Single source of truth | Define once in `constants.rs` (or on the layer), import everywhere. |
| **Mod reveal/hash** | `constants::{stream_mod_hash, stream_mod_tree_hash, stream_puzzle_bytes}` fns | `const STREAM_PUZZLE: [u8; N]` + `const STREAM_PUZZLE_HASH: TreeHash` + `impl Mod` | Replace the helper fns with `pub const STREAM_PUZZLE: [u8; N] = hex!(...)` and `pub const STREAM_PUZZLE_HASH: TreeHash = TreeHash::new(hex!(...))`; `impl Mod for StreamArgs`. |
| **`spend` return** | `inner_spend` returns a `Spend` | His `spend()` pushes the `CoinSpend` into `ctx` and returns `()` | Optionally add a primitive `spend(&self, ctx, payment_time, mode)` that inserts into ctx, keeping `inner_spend` as the lower-level helper. |
| **Tests** | `tests/builders.rs` (separate integration tree) | Inline `#[cfg(test)] mod tests` in the primitive file driving the simulator | Keep integration tests, but add a primitive-level launch→spend round-trip test inside `primitives/annuity.rs` asserting full-struct equality (his pattern). |
| **Frontend (`app/app`)** | `components/`, `lib/`, `layout.tsx`, `page.tsx`, `globals.css` | Add `StoreProvider.tsx`, `redux/{store,hooks,walletSlice}.ts`, split `WalletConnector`/`WalletInitializer`, `Modal.tsx`, dynamic `stream/[id]/page.tsx` | Adopt Redux Toolkit (`walletSlice`) over ad-hoc state; put the WalletConnect singleton in `lib/walletConnectInstance.ts` and a class in `lib/WalletConnect.ts`; split connect UI from session rehydrate. |
| **Puzzle hex** | Rue source compiled separately | Commit `stream.rue` *and* the compiled hex next to it (his `*.clsp.hex` habit) | Commit `puzzles/stream.clsp.hex` (or equivalent) so the embedded reveal is auditable in-repo. |
| **README** | n/a / STATUS.md | Short title + one-liner + copy-pasteable CLI `## Testing` walkthrough; MIT `LICENSE` | Write a Yakuhito-style README: product name, one sentence, `launch/view/claim/clawback`-style CLI walkthrough. |

### Concrete rename cheat-sheet

```
StreamCurry            -> StreamArgs            (or StreamPuzzle1stCurryArgs / 2ndCurryArgs)
StreamSolution<P,S>    -> StreamPuzzleSolution<P,S>
AnnuityInfo            -> StreamingPuzzleInfo   (params)  + add into_layer(), from_memos()
AnnuityInfo::claimable -> amount_to_be_paid     (alias / rename)
discovery::Discovered  -> primitives::Annuity   (#[must_use], Option asset_id/proof)
child_from_parent_spend-> Annuity::from_parent_spend -> (Option<Self>, bool, u64)
(new struct)           -> StreamLayer + impl Layer for StreamLayer
constants::stream_mod_* fns -> const STREAM_PUZZLE / STREAM_PUZZLE_HASH + impl Mod
```

### Directory restructure (target)

```
xchannuity-core/src/
  lib.rs
  constants.rs            # STREAM_PUZZLE, STREAM_PUZZLE_HASH, MODE_*, fees
  error.rs                # Error/Result (keep)
  layers/
    mod.rs
    stream_layer.rs       # StreamLayer, StreamArgs, StreamPuzzleSolution, impl Layer, impl Mod
  primitives/
    mod.rs
    annuity.rs            # Annuity (StreamedAsset analog) + StreamingPuzzleInfo, inline tests
  builders.rs             # CLI/wasm flow assembly (launch/claim/transfer/clawback/offer)
  discovery.rs            # thin: delegates to StreamLayer::parse_puzzle + Annuity::from_parent_spend
  dto.rs / wasm.rs        # wasm edge (keep)
```
