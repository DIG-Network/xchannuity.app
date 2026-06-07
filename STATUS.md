# Xchannuity — Implementation Status

Implementation of [`docs/whitepaper.md`](docs/whitepaper.md): a transferable, tradable
streamed-CAT annuity on Chia. On-chain logic is **Rue** (compiled to CLVM); the
off-chain core is Rust → WASM; the dApp is Next.js (static export).

## Layout

```
xchannuity.app/
├── Rue.toml                         # pins rue-cli 0.8.4, entrypoint = core/puzzles
├── core/                            # Rust crate `xchannuity-core` (chia-sdk 0.33 sub-crates, WASM-safe)
│   ├── Rue.toml                     # same pin, entrypoint = puzzles (for `rue` run from core/)
│   ├── puzzles/
│   │   ├── stream.rue               # the annuity puzzle (claim/transfer/clawback/offer)
│   │   ├── stream.rue.hex           # compiled CLVM (rue 0.8.4 build, committed)
│   │   └── stream.rue.hash          # tree hash 39ec8ca9…5046 (committed)
│   ├── src/
│   │   ├── layers/             # one file per puzzle boundary, auditable in isolation:
│   │   │   ├── cat.rs          #   AUDITED: SDK CAT re-export (no custom logic)
│   │   │   ├── owner.rs        #   AUDITED: owner-auth StreamSolution builders (StandardLayer/settlement)
│   │   │   ├── clawback.rs     #   CUSTOM: issuer mode-23 message + nil-owner clawback solution
│   │   │   └── stream.rs       #   CUSTOM: StreamLayer = curried state + math + `impl Layer`
│   │   ├── composition/        # the only place layers assemble:
│   │   │   ├── puzzle.rs       #   layers → coin puzzle hashes (CatLayer<StreamLayer>)
│   │   │   ├── spend.rs        #   layers → create/claim/transfer/clawback/offer bundles
│   │   │   └── discovery.rs    #   parse parent spend via CatLayer<StreamLayer> → live coin
│   │   ├── {constants,assets,dto,error,wasm}.rs
│   │   ├── lib.rs              # re-export facade: crate::builders/discovery + AnnuityInfo=StreamLayer
│   │   └── {info,spend}.rs     # compat shims re-exporting from layers/
│   └── tests/{roundtrip,adversarial,builders,exploits,redteam,layers}.rs
└── app/                            # Next.js 15 static-export dApp (cXCH pattern)
    ├── next.config.ts · tsconfig.json · package.json
    └── app/{layout,page}.tsx, app/lib/{wasm,walletconnect,flow}.ts, app/components/Landing.tsx
```

## Implemented & VERIFIED

### On-chain puzzle (`stream.rue`) — compiles (rue 0.8.4), mod hash `39ec8ca9…5046`
- Five curried args, in puzzle order: `[mod_hash, clawback_ph, end_time, last_payment_time, owner_hash]`.
  Ownership is mutable — re-curry under a new `owner_hash` to transfer.
- Modes: **CLAIM** (owner-authorized), **TRANSFER** (plain + offer), **CLAWBACK** (issuer).
- **Auth model:** CLAIM/TRANSFER authorize by REVEALING + RUNNING the owner inner p2 in the
  solution (its `AGG_SIG_ME` is enforced inside the revealed puzzle; `run_owner` checks
  `tree_hash(reveal) == owner_hash` first). Only **CLAWBACK** uses a `RECEIVE_MESSAGE` mode-23
  message from the curried `clawback_ph` (owner reveal not required). The clawback message body is
  `sha256(CLAWBACK_TAG ++ my_amount ++ pt)`, bound to this coin via `RECEIVER_COIN` so it can't be
  replayed.
- Security properties: time clamped to `[last, end]`; permanent annuities (`clawback_ph == nil`)
  can never be clawed back; clawback `ASSERT_BEFORE_SECONDS_ABSOLUTE(pt)` guarantees the owner at
  least their now-vested share; TRANSFER re-wraps every continuation as `STREAM<new_owner>`
  (value can never become liquid CAT, vesting window + `clawback_ph` preserved).
