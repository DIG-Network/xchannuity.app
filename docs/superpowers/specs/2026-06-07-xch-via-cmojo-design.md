# XCH Annuities via cMOJO (wrap/melt) — Design Spec

**Date:** 2026-06-07
**Scope:** dApp (`app/`) + integrating the prebuilt `cmojo-core` wasm. **No `xchannuity-core` Rust change, no on-chain puzzle change, no xchannuity wasm rebuild.**

## Goal

Present **XCH** (with the user's native XCH balance) as the headline denomination. Under the hood the annuity remains a `CAT<StreamLayer>` over the **cMOJO** asset (1:1 wrapped XCH). On **create**, wrap XCH → cMOJO and fund the annuity in one atomic bundle. On **claim**, claim the vested cMOJO, then a **second** signed transaction melts it → XCH. The word "cMOJO" never appears in the UI.

Decisions (resolved in brainstorming): keep the 3 stablecoins alongside XCH; create is **one atomic bundle**; claim **auto-prompts** the melt.

## Key architectural finding — compose at the JS/wasm seam

`cmojo-core` pins chia-protocol **0.26** / chia-sdk **0.27** / clvmr **0.14**; `xchannuity-core` is on chia-protocol **0.36.1** / chia-sdk-driver **0.33** / clvmr **0.16.2**. Their `Coin`/`CoinSpend` types do **not** unify, so a Rust dependency (`cargo add cmojo-core` inside `xchannuity-core`) is **not viable** without re-pinning cmojo-core (out of scope, risky).

Instead, **both crates already compile to standalone wasm**. The dApp imports **two** wasm packages — `xchannuity_core` (existing) and `cmojo_core` (prebuilt at `cXCH_DAPP/app/wasm-pkg/`) — and composes their outputs at the JSON coin-spend layer. Each wasm emits standard Chia `coin_spends` + a partial BLS signature; the version difference is invisible at that seam. This keeps both cores untouched and avoids all version conflict.

## Components

### 1. cmojo-core wasm package in the dApp
- Copy the prebuilt `cmojo_core` wasm package into `app/cmojo-pkg/` (or build it: `wasm-pack build` of `cXCH_DAPP/cmojo-core`). Wire it like the existing `@wasm` alias (a second alias, e.g. `@cmojo`), with an `ensureCmojo()` init gate mirroring `ensureWasm()`.
- The relevant exports (from `cmojo-core/src/lib.rs`): `wrap(WrapRequestDto) -> { coin_spends, issuer_partial_signature }` and `melt(MeltRequestDto) -> { coin_spends, issuer_partial_signature }`; plus its `aggregate_signatures`. DTO fields: wrap `{ xch_coins, recipient_puzzle_hash, change_puzzle_hash, mint_amount_mojos, fee_mojos }`; melt `{ cmojo_coins, anchor_coins, recipient_puzzle_hash, cat_change_puzzle_hash, melt_amount_mojos, fee_mojos }`.

### 2. `app/app/lib/cmojo.ts`
Thin wrapper: `ensureCmojo()`, `wrapXch(...)`, `meltToXch(...)`. Each returns `{ coinSpends, issuerPartialSig }`. Also a helper to **locate the minted cMOJO coin** produced by `wrap` (parse the wrap `coin_spends` for the `CAT<cMOJO>` output to the user's ph, with its lineage proof) so it can be fed to `build_create` as funding. (Mirrors the discovery parse already in the app.)

### 3. CREATE flow (XCH) — atomic, one signature
In `CreatePanel` when `token.isXch`:
1. `principal_mojos = toMojos(amount, 12)` (XCH mojos). Compute the cMojo **wrap dev fee** (from cmojo-core) + the **0.5% annuity protocol fee**.
2. `wrapXch({ xch_coins: walletXchCoins, recipient_ph: walletPh, change_ph: walletPh, mint_amount: principal_mojos, fee })` → wrap coin_spends + issuer sig + the minted cMOJO coin/lineage.
3. `build_create` (existing wasm) over the **ephemeral minted cMOJO coin** (asset = cMOJO id) → create coin_spends.
4. Combine `[...wrapSpends, ...createSpends]` into one bundle; Sage `chip0002_signCoinSpends(partialSign)`; aggregate wallet sig + cmojo issuer sig; push via coinset. One block, atomic — can't half-complete.
5. Unguard XCH create (remove the temporary toast guard).

### 4. CLAIM flow (XCH) — claim then auto-melt
In `AnnuityCard` when the annuity is XCH (`assetId === cMOJO`):
1. `build_claim` (existing) → claims vested cMOJO to the owner's ph; sign + push (step 1).
2. Compute the just-claimed cMOJO coin (the claim payout output). **Auto-prompt** a second `SpendConfirm`: `meltToXch({ cmojo_coins: [claimed], anchor_coins: [a wallet XCH coin], recipient_ph: walletPh, cat_change_ph: walletPh, melt_amount, fee })` → sign + push (step 2). User ends with XCH.

### 5. Transfer / Offer — unchanged
Operate on the cMOJO annuity directly; offers already request native XCH for payment. Display as XCH. No wrap/melt.

### 6. Display + tokens (already partly done)
- `tokens.ts`: XCH entry at top + default, `isXch`, `assetId = cMOJO id`. ✅ done.
- Balance: native XCH for XCH; spinner while loading; click-to-fill. ✅ done.
- All figures for XCH annuities shown in XCH (÷1e12) via the existing `mojosToXch`; `tokenByAssetId(cMOJO)` → XCH. ✅ resolver done.
- Fees surfaced in the create preview (wrap dev fee + 0.5%) and the claim/melt confirm (melt dev fee).

## Edge cases
- **Melt anchor coin:** `melt` needs a standard XCH `anchor_coins` input. The user has XCH, but if they hold *only* the annuity, surface a clear "keep a small XCH coin for withdrawal" error before claiming.
- **Clawback of an XCH annuity:** yields cMOJO to both parties; the issuer (spender) gets an auto-melt prompt for their reclaimed portion; the recipient's accrued cMOJO is a plain coin meltable via the same path (documented; not auto-handled).
- **Atomic-create failure:** if `wrap` or `build_create` fails, nothing is signed/pushed (single bundle).
- **Dev fee:** baked into cmojo-core; display the net XCH that actually vests / is received.

## Testing
- `xchannuity-core` 44 cargo + 4 rue + redteam stay green **untouched** (no core change).
- cmojo-core has its own tests.
- New: a JS/integration smoke path is hard to unit-test without a wallet; verify on testnet/sim manually — (a) atomic wrap+create yields a cMOJO annuity displayed as XCH; (b) claim→melt round-trips to XCH; (c) melt-without-anchor errors cleanly. Document the manual verification steps.

## Scope guard
No `xchannuity-core` Rust change, no stream puzzle change, no new on-chain mode, no xchannuity wasm rebuild. Transfer/offer and the 3 stablecoins behave exactly as today. Only added: the cmojo-core wasm package + `lib/cmojo.ts` + the XCH branches in CreatePanel/AnnuityCard + fee display.

## Open implementation detail (resolve early in the plan)
Confirm `cmojo-core`'s `wrap` output exposes (or lets us derive) the minted cMOJO coin **id + lineage proof** needed to spend it in the same bundle via `build_create`. If not directly returned, parse it from the wrap `coin_spends` (the eve `CAT<cMOJO>` issuance output to the wallet ph). This is the one integration unknown.
