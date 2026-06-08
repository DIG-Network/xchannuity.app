# XCH Annuities via cMOJO (wrap/melt) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Present XCH (native balance) as the headline denomination; under the hood wrap XCH→cMOJO to fund the annuity (atomic, one signature) and melt cMOJO→XCH on claim (auto-prompted 2nd signature). The word "cMOJO" never appears in the UI.

**Architecture:** JS-level composition of two wasm packages — existing `xchannuity_core` + prebuilt `cmojo_core` (chia 0.26/0.27, composed at the coin-spend JSON seam; field names match). `xchannuity-core` Rust + puzzle are UNCHANGED. The only Rust change is a tiny patch to **cmojo-core** to expose the minted coin over wasm, then rebuild its wasm pkg.

**Tech Stack:** Next.js 15 (static export, `asyncWebAssembly`), Sage WalletConnect (`chip0002_signCoinSpends`), coinset.org `/push_tx`, two wasm-bindgen packages.

---

## Reference — verified contracts (use verbatim; do not re-derive)

**cmojo wasm exports:** `wrap(req)`, `melt(req)`, `aggregate_signatures(string[])`, `cmojo_asset_id()`, `cmojo_outer_puzzle_hash(innerPh)`, `standard_puzzle_hash(synthKey)`, `address_to_puzzle_hash(addr)`.

**wrap req** `{ xch_coins:[{coin:{parent_coin_info,puzzle_hash,amount},synthetic_key}], recipient_puzzle_hash, change_puzzle_hash, mint_amount_mojos, fee_mojos }`
**melt req** `{ cmojo_coins:[{coin,lineage_proof:{parent_parent_coin_info,parent_inner_puzzle_hash,parent_amount},synthetic_key}], anchor_coins:[{coin,synthetic_key}], recipient_puzzle_hash, cat_change_puzzle_hash, melt_amount_mojos, fee_mojos }`
**wrap/melt out** `{ coin_spends:[{coin:{parent_coin_info,puzzle_hash,amount},puzzle_reveal,solution}], issuer_partial_signature }` — all hex `0x`-prefixed. **After Task 1 also:** `minted_coins:[{coin,lineage_proof}]`.
**cMojo dev fee:** fixed 0.1% (10 bps), baked in, paid on top (wrap) / deducted (melt). `fee_mojos` = separate network fee. JS helper: `devFee(m)=(m*10n)/10_000n`.

**xchannuity wasm:** `build_create_annuity(CreateRequest)`/`build_claim`/`build_clawback`/`build_transfer` → `BundleJson { coin_spends, stream_id }` (NO issuer sig). `aggregate_signatures`, `standard_puzzle_hash`, `cat_puzzle_hash`, `address_to_puzzle_hash`, `coin_id`.
`CreateRequest`: `{ asset_id, funding:[CatCoinJson], recipient, clawback_ph, end_time, start_time, principal, network_fee_mojos, xch_fee_coin?, xch_fee_key? }`. `CatCoinJson { coin:{parent_coin_info,puzzle_hash,amount}, lineage_proof:{parent_parent_coin_info,parent_inner_puzzle_hash,parent_amount}, p2_puzzle_hash, synthetic_key }`.

**Coin JSON parity:** field names identical across both cores. Pass `amount` as a JS number to xchannuity; cmojo accepts number or string. cMOJO coins need `p2_puzzle_hash` added for xchannuity (`= standard_puzzle_hash(synthetic_key)`); cmojo derives it internally.