- **Hardening (this pass):** CLAIM now *raises* on any owner-directed `CREATE_COIN`
  (`forbid_create_coins`) instead of silently stripping it — this closes the
  TRANSFER→CLAIM solution-malleability grief (a watcher can't rewrite the unsigned `mode` param
  of a published spend), blocks any liquid-escape attempt during a claim, and makes a coin parked
  at `OFFER_MOD` unspendable in claim mode. Added explicit degenerate-window guard (`end <= last`
  raises) in claim + clawback as defense-in-depth over the implicit div-by-zero.
- 4 in-puzzle `test fn`s pass (`rue test`): exact condition sets per mode.

### Rust core (`xchannuity-core`) — `cargo build` + `wasm-pack build` clean
- **Layer-composed:** the annuity coin is `CatLayer<StreamLayer>` via the SDK `Layer` trait.
  Each puzzle boundary is its own auditable module under `src/layers/` (SDK-backed layers are
  thin re-exports; the custom `stream.rs` holds all bespoke logic); `src/composition/` is the
  only place layers assemble (puzzle hashes / spend bundles / discovery). `StreamLayer` carries
  the curried state + vesting math + `impl Layer`; `AnnuityInfo` is an alias for it.
- `StreamLayer` mirrors the puzzle; `inner_puzzle_hash` agrees byte-for-byte (proven by round-trip
  test + the `layers.rs` construct-vs-curry-hash + CatLayer<StreamLayer> parse round-trip guards).
- `composition/spend.rs`: the `build_*` flows compose owner-auth + stream + CAT into spend bundles.
- `wasm.rs`: `stream_puzzle_hash_hex`, `protocol_fee_bps`, `annuity_inner_puzzle_hash`,
  `annuity_cat_puzzle_hash`, `claimable_now`, `aggregate_signatures`.
- WASM-safe: chia-sdk **sub-crates** (`chia-sdk-driver/types/utils` 0.33), not the umbrella crate.

### Tests — `cargo test` → 44 pass (+ 4 `rue test`)
- `roundtrip.rs` (1): runs the curried puzzle in CLVM; outputs match the Rue reference (layout + vesting math).
- `adversarial.rs` (13): on the `chia-sdk-test` simulator (real CLVM + BLS).
- `builders.rs` (7): allow-list guard rejects unsupported assets; create→claim→transfer end-to-end
  and open-offer fill through the actual `build_*` functions, signed + pushed on the simulator.
- `exploits.rs` (18): credential-derived OWNER/ATTACKER drain attempts — ownership-layer + offer
  vectors. Includes both malleability guards: `claim_signature_cannot_be_repurposed_as_a_transfer_drain`
  (CLAIM→TRANSFER blocked by CAT conservation) and `transfer_authorization_cannot_be_repurposed_as_a_claim`
  (TRANSFER→CLAIM blocked by `forbid_create_coins`), plus `clawback_in_the_past_is_rejected`,
  `clawback_with_a_bare_time_message_is_rejected`, `unknown_mode_is_rejected`, and degenerate-window guards.
- `redteam.rs` (5): round-2 angles not covered above — CAT **supply integrity** through the stream
  re-wrap (`transfer_cannot_inflate_cat_supply`, `transfer_cannot_melt_and_pocket_value`), claim-side
  laundering (`claim_continuation_preserves_clawback_and_window`), and offer economic integrity
  (`offer_taker_underpaying_xch_is_rejected`, `offer_taker_redirecting_xch_to_self_is_rejected`).

Authoritative threat → guard → test map. Every attack row is REJECTED by consensus (real
CLVM + BLS on the `chia-sdk-test` simulator); honest baselines SUCCEED. Test names are the
actual `cargo test` names (`adversarial.rs` = adv, `exploits.rs` = exp, `builders.rs` = bld,
`redteam.rs` = rt).

**Honest baselines (must SUCCEED):**

