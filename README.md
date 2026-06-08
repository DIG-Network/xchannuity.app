# Xchannuity

**Transferable, tradable streamed-CAT annuities on Chia — vesting by the second.**

An Xchannuity is an on-chain annuity coin that releases a fixed principal to its owner
linearly over a time window. The owner can claim whatever has vested at any moment,
transfer the unvested remainder to someone else, or sell it via a standard Chia offer.
The annuity is presented in **XCH** — the underlying coin is a 1:1 wrapped-XCH CAT
(cMOJO), wrapped on deposit and melted back to XCH on withdrawal, so users only ever see
and hold native XCH.

- **App:** https://xchannuity.app
- **Repo:** https://github.com/DIG-Network/xchannuity.app
- **License:** MIT — fully open source.

---

## How it works

The annuity coin is a `CAT<StreamLayer>`: a Chia CAT whose inner puzzle is the
**StreamLayer** — a Rue puzzle (compiled to CLVM) that enforces vesting math and ownership.

- **CLAIM** *(owner-authorized)* — pay the owner everything vested up to now; the
  unvested remainder continues as a fresh annuity coin.
- **TRANSFER** *(owner-authorized, plain or via offer)* — re-curry the remainder under a
  new owner. Value can never become liquid CAT; the vesting window and clawback setting
  are preserved across every continuation.
- **CLAWBACK** *(issuer, optional)* — if an annuity was created with a clawback address,
  the issuer can reclaim the unvested portion via a mode-23 `RECEIVE_MESSAGE`. Annuities
  created with no clawback address (`clawback_ph == nil`) are **permanent** and can never
  be clawed back.

Authorization model: CLAIM/TRANSFER authorize by revealing and running the owner's inner
p2 puzzle in the solution (its `AGG_SIG_ME` is enforced inside the reveal;
`tree_hash(reveal) == owner_hash` is checked first). Time is clamped to `[last, end]`.
See [`docs/whitepaper.md`](docs/whitepaper.md) for the full design and
[`STATUS.md`](STATUS.md) for the implementation/threat-model status.

### XCH via cMOJO (wrap / melt)

XCH is the headline denomination but the annuity coin holds **cMOJO** (1:1 wrapped XCH).
The two flows that touch native XCH:

- **Create** — one atomic, single-signature bundle: wrap XCH → mint cMOJO → fund the
  annuity over that ephemeral cMOJO coin.
- **Claim** — claim the vested cMOJO, then a second auto-prompted signature melts the
  claimed cMOJO back to native XCH (requires a small XCH anchor coin in the wallet).

cMOJO is never shown in the UI. The integration composes two independently-compiled WASM
packages (`xchannuity_core` + `cmojo_core`) at the JSON coin-spend seam, because their
chia-protocol versions differ — see
[`docs/superpowers/specs/2026-06-07-xch-via-cmojo-design.md`](docs/superpowers/specs/2026-06-07-xch-via-cmojo-design.md).

---

## Repository layout

```
xchannuity.app/
├── Rue.toml                  # pins rue-cli 0.8.4, entrypoint = core/puzzles
├── core/                     # Rust crate `xchannuity-core` → WASM (chia-sdk 0.33 sub-crates, WASM-safe)
│   ├── puzzles/stream.rue    # the annuity puzzle (+ compiled .hex, tree-hash .hash)
│   └── src/
│       ├── layers/           # one file per puzzle boundary, auditable in isolation
│       │   ├── cat.rs        #   SDK CAT re-export
│       │   ├── owner.rs      #   owner-auth StreamSolution builders
│       │   ├── clawback.rs   #   issuer mode-23 message + clawback solution
│       │   └── stream.rs     #   StreamLayer = curried state + vesting math + `impl Layer`
│       ├── composition/      # the only place layers assemble: puzzle hashes / spends / discovery
│       └── wasm.rs           # wasm-bindgen surface
├── app/                      # Next.js 15 static-export dApp (Tailwind v4, Sage WalletConnect)
│   ├── cmojo-pkg/            # prebuilt cmojo_core WASM (wrap/melt)
│   ├── wasm-pkg/             # built from core/ via `npm run build:wasm`
│   └── app/{lib,components}/ # coinset reads, sign/aggregate/push, UI
├── docs/                     # whitepaper + design specs & plans
└── STATUS.md                 # implementation status + threat → guard → test map
```

The on-chain puzzle tree hash is `0x39ec8ca9b00348fe658c78d390032921f989ae3a696d5578c3866c6a803c5046`.

---

## Development

### Puzzle + Rust core

Requires the Rust toolchain, [`rue-cli` 0.8.4](https://github.com/Rigidity/rue), and
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/).

```bash
cd core
rue build            # compile stream.rue → .hex / .hash
rue test             # in-puzzle condition-set tests
cargo test           # 46 tests: roundtrip, adversarial (sim), builders, exploits, redteam
```

Tests run against the `chia-sdk-test` simulator (real CLVM + BLS). The threat → guard →
test map lives in [`STATUS.md`](STATUS.md).

### dApp

```bash
cd app
npm install
npm run build:wasm   # build xchannuity_core WASM from ../core into app/wasm-pkg
npm run dev          # local dev server
npm run build        # static export
```

The dApp connects to a Sage wallet over WalletConnect (`chip0002_signCoinSpends`,
partial-sign) and reads/pushes via the public coinset.org node API.

---

## Security

The puzzle has been hardened against ownership-drain, supply-inflation, malleability, and
offer-economic attacks; every modeled attack is rejected by consensus on the simulator,
with honest baselines passing. Details and the full attack matrix are in
[`STATUS.md`](STATUS.md). This software is provided as-is under the MIT license; review
the puzzle and drivers yourself before moving real value.