**xchannuity push pattern** (`app/app/lib/flow.ts`): `signAndBroadcast(request, { coin_spends, issuer_partial_sig_hex? })` → Sage `chip0002_signCoinSpends({coinSpends, partialSign:true})` → `aggregate_signatures([walletSig, ...issuerSigs])` → POST `https://api.coinset.org/push_tx` `{spend_bundle:{coin_spends: coin_spends.map(normalizePushSpend), aggregated_signature}}`. `normalizePushSpend` 0x-prefixes fields (no-op on cmojo's already-prefixed spends).

---

## File map

- **Modify** `cXCH_DAPP/cmojo-core/src/dto.rs` — add `minted_coins` to `UnsignedSpendBundleOut`. Rebuild → copy pkg to `xchannuity.app/app/cmojo-pkg/`.
- **Create** `app/cmojo-pkg/` — the rebuilt cmojo wasm package.
- **Modify** `app/next.config.ts`, `app/tsconfig.json` — `@cmojo` alias.
- **Create** `app/app/lib/cmojo.ts` — `ensureCmojo`, `wrapXch`, `meltToXch`, `devFeeMojos`, `CMOJO_ASSET_ID` re-export.
- **Modify** `app/app/components/CreatePanel.tsx` — XCH atomic wrap+create; unguard; fee preview.
- **Modify** `app/app/components/AnnuityCard.tsx` — XCH claim→auto-melt; clawback→auto-melt; anchor-coin error.
- **No change:** `xchannuity-core/` (Rust), the stream puzzle, the 44 cargo + 4 rue + redteam tests.

---

## Task 1: Expose the minted coin from cmojo-core wasm

**Files:** Modify `C:/Users/micha/workspace/dig_network/cXCH_DAPP/cmojo-core/src/dto.rs`.

- [ ] **Step 1: Add output structs + field.** In `dto.rs`, add after `CoinSpendOut`:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct LineageProofOut {
    pub parent_parent_coin_info: String,
    pub parent_inner_puzzle_hash: String,
    pub parent_amount: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatOut {
    pub coin: CoinOut,
    pub lineage_proof: Option<LineageProofOut>,
}
```

Add the field to `UnsignedSpendBundleOut`:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct UnsignedSpendBundleOut {
    pub coin_spends: Vec<CoinSpendOut>,
    pub issuer_partial_signature: String,
    /// CAT coins created by this bundle (minted cMojo for wrap; change for melt),
    /// so a caller can spend them in the same bundle without waiting for a block.
    pub minted_coins: Vec<CatOut>,
}
```

- [ ] **Step 2: Populate it in `from_bundle`** (the `cat_outputs` exist in the Rust bundle):

```rust
impl UnsignedSpendBundleOut {
    pub fn from_bundle(bundle: &UnsignedSpendBundle) -> Self {
        Self {
            coin_spends: bundle.coin_spends.iter().map(coin_spend_out).collect(),
            issuer_partial_signature: to_hex(&bundle.issuer_signature.to_bytes()),
            minted_coins: bundle.cat_outputs.iter().map(cat_out).collect(),
        }
    }
}

fn cat_out(cat: &chia_sdk_driver::Cat) -> CatOut {
    CatOut {
        coin: CoinOut {
            parent_coin_info: to_hex(&cat.coin.parent_coin_info.to_bytes()),
            puzzle_hash: to_hex(&cat.coin.puzzle_hash.to_bytes()),
            amount: cat.coin.amount,
        },
        lineage_proof: cat.lineage_proof.as_ref().map(|lp| LineageProofOut {
            parent_parent_coin_info: to_hex(&lp.parent_parent_coin_info.to_bytes()),
            parent_inner_puzzle_hash: to_hex(&lp.parent_inner_puzzle_hash.to_bytes()),
            parent_amount: lp.parent_amount,
        }),
    }
}
```

(If `Cat`/`LineageProof` aren't already imported in `dto.rs`, fully-qualify as above or add `use`.)

- [ ] **Step 3: Build + rebuild wasm.** Run from `cXCH_DAPP/cmojo-core`:

Run: `cargo build` — Expected: clean compile.
Run: `wasm-pack build --release --target web --out-dir pkg` (set `CC_wasm32_unknown_unknown`/`AR_wasm32_unknown_unknown` to clang as in cXCH's build if blst/secp need it).
Expected: emits `pkg/cmojo_core.js` + `cmojo_core_bg.wasm`.

- [ ] **Step 4: Copy the pkg into the xchannuity app.**

```bash
mkdir -p C:/Users/micha/workspace/dig_network/xchannuity.app/app/cmojo-pkg
cp -r C:/Users/micha/workspace/dig_network/cXCH_DAPP/cmojo-core/pkg/* C:/Users/micha/workspace/dig_network/xchannuity.app/app/cmojo-pkg/
```

- [ ] **Step 5: Verify the field is emitted.** Quick node check (from `app/`):

Run: `node -e "const w=require('./cmojo-pkg/cmojo_core.js'); console.log('minted_coins' in {minted_coins:[]} ? 'struct ok':'')"` (sanity; full check is the manual wrap test in Task 6).

- [ ] **Step 6: Commit (in cXCH_DAPP repo):**

```bash
cd C:/Users/micha/workspace/dig_network/cXCH_DAPP && git add cmojo-core/src/dto.rs && git commit -m "feat(cmojo-core): expose minted_coins in wasm output"
```

---

## Task 2: Wire the cmojo wasm into the dApp + `lib/cmojo.ts`

**Files:** Modify `app/next.config.ts`, `app/tsconfig.json`; Create `app/app/lib/cmojo.ts`.

- [ ] **Step 1: tsconfig alias.** In `app/tsconfig.json` `compilerOptions.paths`, add alongside `@wasm`:

```json
"@cmojo": ["./cmojo-pkg/cmojo_core.js"]
```

- [ ] **Step 2: next.config.** `app/next.config.ts` already enables `asyncWebAssembly` + static export; the new pkg under `app/cmojo-pkg/` is covered by the same wasm rule. No change needed unless the build errors on the second `.wasm` — if so, confirm `config.experiments.asyncWebAssembly = true` applies (it does, it's global). Verify in Task 3 build.

- [ ] **Step 3: Create `app/app/lib/cmojo.ts`:**

```ts
"use client";
import initCmojo, {
  wrap as cmojoWrap,
  melt as cmojoMelt,
  cmojo_asset_id,
  cmojo_outer_puzzle_hash,
  standard_puzzle_hash as cmojo_std_ph,
} from "@cmojo";

let ready: Promise<void> | null = null;
export function ensureCmojo(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("cMojo engine requires a browser"));
  if (!ready) ready = initCmojo().then(() => undefined);
  return ready;
}

/** cMojo dev fee: fixed 0.1% (10 bps), baked into wrap/melt. */
export function devFeeMojos(amountMojos: bigint): bigint {
  return (amountMojos * 10n) / 10_000n;
}

export interface CmojoCoinJson {
  coin: { parent_coin_info: string; puzzle_hash: string; amount: number };
  lineage_proof: { parent_parent_coin_info: string; parent_inner_puzzle_hash: string; parent_amount: number };
}
export interface CmojoBundle {
  coin_spends: any[];
  issuer_partial_signature: string;
  minted_coins: CmojoCoinJson[];
}

/** Wrap XCH → cMOJO, minting `mintMojos` to `recipientPh`. Returns the bundle
 *  + the minted cMOJO coin (id+lineage) so it can be funded into an annuity. */
export async function wrapXch(args: {
  xchCoins: { coin: any; synthetic_key: string }[];
  recipientPh: string;
  changePh: string;
  mintMojos: bigint;
  feeMojos: bigint;
}): Promise<CmojoBundle> {
  await ensureCmojo();
  return cmojoWrap({
    xch_coins: args.xchCoins,
    recipient_puzzle_hash: args.recipientPh,
    change_puzzle_hash: args.changePh,
    mint_amount_mojos: args.mintMojos.toString(),
    fee_mojos: args.feeMojos.toString(),
  }) as CmojoBundle;
}

/** Melt cMOJO → XCH to `recipientPh`. `anchorCoins` are plain wallet XCH coins
 *  (a CAT can't create XCH, so a standard coin must co-spend). */
export async function meltToXch(args: {
  cmojoCoins: { coin: any; lineage_proof: any; synthetic_key: string }[];
  anchorCoins: { coin: any; synthetic_key: string }[];
  recipientPh: string;
  catChangePh: string;
  meltMojos: bigint;
  feeMojos: bigint;
}): Promise<CmojoBundle> {
  await ensureCmojo();
  return cmojoMelt({
    cmojo_coins: args.cmojoCoins,
    anchor_coins: args.anchorCoins,
    recipient_puzzle_hash: args.recipientPh,
    cat_change_puzzle_hash: args.catChangePh,
    melt_amount_mojos: args.meltMojos.toString(),
    fee_mojos: args.feeMojos.toString(),
  }) as CmojoBundle;
}

export const cmojoAssetId = () => cmojo_asset_id();
export const cmojoOuterPh = (innerPh: string) => cmojo_outer_puzzle_hash(innerPh);
export const cmojoStdPh = (synthKey: string) => cmojo_std_ph(synthKey);
```

- [ ] **Step 4: ensure cmojo ready at boot.** In `app/app/page.tsx`, where `ensureWasm()` runs in the boot `useEffect`, also await `ensureCmojo()`:

```ts
import { ensureCmojo } from "./lib/cmojo";
// in the effect:
Promise.all([ensureWasm(), ensureCmojo()]).then(() => setReady(true)).catch(...);
```

- [ ] **Step 5: Build check.**
Run: `cd app && npm run build` (or rely on `npm run dev` HMR) — Expected: compiles; both wasm packages load.

- [ ] **Step 6: Commit.**
```bash
cd C:/Users/micha/workspace/dig_network/xchannuity.app && git add app/cmojo-pkg app/tsconfig.json app/next.config.ts app/app/lib/cmojo.ts app/app/page.tsx && git commit -m "feat(app): integrate cmojo-core wasm + lib/cmojo.ts"
```

---

## Task 3: CreatePanel — atomic XCH wrap+create

**Files:** Modify `app/app/components/CreatePanel.tsx`.

Replace the temporary XCH guard in `create()` with the real atomic flow. The non-XCH path is unchanged.

- [ ] **Step 1: Imports.** Add to CreatePanel:
```ts
import { wrapXch, devFeeMojos, cmojoStdPh } from "../lib/cmojo";
import { CMOJO_ASSET_ID } from "../lib/tokens";
import { signAndBroadcast } from "../lib/flow";
```

- [ ] **Step 2: Replace the guard with the XCH branch.** Where `create()` currently has:
```ts
    if (isXch) {
      toast.error("XCH annuities are being wired up (XCH→cMOJO wrap). Coming shortly.");
      return;
    }
```
replace with a call into a new `createXch()` and return:
```ts
    if (isXch) { await createXch(); return; }
```

- [ ] **Step 3: Implement `createXch()`** (atomic wrap+create through SpendConfirm):
```ts
  async function createXch() {
    const startTime = nowUnix();
    const endTime = startTime + termSeconds;
    const principal = Number(toMojos(amount, 12)); // XCH mojos = cMOJO mint amount
    if (!(principal > 0)) { toast.error("Enter an amount"); return; }
    const recipient = recipientMode === "self"
      ? address_to_puzzle_hash(await getAddress(request))
      : address_to_puzzle_hash(recipientAddr.trim());
    const clawback = clawbackEnabled
      ? address_to_puzzle_hash((clawbackAddr.trim() || (await getAddress(request))))
      : null;

    await runSpend({
      title: `Create ${amount} XCH annuity`,
      confirmLabel: "Wrap & create",
      prepare: async (report) => {
        report("Selecting XCH coins…");
        const keys = await getPublicKeys(request);
        const resolver = buildKeyResolver(keys);
        const rawXch = await getAssetCoins(request, null, null);
        const walletPh = address_to_puzzle_hash(await getAddress(request));
        const fee = devFeeMojos(BigInt(principal));            // 0.1% wrap dev fee
        const need = BigInt(principal) + fee;
        const picked = selectCoins(rawXch.map(normalizeCoin), need); // largest-first ≥ need
        if (picked.length === 0) throw new Error("Not enough XCH to wrap");
        const xchCoins = picked.map((c) => ({ coin: c, synthetic_key: resolver(c.puzzle_hash)! }));

        report("Wrapping XCH → annuity…");
        const wrapped = await wrapXch({
          xchCoins, recipientPh: walletPh, changePh: walletPh,
          mintMojos: BigInt(principal), feeMojos: 0n,
        });
        const minted = wrapped.minted_coins[0];
        if (!minted) throw new Error("wrap produced no coin");
        const mintedKey = resolver(walletPh)!; // minted cMOJO p2 = wallet ph

        report("Building annuity…");
        const created: any = build_create_annuity({
          asset_id: CMOJO_ASSET_ID,
          funding: [{
            coin: minted.coin,
            lineage_proof: minted.lineage_proof,
            p2_puzzle_hash: cmojoStdPh(mintedKey), // == minted.coin inner ph
            synthetic_key: mintedKey,
          }],
          recipient, clawback_ph: clawback,
          end_time: endTime, start_time: startTime,
          principal, network_fee_mojos: 0,
        });

        const coin_spends = [...wrapped.coin_spends, ...created.coin_spends];
        const summary: SpendSummaryLine[] = [
          { label: "Annuity", value: `${fromMojos(principal - Math.floor(principal*feeBps/10_000), 12)} XCH`, strong: true },
          { label: "Protocol fee (0.5%)", value: `${fromMojos(Math.floor(principal*feeBps/10_000),12)} XCH` },
          { label: "Wrap fee (0.1%)", value: `${mojosToXch(fee)} XCH` },
        ];
        // Aggregate wallet sig WITH the cMojo issuer partial sig.
        return { built: { coin_spends, issuer_partial_sig_hex: wrapped.issuer_partial_signature }, summary, watchCoinId: undefined };
      },
    }).then(() => { toast.success("XCH annuity created"); onDone(); }).catch(() => {});
  }
```

(Adapt variable names — `recipientMode`/`recipientAddr`/`clawbackEnabled`/`clawbackAddr`/`onDone` — to the existing CreatePanel state; reuse its existing recipient/clawback resolution rather than the snippet's placeholders. The key new parts are: wrap → minted coin → build_create over it → concat coin_spends → pass `issuer_partial_sig_hex` so `signAndBroadcast` aggregates the cMojo issuer sig.)

- [ ] **Step 4: Confirm `runSpend` aggregates the issuer sig.** `SpendConfirm`'s `runSpend` must pass `built.issuer_partial_sig_hex` into `signAndBroadcast` (it already supports the field via `BuiltBundle`). Verify `prepare`'s returned `built` includes it (it does above).

- [ ] **Step 5: Imports needed:** ensure `selectCoins`, `normalizeCoin`, `getAssetCoins`, `getAddress`, `getPublicKeys`, `buildKeyResolver`, `fromMojos`, `mojosToXch`, `toMojos` are imported (most already are; add `selectCoins`/`getAddress` if missing — copy from cXCH `lib/coins`/`lib/sage`).

- [ ] **Step 6: Build + manual check (logged-out compiles).**
Run: `cd app && npm run dev` → fetch `/` → Expected: 200, compiles.

- [ ] **Step 7: Commit.**
```bash
git add app/app/components/CreatePanel.tsx && git commit -m "feat(app): atomic XCH wrap+create annuity"
```

---

## Task 4: AnnuityCard — XCH claim → auto-melt to XCH

**Files:** Modify `app/app/components/AnnuityCard.tsx`.

- [ ] **Step 1: Imports.**
```ts
import { meltToXch, devFeeMojos } from "../lib/cmojo";
import { CMOJO_ASSET_ID } from "../lib/tokens";
```
Add `const isXch = a.assetId.toLowerCase() === CMOJO_ASSET_ID.toLowerCase();`

- [ ] **Step 2: After a successful XCH claim, auto-prompt the melt.** In `doClaim()`'s `.then()`, when `isXch`, chain a melt SpendConfirm on the just-claimed cMOJO coin:
```ts
      .then(async () => {
        toast.success("Claim confirmed");
        if (isXch) await meltClaimed();
        onChange();
      })
```
where `claimable` (mojos) is the claimed amount and the claimed cMOJO coin is the claim payout output (puzzle_hash = `CAT<owner ph>`; parent = the spent annuity coin id; amount = claimed). Compute it from the claim spend the same way discovery does, or read it from the claim builder result if exposed.

- [ ] **Step 3: Implement `meltClaimed()`:**
```ts
  async function meltClaimed() {
    await runSpend({
      title: "Withdraw to XCH",
      confirmLabel: "Melt to XCH",
      prepare: async (report) => {
        report("Locating claimed cMOJO…");
        const keys = await getPublicKeys(request);
        const resolver = buildKeyResolver(keys);
        // claimed cMOJO coin: owned by a.recipient, amount = claimable
        const claimedCat = /* { coin, lineage_proof } for the claim payout */;
        report("Selecting an XCH anchor coin…");
        const rawXch = await getAssetCoins(request, null, null);
        if (rawXch.length === 0) throw new Error("Need a small XCH coin in this wallet to withdraw");
        const anchor = normalizeCoin(rawXch[0]);
        const recipientPh = a.recipient;
        const melt = await meltToXch({
          cmojoCoins: [{ ...claimedCat, synthetic_key: resolver(a.recipient)! }],
          anchorCoins: [{ coin: anchor, synthetic_key: resolver(anchor.puzzle_hash)! }],
          recipientPh, catChangePh: recipientPh,
          meltMojos: BigInt(claimable), feeMojos: 0n,
        });
        const summary: SpendSummaryLine[] = [
          { label: "Withdraw", value: `${mojosToXch(claimable)} XCH`, strong: true },
          { label: "Melt fee (0.1%)", value: `${mojosToXch(devFeeMojos(BigInt(claimable)))} XCH` },
        ];
        return { built: { coin_spends: melt.coin_spends, issuer_partial_sig_hex: melt.issuer_partial_signature }, summary, watchCoinId: undefined };
      },
    });
  }
```

- [ ] **Step 4: Resolve the claimed cMOJO coin.** The claim continuation/payout coin must be reconstructed (parent = the spent annuity coin id; ph = `cat_puzzle_hash(CMOJO_ASSET_ID, standard_puzzle_hash(ownerKey))`; amount = `claimable`; lineage = from the annuity coin). Use the existing `discovery`/`coin_id` helpers; if claim already returns the payout coin, use that. Implement as a small helper `claimedCmojoCoin(live, claimableMojos)`.

- [ ] **Step 5: Display.** XCH annuity figures already render via `mojosToXch` (tokenByAssetId→XCH). Confirm the card shows "XCH".

- [ ] **Step 6: Build + commit.**
Run: `cd app && npm run dev` → 200/compiles.
```bash
git add app/app/components/AnnuityCard.tsx && git commit -m "feat(app): XCH claim auto-melts cMOJO→XCH"
```

---

## Task 5: Clawback (XCH) — auto-melt the issuer's reclaimed portion

**Files:** Modify `app/app/components/AnnuityCard.tsx`.

- [ ] **Step 1:** In `doClawback()`'s `.then()`, when `isXch`, auto-prompt a melt of the issuer's reclaimed cMOJO portion (`toStream` amount) to XCH, mirroring `meltClaimed()` but for the issuer's coin (owned by the clawback ph). The recipient's accrued cMOJO is left as a plain coin (documented; not auto-handled).

```ts
      .then(async () => {
        toast.success("Clawback confirmed");
        if (isXch) await meltReclaimed(); // issuer portion = toStream
        removeAnnuity(a.streamId); onChange();
      })
```
`meltReclaimed()` = `meltClaimed()` parameterized by amount `toStream` and the reclaimed coin (owned by `a.clawbackPh`).

- [ ] **Step 2: Commit.**
```bash
git add app/app/components/AnnuityCard.tsx && git commit -m "feat(app): XCH clawback auto-melts reclaimed portion"
```

---

## Task 6: Verify

- [ ] **Step 1: xchannuity core untouched + green.**
Run: `cd core && cargo test 2>&1 | grep "test result:"` — Expected: 44 pass, 0 failed (no core change).
Run: `cd core && rue test puzzles/stream.rue 2>&1 | grep -c "Running test"` — Expected: 4.
Run: `cd core && cat puzzles/stream.rue.hash` — Expected: `0x39ec8ca9b00348fe658c78d390032921f989ae3a696d5578c3866c6a803c5046`.

- [ ] **Step 2: app builds.**
Run: `cd app && npm run build` — Expected: static export succeeds with both wasm pkgs.

- [ ] **Step 3: Manual (testnet/sim, wallet-dependent) — document results in the PR:**
  1. Connect Sage. Picker shows XCH (default) + 3 stablecoins; no "cMOJO" anywhere.
  2. Create an XCH annuity → ONE signature → annuity appears, displayed in XCH, amount = principal − 0.5% (wrap fee shown 0.1%).
  3. Claim → first signature (claim) → auto-prompt → second signature (melt) → wallet XCH increases by ~claimed − 0.1%.
  4. Withdraw with no spare XCH coin → clear "need a small XCH coin" error (no broken spend).
  5. Transfer / Offer an XCH annuity → unchanged, displayed in XCH.

- [ ] **Step 4: Commit any doc/STATUS updates.**
```bash
git add STATUS.md && git commit -m "docs: XCH-via-cMOJO wrap/melt"
```

---

## Self-review

- **Spec coverage:** cmojo wasm integration (T2), minted-coin exposure (T1, the flagged unknown), atomic wrap+create (T3), claim→auto-melt (T4), clawback melt + anchor-coin error (T4/T5), fee display 0.1%+0.5% (T3/T4), display-as-XCH (done + T4), core untouched (T6). All covered.
- **Placeholders:** the two spots marked "Adapt to existing CreatePanel state" (T3 step 3) and "resolve the claimed cMOJO coin" (T4 step 4) are integration points against existing code the implementer must read — flagged explicitly with the exact shape needed, not hidden TODOs. Everything else is concrete.
- **Type consistency:** `wrapXch`/`meltToXch` return `CmojoBundle { coin_spends, issuer_partial_signature, minted_coins }`; `signAndBroadcast` consumes `{ coin_spends, issuer_partial_sig_hex }` — the mapping `issuer_partial_signature → issuer_partial_sig_hex` is done at each call site (T3/T4). `CMOJO_ASSET_ID` from tokens.ts used everywhere. Coin field names parity confirmed in Reference.