| Test | Result |
|---|---|
| honest_claim_pays_only_the_recipient (adv) | ✅ 50 to recipient, 50 continuation |
| honest_transfer_moves_ownership_to_the_new_recipient (adv) | ✅ whole annuity re-wrapped under new owner |
| honest_clawback_splits_accrued_and_remainder (adv) | ✅ 50 recipient / 50 issuer |
| baseline_owner_claims_their_vested_share (exp) | ✅ half-term → half vested |

**Owner / buyer attacks (must FAIL):**

| Test | Threat | Guard |
|---|---|---|
| owner_cannot_claim_unvested_future_value (adv) | claim future value | ASSERT_SECONDS_ABSOLUTE(pt) + time clamp |
| lying_about_coin_amount_fails (adv) | inflate split | ASSERT_MY_AMOUNT + CAT conservation |
| transfer_cannot_strip_the_stream_wrapper (adv) | escape to liquid CAT | `wrap_outputs` re-wraps every CREATE_COIN |
| owner_cannot_launder_away_clawback_via_transfer (exp) | drop clawback authority | continuation re-curries the same `clawback_ph` |
| transfer_cannot_accelerate_vesting (exp) | reset/extend vesting | `wrap_outputs` preserves `end_time` + `last` |

**Issuer attacks (must FAIL):**

| Test | Threat | Guard |
|---|---|---|
| permanent_annuity_cannot_be_clawed_back (adv) | claw back a permanent annuity | raise when `clawback_ph == nil` |
| clawback_in_the_past_is_rejected (exp) | shortchange recipient at a past time | ASSERT_BEFORE_SECONDS_ABSOLUTE(pt) → pt must be future |
| attacker_cannot_clawback_with_a_non_issuer_key (exp) | clawback from a non-authority coin | RECEIVE_MESSAGE sender bound to `clawback_ph` |

**Outsider / watcher attacks (must FAIL):**

| Test | Threat | Guard |
|---|---|---|
| wrong_owner_reveal_is_rejected (adv) | reveal a different owner puzzle | `run_owner` aborts on `tree_hash(reveal) != owner_hash` |
| claim_without_owner_signature_fails (adv) | claim with no authorization | revealed p2's AGG_SIG_ME unsatisfied |
| attacker_cannot_claim_with_their_own_p2 (exp) | claim by currying-around with own p2 | owner-hash mismatch raises |
| attacker_cannot_claim_by_revealing_owner_puzzle_without_owner_key (exp) | correct reveal, attacker signature | AGG_SIG_ME over OWNER key unsatisfied |
| outsider_cannot_forge_a_transfer_to_steal_the_annuity (adv) | forge a transfer | owner reveal + signature required |
| attacker_cannot_transfer_annuity_to_themselves (exp) | transfer to self | owner-hash / signature mismatch |
| transfer_destination_cannot_be_rewritten_by_a_watcher (adv) | rewrite the new owner | new owner is inside the owner's SIGNED CREATE_COIN |

**Solution-malleability — unsigned outer params `mode`/`payment_time` (must FAIL):**

| Test | Threat | Guard |
|---|---|---|
| claim_signature_cannot_be_repurposed_as_a_transfer_drain (exp) | flip CLAIM→TRANSFER | empty owner conds → nothing to wrap → CAT conservation fails |
| transfer_authorization_cannot_be_repurposed_as_a_claim (exp) | flip TRANSFER→CLAIM | **`forbid_create_coins` raises on the stray CREATE_COIN** *(hardened this pass)* |
| unknown_mode_is_rejected (exp) | junk mode (no silent fall-through) | explicit `raise "unknown mode"` for mode ∉ {0,1,2} |
| clawback_with_a_bare_time_message_is_rejected (exp) | replay a generic issuer message | body = `sha256(TAG ++ my_amount ++ pt)`, bare int won't match |

**Offer attacks (must FAIL):**

| Test | Threat | Guard |
|---|---|---|
| offer_transfer_without_settlement_payment_fails (adv) | take an offer without paying | ASSERT_PUZZLE_ANNOUNCEMENT of the settlement |
| offer_park_cannot_confirm_without_the_xch_payment (exp) | confirm park spend with no XCH | settlement announcement assert unsatisfied |
| parked_settlement_coin_cannot_be_drained_as_liquid_cat_via_claim (adv) | claim a coin parked at OFFER_MOD | `forbid_create_coins` raises (settlement always creates coins) |
| clawbackable_annuity_cannot_be_offered (exp) | list a clawbackable annuity (rug the taker) | builder + `parse_offer` reject (`ClawbackableNotSellable`) |
| offer_taker_underpaying_xch_is_rejected (rt) | pay the maker less than asked | settlement announcement commits the exact `xch_amount` |
| offer_taker_redirecting_xch_to_self_is_rejected (rt) | route the maker's XCH to self | settlement announcement commits the payee puzzle hash |

**CAT supply integrity — re-wrap can't mint or melt (must FAIL):**

| Test | Threat | Guard |
|---|---|---|
| transfer_cannot_inflate_cat_supply (rt) | direct `amount > my_amount` to mint CAT | CAT conservation ring (output > input rejected) |
| transfer_cannot_melt_and_pocket_value (rt) | direct `amount < my_amount` to skim liquid | outputs must sum to input (no TAIL melt magic) |
| claim_continuation_preserves_clawback_and_window (rt) | launder clawback/window via CLAIM | continuation re-wraps with same `clawback_ph` + `end_time` |

**Construction / robustness guards (must FAIL or be safe):**

| Test | Threat | Guard |
|---|---|---|
| create_rejects_nonpositive_vesting_window (exp) | mint `end <= start` (locks funds) | builder rejects at construction |
| create_guard_rejects_unsupported_asset (bld) | mint a non-allow-listed CAT | allow-list (`Error::UnsupportedAsset`) |
| claimable_does_not_panic_on_degenerate_window (exp) | div-by-zero in public claimable math | returns 0 (matches JS guard) |
| large_annuity_vesting_matches_onchain_no_u64_overflow (exp) | u64 overflow → driver disagrees with chain | u128 intermediate; verified against on-chain coin |

Puzzle-level defense-in-depth (this pass): CLAIM and CLAWBACK both `raise` on a degenerate
`end <= last` window rather than relying on the implicit CLVM div-by-zero abort.

**Audited residual (accepted, value-safe):** in CLAIM the unsigned `payment_time` solution
param is malleable by a watcher, but it is provably harmless — both the payout and the
continuation are hardcoded to `owner_hash`, and `ASSERT_SECONDS_ABSOLUTE(pt)` caps `pt` at the
current time, so the worst a third party can do is make the owner realize their *already-vested*
share (the rest keeps streaming). No value leaves the owner and no future vesting is forfeited,
so this is intentionally not constrained. Every other path that could move or split value
(`mode`, `my_amount`, the transfer destination, the clawback amount/time) is bound by a
signature, an `ASSERT_MY_AMOUNT`, the re-wrap, or the mode-23 message body.

**Offer atomicity caveat (operational, not a puzzle flaw):** an offered annuity is parked at the
keyless `SETTLEMENT_PAYMENT_HASH`, so anyone could route the parked coin. Safety comes from
ATOMICITY — the maker's park spend asserts the XCH settlement announcement, so the parked coin is
never created without the payment + the taker's routing in the *same* bundle. `build_take_offer`
always assembles all three together; a caller must never broadcast a bundle that creates the
parked coin while leaving it unspent.

Each attack differs from a *passing* honest flow by exactly the attacked guard, so the
rejections are attributable to the security mechanism — not incidental construction errors.
The puzzle is not a delegated-conditions puzzle: the only attack surface is the 5 solution
params (`mode`, `my_amount`, `payment_time`, `owner_puzzle`, `owner_solution`) — all exercised
here, including the malleability of the two that fall outside the owner's signed scope.

### dApp (`app/`) — built out + runs (`npm run dev` → :3000, `npm run build` → static `out/`)
- `next.config.ts`: `output: "export"` + `asyncWebAssembly`. Imports `@wasm` → `wasm-pkg/`.
- `lib/walletconnect.tsx`: `optionalNamespaces`, 60s request timeout, `useSage`.
- `lib/wasm.ts`: `ensureWasm` gate + re-exports (helpers + `build_create_annuity/claim/clawback/transfer` + `supported_assets` + address helpers).
- `lib/flow.ts`: sign-and-broadcast (Sage partialSign → aggregate → coinset push). `lib/coinset.ts`: node reads. `lib/tokens.ts`: the 4 allow-listed CATs. `lib/format.ts` / `lib/storage.ts`.
- `page.tsx`: landing-on-connect swap. Connected view: **CreatePanel** (4-token picker, term presets, permanent toggle, live 0.5%-fee + net + vesting-rate preview → `build_create_annuity`) and **AnnuityCard** (live ticking claimable via `claimable_now`, vesting bar, countdown, permanent/clawbackable badge, Claim/Transfer/Sell actions → `build_claim`/`build_transfer`).
- WASM-safe deps verified: builds to wasm32 (clang + getrandom cfg, see below).

### Verified denomination allow-list (4 CATs, cross-checked dexie + spacescan)
`assets.rs` + `wasm::supported_assets` + `tokens.ts`, decimals 3 each:
wUSDC `bbb51b…742b9e`, wUSDC.b `fa4a18…b7a99d`, BYC (Bytecash) `ae1536…606eac`, cMOJO `8808ca…21c9ba`.
`build_create` rejects any non-allow-listed asset (`Error::UnsupportedAsset`, tested).
Note: cMOJO is brand-new (issued 2026-06-05, ~3 holders, not on dexie) — id/symbol confirmed, low liquidity.

## Build & test

```bash
# puzzle  (rue-cli 0.8.4 — must match the pin in Rue.toml)
rue build  core/puzzles/stream.rue --hex --hash
rue test   core/puzzles/stream.rue

# core + adversarial + exploit tests
cd core && cargo test

# wasm package for the dApp — VERIFIED: emits app/wasm-pkg/xchannuity_core_bg.wasm (153 KB)
# Prereq: LLVM/clang on PATH (chia-bls/blst + secp compile C → wasm32). On this box:
#   export CC_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/clang.exe"
#   export AR_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/llvm-ar.exe"
# getrandom 0.3 backend handled by core/.cargo/config.toml.
wasm-pack build --release --target web --out-dir ../app/wasm-pkg

# dApp
cd app && npm install && npm run build:wasm && npm run build
```

## Remaining integration work

1. **Robust on-chain coin tracking for claim/transfer.** `AnnuityCard` resolves the current coin via
   coinset and uses a simplified lineage proof (`parent_inner_puzzle_hash = recipient`) that is correct for
   a freshly-created (never-claimed) annuity but not after claims advance `last_payment_time`. A production
   build needs the coin-spend walk (à la `streaming-ui`'s `stream/[id]`) to follow lineage and track state.
   Builder construction itself is proven in `tests/builders.rs`.
2. **Offer build/take** (`build_sell_offer` / `build_take_offer` wasm + `chia-sdk-driver` settlement layer +
   `offer1…` serialization). The puzzle side (`settlement_id` assertion) is done and tested; the Sell button
   is currently a stub.
3. **Verify Sage response shapes**: `chip0002_getAssetCoins` lineage/p2 field names and
   `chip0002_signCoinSpends` casing against a live Sage build (mapped best-effort in `CreatePanel`/`AnnuityCard`).
4. **Config**: set `PROTOCOL_FEE_PUZZLE_HASH` (fee destination) before launch.
5. **Live validation**: testnet11 end-to-end with Sage over WalletConnect (simulator coverage is in place).

## Run it

```bash
cd app && npm install
npm run build:wasm     # needs LLVM/clang on PATH (see wasm prereq above)
npm run dev            # http://localhost:3000   (or: npm run build → static out/)
```
