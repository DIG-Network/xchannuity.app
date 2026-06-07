# Xchannuity: A Transferable, Tradable Annuity dApp on Chia — Implementation White Paper

**Version:** 2.0
**Target stack:** Rue `0.6.0` (on-chain puzzles → CLVM) · Rust `chia-sdk-*` driver core → WASM (`wasm-bindgen`) → Next.js 15 / React 19 static export → Sage wallet via WalletConnect v2
**On-chain language:** **Rue only.** Every puzzle is authored in [Rue](https://github.com/Rigidity/rue) and compiled to CLVM. No hand-written Chialisp ships in this project.
**Architectural template:** `C:/Users/micha/workspace/dig_network/cXCH_DAPP` (Rue project + Rust WASM core + Next.js static-export dApp with a landing page that disappears on wallet connect).
**Base puzzle (source to convert):** [`Yakuhito/streaming`](https://github.com/Yakuhito/streaming) — CHIP-0041 Streaming Puzzle (`puzzles/stream.clsp`), ported to Rue and extended with a transfer mode here.
**UI reference:** [`Yakuhito/streaming-ui`](https://github.com/yakuhito/streaming-ui).

---

## Abstract

Xchannuity is an annuity dApp. An annuity is a stream of value that vests to a beneficiary continuously over a fixed term: the beneficiary's claimable balance grows every second from a start time to an end time, the beneficiary claims accrued value whenever they like, and (optionally) the issuer can claw back the not-yet-vested remainder. This is exactly the CHIP-0041 Streaming Puzzle, denominated in a CAT (for example a stablecoin), which is what Yakuhito's `streaming` repository implements in Chialisp.

Xchannuity makes three departures from the base system:

1. **Rue-only puzzles.** The streaming inner puzzle is ported from `stream.clsp` to **Rue** and compiled to CLVM. The transfer extension is written in Rue. There is no Chialisp in the deliverable.
2. **Transfer.** The current beneficiary can hand the entire remaining annuity to a new account in a single spend, without claiming first. The base puzzle has no transfer path (its CLI exposes only launch, claim, and clawback), so this paper specifies a minimal, audited Rue puzzle that adds an owner-authorized transfer mode.
3. **Offer files.** The beneficiary can list an annuity for sale and produce a Chia offer file that trades the annuity for another asset (XCH or any CAT), settled trustlessly through the settlement-payments puzzle. Because an annuity is a unique coin with unique terms (not fungible units), it is offered the way an NFT is offered. The streaming inner puzzle is **not** a wallet-recognized asset driver, so offers are filled by **Xchannuity's own take flow**, not by arbitrary third-party wallets (see §2.4).

The system is client-only: a deterministic Rust core compiled to WASM builds every spend bundle and offer, Sage signs through WalletConnect, and the dApp assembles and broadcasts the result. The frontend mirrors the cXCH dApp template (and, for streaming-specific UX, `streaming-ui`): a static-export Next.js app whose marketing landing page is shown until a wallet session exists and is replaced by the dApp UI on connect.

## TL;DR

- **Create annuity:** Mint a streamed CAT — our Rue streaming inner puzzle wrapped in the CAT layer, curried with the beneficiary's p2 puzzle hash (`recipient`), an optional clawback puzzle hash, the end time, and the start time (`last_payment_time`), funded with the CAT amount to stream.
- **Claim:** Recipient-authorized spend that pushes the accrued amount to the beneficiary and recreates the continuation coin with `last_payment_time = payment_time` and the reduced remainder. Authorization is a co-spent message from one of the recipient's own coins (see §2.1).
- **Clawback (optional):** Issuer-authorized spend (same message mechanism, sender = clawback authority) that pays the already-accrued amount to the beneficiary and returns the unvested remainder to the issuer, terminating the annuity. Set the clawback puzzle hash to `nil` at creation to make the annuity permanent.
- **Transfer (new):** Owner-authorized spend that recreates the annuity with a new `recipient`, preserving term and accrual state. Authorized by a message from the current recipient whose body **is** the new recipient — binding the destination so a mempool watcher cannot redirect it.
- **Sell (new):** Build an offer file offering the annuity coin and requesting another asset, settled via the settlement-payments puzzle; Sage signs the maker spend; the dApp serializes the offer file. Filled by Xchannuity's own take-offer flow (the streaming puzzle is not a generic wallet offer driver).

## 0. Reference Implementations & Ground Truth

This design is reconstructed from three repositories cloned locally, plus the Rue compiler. Paths and pinned versions are authoritative — verify against them before coding.

| Reference | Local path | Role | Pin |
|---|---|---|---|
| **cXCH dApp** | `C:/Users/micha/workspace/dig_network/cXCH_DAPP` | Architectural template: Rue project layout, Rust→WASM core, Next.js static-export dApp, landing-on-connect pattern, WalletConnect/Sage wiring | Next 15.2.1, React 19, `chia-sdk-*` 0.27 |
| **Yakuhito/streaming** | `C:/Users/micha/workspace/dig_network/_refs/streaming` | The CHIP-0041 puzzle source we port to Rue (`puzzles/stream.clsp`) + the Rust CLI lifecycle | `chia-wallet-sdk` (git) 0.23 |
| **Yakuhito/streaming-ui** | `C:/Users/micha/workspace/dig_network/_refs/streaming-ui` | Streaming-specific UX reference (create/view/claim flows) | `chia-wallet-sdk-wasm` 0.24 |
| **Rue compiler** | `C:/Users/micha/workspace/dig_network/_refs/rue` | The on-chain language + its std library (conditions, `tree_hash`, `curry_tree_hash`) | repo at 0.8.4; project pins **0.6.0** |
| **chia-blockchain** | `C:/Users/micha/workspace/dig_network/_refs/chia-blockchain` (sparse: `chia/wallet`) | Offer/settlement ground truth: `trading/offer.py` (notarized payments, nonce, announcements, bech32), `nft_wallet/` (unique-coin swap precedent) | reference wallet |

**Decisions taken from the ground truth:**

1. **We author our own Rue puzzle and our own thin Rust driver.** The SDK's `StreamedCat` / `StreamPuzzle2ndCurryArgs` / `StreamingPuzzleInfo` (in `chia-sdk-driver`) encode the *original* Chialisp puzzle and cannot express a transfer mode. We compile our Rue puzzle to CLVM and build claim/clawback/transfer/offer spends manually using `chia-sdk-driver` primitives (`SpendContext`, CAT driver, `StandardLayer`, settlement layer). `streaming-ui` uses the prebuilt `chia-wallet-sdk-wasm` directly; we instead ship a purpose-built core like cXCH because our puzzle is non-standard.
2. **WASM-safe dependency strategy (critical).** cXCH depends on the **chia-sdk sub-crates** (`chia-sdk-driver`, `chia-sdk-types`, `chia-sdk-signer`, `chia-sdk-utils`), **not** the umbrella `chia-wallet-sdk` crate. The umbrella pulls in `chia-sdk-client` (tokio + TLS), which does not compile to `wasm32-unknown-unknown`. Reusing the umbrella crate as the original whitepaper proposed would fail the WASM build. See §4.1.
3. **Static export.** The dApp is `output: "export"` — no SSR, no API routes. WalletConnect's `SignClient` opens IndexedDB at construction (absent in Node) and the WASM core is browser-only, so any SSR pass would crash. See §6.
4. **Auth is message-based, not in-puzzle signatures.** The real `stream.clsp` carries no `AGG_SIG_ME`. Claiming/clawing back is authorized by a *separate* coin spend (owned by the recipient or clawback authority) that emits `SEND_MESSAGE`; the streaming coin asserts the matching `RECEIVE_MESSAGE`. Our transfer mode reuses this exact mechanism (see §2.1). This corrects the original whitepaper's invented `OWNER_PUBKEY` + `AGG_SIG_ME` design.
5. **Stream id encoding.** The id is the bech32m encoding of the launch (eve) coin id with human-readable prefix **`stream`** on mainnet (`stream1…`) and **`tstream`** on testnet (`tstream1…`) — *not* `s1`/`ts1`.

### 0.1 Scope decisions (resolved)

| Decision | Choice | Consequence |
|---|---|---|
| **Offer reach** | **Xchannuity-only take flow** | The streaming puzzle is not a wallet-recognized asset driver, so generic wallets / Sage `chia_takeOffer` cannot parse or fill it. Our dApp builds both the maker offer and the take-side completion. A generic `chia-wallet-sdk` driver is explicitly out of scope. |
| **Denomination** | **Any CAT** | The user supplies the asset id at create time. Discovery and the present-value/fairness hint are generic over unknown tokens; a friendly-name map is best-effort. |
| **First network** | **Mainnet** (`chia:mainnet`) | Launch target is mainnet, like cXCH/streaming-ui. Pre-launch validation still runs on the simulator and testnet11 (§11). |
| **Fees** | **Flat protocol fee** | A protocol fee of **0.5%** (50 bps) is taken on **create** only, paid to `PROTOCOL_FEE_PUZZLE_HASH` (a constant to set before launch), in addition to the network tx fee. No fee on claim/clawback/transfer/sale. See §4.8 and §10. |

### 0.2 Open feasibility gates (verify during implementation)

- **Rue version & syntax.** cXCH pins Rue `0.6.0` but ships no real `.rue` puzzle, so that pin is untested for actual puzzles. Bump the pin to the latest stable Rue and commit a `stream.rue` that compiles (`rue build`) before relying on the §2.3 listing; the struct-spread / union / `assert` / `is`-narrowing constructs must be confirmed against the pinned compiler.
- **`chia-sdk-driver` 0.27 surface.** Confirm it can wrap an arbitrary inner puzzle in the CAT layer, emit `SEND_MESSAGE`/`RECEIVE_MESSAGE` conditions, and build/parse an `Offer` around a custom maker spend. CAT + offers are proven by cXCH; the custom inner puzzle + message coordination is the unproven part.
- **Open-offer take routing.** Our annuity does *not* park at `OFFER_MOD` (its onward move needs a message from `recipient`, and `OFFER_MOD` sends none). Instead the maker authorizes the trade terms and the taker fills `new_recipient` in the (unsigned) streaming-coin spend at take time. Prove this end-to-end in the simulator.

## Key facts this design relies on

1. **The real `stream.clsp` curries a puzzle hash, not a pubkey.** The beneficiary is `RECIPIENT`, a 32-byte p2 puzzle hash. There is no signature condition inside the puzzle; the recipient authorizes a claim by co-spending one of their own coins that sends a message to the streaming coin.
2. **CHIP-0041 vesting.** `to_pay = my_amount * (payment_time - last_payment_time) / (end_time - last_payment_time)`. The base puzzle asserts the caller-supplied `to_pay` equals this exactly; our Rue port computes it in-puzzle. Claimable accumulates until claimed; the issuer can claw back the future portion; clawbacks pay the already-claimable amount to the recipient. Setting the clawback to `nil` disables it permanently.
3. **CAT-denominated.** The streaming puzzle is the **inner** puzzle of a CAT; the coin's asset id is the underlying token's TAIL hash. All annuities in the same token share that asset id, but each annuity coin is unique because its inner puzzle is curried with that annuity's recipient, clawback, and timestamps — so an annuity is a unique asset (NFT-like for trading), not a fungible balance.
4. **Offers use the settlement-payments puzzle (`OFFER_MOD`).** Verified against `chia/wallet/trading/offer.py`: requested payments are notarized with `nonce = tree_hash(sorted offered coin ids)`; on fill, `OFFER_MOD` `CREATE_PUZZLE_ANNOUNCEMENT`s `tree_hash((nonce,[payments]))` and `CREATE_COIN`s the payments to the maker; every maker spend `AssertPuzzleAnnouncement`s `sha256(settlement_ph + msg)`, binding transfer ⇆ payment. The offer file is the maker's compressed, bech32 `offer1…` partial bundle; takers fill via `Offer.aggregate` / `to_valid_spend`. `chia-sdk-driver` (`offers` feature) exposes the settlement layer and an `Offer` type. An annuity sale offers the annuity coin on one side and requests XCH or a CAT on the other.
5. **Rue compiles to CLVM with a std prelude.** Conditions are typed structs (`CreateCoin`, `AssertMyAmount`, `ReceiveMessage`, …) auto-imported from the prelude. `tree_hash(value)` and `curry_tree_hash(mod_hash, [param_hashes])` give the puzzle-hash arithmetic needed to recreate a continuation coin under new curried parameters. `rue build <file> --hex --hash` emits the CLVM hex and its tree hash.
6. **`streaming-ui` frontend stack** (mirrored where useful): Next.js `15.2.1`, React `^19`, `@walletconnect/sign-client@^2.19.0`, `qrcode.react`, `react-hot-toast`, with `next.config.ts` enabling `asyncWebAssembly` and a dual `webassemblyModuleFilename`. cXCH adds `output: "export"` and uses React context (not Redux) — we follow cXCH.

## 1. Background Primitives

### 1.1 The annuity = a CHIP-0041 stream
A streaming coin holds the full annuity principal as a CAT amount. Two timestamps define vesting: the start (the initial `last_payment_time`) and `end_time`. At any moment `payment_time`, the vested-but-unclaimed amount is

```
to_pay = my_amount * (payment_time - last_payment_time) / (end_time - last_payment_time)
```

A naive design would pay out in tiny increments and bleed fees; CHIP-0041 instead lets the balance accrue on-chain and be claimed in one spend whenever the beneficiary wants.

### 1.2 Claim (recipient-authorized via message)
A claim spend:
1. Asserts the coin's amount with `ASSERT_MY_AMOUNT`.
2. Asserts the time with `ASSERT_SECONDS_ABSOLUTE`.
3. Pays the beneficiary `to_pay` (skips a zero coin).
4. Recreates the continuation coin holding `my_amount - to_pay`, identical except `last_payment_time = payment_time`.
5. Emits `RECEIVE_MESSAGE` (mode `23`) requiring a matching `SEND_MESSAGE` from a coin whose puzzle hash equals `recipient`. That sibling spend — a standard p2 coin owned by the recipient — is what carries the recipient's signature. This is how an otherwise-permissionless spend is bound to the owner.

### 1.3 Clawback (optional, issuer-authorized)
If a clawback puzzle hash is curried in, the issuer can terminate early: pay the already-accrued amount to the beneficiary, return the unvested remainder to the clawback puzzle hash, and require a message from a coin whose puzzle hash equals the clawback authority. If the clawback is curried as `nil`, this path is disabled and the annuity is a permanent commitment — the right default for an annuity that has been sold or gifted.

### 1.4 The CAT layer and asset id
The streaming puzzle is the **inner** puzzle of a CAT. The coin's asset id is the underlying token's TAIL hash. Each annuity coin is unique because its inner puzzle is curried with that annuity's `recipient`, `clawback_ph`, and timestamps. Consequently an annuity is a unique asset (NFT-like for trading purposes), not a fungible balance.

### 1.5 The Rust driver
Rather than the SDK's `StreamedCat` (which models the original Chialisp puzzle), we keep an `AnnuityInfo` struct mirroring the Rue puzzle's curried parameters and a small set of spend builders over `chia-sdk-driver`'s `SpendContext` and CAT driver. These construct the launch, claim, clawback, transfer, and offer spends against our compiled Rue puzzle. See §4.

### 1.6 Offers and settlement payments
A Chia offer is a partial `SpendBundle`: the maker spends the asset they are giving such that the spend requires a puzzle announcement from a settlement-payments puzzle, which can only be produced if the requested counter-payment is also made. Because the settlement puzzle can wrap any asset, an annuity sale offers the annuity coin on one side and requests XCH or a CAT on the other.

## 2. Puzzle Design: Rue Port + Transfer Mode

### 2.0 The source puzzle (Chialisp, for reference only)

This is Yakuhito's `puzzles/stream.clsp` verbatim — the behavior our Rue port must reproduce. **It does not ship in Xchannuity;** it is reproduced here only as the conversion source.

```chialisp
; stream.clsp by yakuhito
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

    (if (= to_pay (/ (* my_amount (- payment_time LAST_PAYMENT_TIME)) (- END_TIME LAST_PAYMENT_TIME)))
        (list
            (list ASSERT_MY_AMOUNT my_amount)
            (i clawback
                (list ASSERT_BEFORE_SECONDS_ABSOLUTE payment_time)
                (list ASSERT_SECONDS_ABSOLUTE payment_time)
            )
            (i (= to_pay ())
                (list REMARK)
                (list CREATE_COIN RECIPIENT to_pay (list RECIPIENT))
            )
            (i (= my_amount to_pay)
                (list REMARK)
                (list
                    CREATE_COIN
                    (i clawback
                        CLAWBACK_PH
                        (curry_hashes_inline SELF_HASH
                            (sha256 1 SELF_HASH)
                            (sha256 1 payment_time)
                        )
                    )
                    (- my_amount to_pay)
                    (list (sha256 's' RECIPIENT))
                )
            )
            (list
                RECEIVE_MESSAGE
                23 ; sender puzzle hash, receiver coin id
                payment_time
                (i clawback CLAWBACK_PH RECIPIENT)
            )
        )
        (x)
    )
)
```

**Why it cannot be transferred as-is.** `RECIPIENT`, `CLAWBACK_PH`, and `END_TIME` live in the *first* curry layer, whose tree hash is `SELF_HASH` — curried into the *second* layer as an opaque constant. The continuation coin is recreated by re-currying only the second layer (`SELF_HASH`, `LAST_PAYMENT_TIME`). To change `RECIPIENT` the puzzle would have to recompute `SELF_HASH`, which it cannot do without the base mod hash and the other first-curry params in scope. Our Rue port flattens this.

### 2.1 Authorization model (no in-puzzle signatures)

The source puzzle emits no `AGG_SIG_ME`. Instead it requires a `RECEIVE_MESSAGE` (mode `23` = `SENDER_PUZZLE | RECEIVER_COIN`): some coin whose **puzzle hash** equals `recipient` (or `clawback_ph`) must `SEND_MESSAGE` the same body to **this coin's id**. In practice the recipient co-spends one of their standard p2 coins; that standard spend carries the `AGG_SIG_ME` the wallet produces. Authorization is therefore delegated to the owner's normal wallet signature, not embedded in the streaming puzzle.

**Transfer reuses this exactly.** To reassign ownership, the *current* recipient co-spends a p2 coin that sends a message whose body **is the new recipient's puzzle hash**, to the streaming coin's id. Because the body is the destination and the standard spend signs over its own conditions, a mempool watcher cannot rewrite the destination, and only the current owner can author the transfer. This is strictly faithful to the repo's design philosophy and avoids inventing a new signature scheme.

### 2.2 Curried parameters and solution (Rue port)

To make ownership mutable we curry a single flattened `Stream` struct plus the module's own `mod_hash` (singleton-style), so the puzzle can recompute its continuation hash under *any* changed field — including `recipient`.

**Curried (the `Stream` struct):**

| Field | Type | Meaning |
|---|---|---|
| `mod_hash` | `Bytes32` | `tree_hash(main)` — the uncurried module hash, curried in for self-recreation |
| `recipient` | `Bytes32` | current beneficiary p2 puzzle hash (the "owner") |
| `clawback_ph` | `Bytes32 \| nil` | `nil` ⇒ permanent, non-clawbackable annuity |
| `end_time` | `Int` | unix seconds; fully vested at this time |
| `last_payment_time` | `Int` | start time; advanced to `payment_time` on each claim |

**Solution:**

| Field | Type | Meaning |
|---|---|---|
| `mode` | `Int` | `CLAIM (0) \| CLAWBACK (1) \| TRANSFER (2)` |
| `my_amount` | `Int` | current remaining amount (for `ASSERT_MY_AMOUNT`) |
| `payment_time` | `Int` | time being asserted (`≤ end_time`); ignored for transfer |
| `new_recipient` | `Bytes32` | `TRANSFER` only: the new owner puzzle hash (taker-supplied in an offer) |
| `settlement_id` | `Bytes32 \| nil` | `TRANSFER` only: nil ⇒ plain transfer; set ⇒ transfer-via-offer, the settlement announcement id to assert (§2.4) |

### 2.3 The Rue puzzle (design sketch)

`cxch-core/puzzles/stream.rue` — illustrative; implementers must `rue build` it, diff behavior against `stream.clsp` in the simulator, and pin the resulting `--hash` before any mainnet use. Conditions, `tree_hash`, `curry_tree_hash`, and the message-flag constants come from the Rue std prelude.

```rue
// stream.rue — CHIP-0041 streaming annuity, ported from Yakuhito/streaming
// and extended with an owner-authorized TRANSFER mode. Inner puzzle of a CAT.

inline const CLAIM: 0 = 0;
inline const CLAWBACK: 1 = 1;
inline const TRANSFER: 2 = 2;

// 0b010_111: sender committed by puzzle hash, this (receiver) coin by full coin id
inline const STREAM_MSG_MODE: 23 = SENDER_PUZZLE | RECEIVER_COIN;

struct Stream {
    mod_hash: Bytes32,             // tree_hash(main); curried in for self-recreation
    recipient: Bytes32,            // current beneficiary p2 puzzle hash
    clawback_ph: Bytes32 | nil,    // nil => permanent annuity
    end_time: Int,
    ...last_payment_time: Int,     // start time; advanced on each claim
}

// This puzzle's hash with `stream` curried in — used to recreate the coin.
inline fn stream_puzzle_hash(stream: Stream) -> Bytes32 {
    curry_tree_hash(stream.mod_hash, [tree_hash(stream)])
}

inline fn vested(stream: Stream, my_amount: Int, payment_time: Int) -> Int {
    my_amount * (payment_time - stream.last_payment_time)
              / (stream.end_time - stream.last_payment_time)
}

fn main(
    stream: Stream,        // curried
    // --- solution ---
    mode: Int,
    my_amount: Int,
    payment_time: Int,
    new_recipient: Bytes32,
    settlement_id: Bytes32 | nil,   // set ⇒ transfer-via-offer (see §2.4)
) -> List<Condition> {
    if mode == TRANSFER {
        transfer(stream, my_amount, new_recipient, settlement_id)
    } else {
        stream_out(stream, mode == CLAWBACK, my_amount, payment_time)
    }
}

// CLAIM / CLAWBACK: pay the vested amount, then either recreate the
// continuation (claim) or return the remainder to the issuer (clawback).
fn stream_out(stream: Stream, clawback: Bool, my_amount: Int, payment_time: Int) -> List<Condition> {
    let to_pay = vested(stream, my_amount, payment_time);
    let remainder = my_amount - to_pay;

    let payout = if to_pay == 0 {
        Remark {}
    } else {
        CreateCoin {
            puzzle_hash: stream.recipient,
            amount: to_pay,
            memos: Memos { value: [stream.recipient] },
        }
    };

    let continuation = if remainder == 0 {
        Remark {}
    } else if clawback {
        assert !(stream.clawback_ph is nil);
        CreateCoin { puzzle_hash: stream.clawback_ph, amount: remainder, memos: nil }
    } else {
        let next = Stream {
            mod_hash: stream.mod_hash,
            recipient: stream.recipient,
            clawback_ph: stream.clawback_ph,
            end_time: stream.end_time,
            last_payment_time: payment_time,
        };
        CreateCoin {
            puzzle_hash: stream_puzzle_hash(next),
            amount: remainder,
            memos: Memos { value: [stream.recipient] },
        }
    };

    let time_assert = if clawback {
        AssertBeforeSecondsAbsolute { seconds: payment_time }
    } else {
        AssertSecondsAbsolute { seconds: payment_time }
    };

    let sender_ph = if clawback { stream.clawback_ph } else { stream.recipient };

    [
        AssertMyAmount { amount: my_amount },
        time_assert,
        payout,
        continuation,
        ReceiveMessage { mode: STREAM_MSG_MODE, message: payment_time as Bytes, sender: [sender_ph] },
    ]
}

// TRANSFER (new): reassign ownership without claiming. The whole remaining coin
// is recreated under new_recipient; term and accrual state are preserved.
//
//  * Plain transfer (settlement_id == nil): the current recipient authorizes the
//    DESTINATION — the SEND_MESSAGE body is new_recipient, binding it against
//    mempool rewrites.
//  * Transfer-via-offer (settlement_id set): the current recipient authorizes the
//    TRADE TERMS — the message body is the settlement announcement id, and the
//    puzzle ASSERTs that announcement (the requested payment). The TAKER supplies
//    new_recipient (themselves). Open-offer mechanism (§2.4); mirrors how NFTs let
//    the taker assign the new owner while the maker commits only to price.
fn transfer(stream: Stream, my_amount: Int, new_recipient: Bytes32, settlement_id: Bytes32 | nil) -> List<Condition> {
    let next = Stream {
        mod_hash: stream.mod_hash,
        recipient: new_recipient,
        clawback_ph: stream.clawback_ph,
        end_time: stream.end_time,
        last_payment_time: stream.last_payment_time,
    };
    let auth_body = if settlement_id is nil { new_recipient } else { settlement_id };
    let base = [
        AssertMyAmount { amount: my_amount },
        CreateCoin {
            puzzle_hash: stream_puzzle_hash(next),
            amount: my_amount,
            memos: Memos { value: [new_recipient] },
        },
        ReceiveMessage { mode: STREAM_MSG_MODE, message: auth_body, sender: [stream.recipient] },
    ];
    if settlement_id is nil {
        base
    } else {
        // bind transfer <-> payment: id = sha256(settlement_ph + tree_hash((nonce, payments)))
        [AssertPuzzleAnnouncement { id: settlement_id }, ...base]
    }
}
```

Notes:
- `stream_puzzle_hash` is the Rue equivalent of the Chialisp `curry_hashes_inline` self-recreation. Because `mod_hash` and the whole `Stream` struct are curried, recreating the coin under a changed `recipient` or `last_payment_time` is a single `curry_tree_hash` call — which is precisely what makes transfer expressible where the original could not.
- The CAT outer layer wraps all of the above; the inner-puzzle hashes in each `CreateCoin` are re-wrapped into CAT puzzle hashes by the `chia-sdk-driver` CAT driver off-chain, and lineage accounting is handled by the SDK.
- Transfer deliberately does not claim accrued value: the new owner receives the entire remaining coin including any already-vested-but-unclaimed amount. (If "claim on transfer" is preferred, emit the claim payout to the old owner before the continuation; keep one behavior and document it in the UI.)
- The `assert`/union-narrowing on `clawback_ph` and the `sender_ph` union are the parts most likely to need a Rue idiom tweak at compile time; treat this listing as a faithful sketch, not drop-in code.

### 2.4 Selling via offer (transfer bound to settlement)

A Chia offer is a partial `SpendBundle` (the maker's side) compressed and bech32-encoded as `offer1…`. The taker fills it by aggregating their payment spends. The whole trade is bound atomically by the **settlement-payments puzzle** (`OFFER_MOD`, hash `OFFER_MOD_HASH` — both from `chia_puzzles_py`) and a puzzle-announcement handshake. This is verbatim how `chia-blockchain`'s wallet builds CAT/NFT offers (`chia/wallet/trading/offer.py`, `chia/wallet/nft_wallet/`); we reuse the asset-agnostic machinery and supply our own maker spend for the annuity side.

**The settlement handshake (the part we must satisfy):**

1. **Notarized payments + nonce.** The requested payments are notarized with a single `nonce = tree_hash(sorted([coin_as_list(c) for c in offered_coins]))` — the tree hash of every offered coin id, sorted (`Offer.notarize_payments`). Each notarized payment is `(puzzle_hash, amount, ...memos)` sharing that nonce.
2. **Settlement announcement.** When filled, `OFFER_MOD` (curried into the requested asset's layer — bare `OFFER_MOD_HASH` for XCH, CAT-wrapped for a CAT) `CREATE_PUZZLE_ANNOUNCEMENT`s `msg = tree_hash((nonce, [payment_args…]))` and `CREATE_COIN`s each payment to the maker (`Offer.calculate_announcements`).
3. **Maker asserts it.** Every maker spend must `AssertPuzzleAnnouncement { id: sha256(settlement_ph + msg) }`. The annuity only moves if the buyer's payment side is spent in the same bundle. **This `id` is exactly the `settlement_id` our `transfer` path asserts (§2.3).**

**Two wirings** (the NFT-trade path is the precedent for a unique, ownership-bearing coin):

1. **Open offer (recommended).** The maker spends the annuity in `TRANSFER` mode with `settlement_id` set to the computed announcement id, and co-spends a coin sending the authorizing message whose body **is that `settlement_id`** — i.e. the owner signs *"sell on these terms"*, not *"sell to address X"*. The `new_recipient` field is left for the **taker** to fill with their own puzzle hash when completing — exactly how an NFT offer lets the taker assign the new owner while the maker commits only to price (`make_nft1_offer` passes `announcements_to_assert` into the NFT spend; the taker designates the recipient). Result: a normal `offer1…` file fillable by anyone who pays the ask.
2. **Direct, named-buyer (closed).** Plain `TRANSFER` (`settlement_id == nil`) with the message body = the buyer's `new_recipient`, plus the settlement assertion injected as an extra condition. Simpler, but only that one address can take it.

**Crucially, our annuity needs none of the NFT ownership-layer / transfer-program machinery.** An NFT is a singleton and re-assigns ownership by re-currying an *ownership layer* whose transfer program reads `new_owner` from the solution. Our annuity is a plain CAT-wrapped coin whose *inner* puzzle already carries the owner (`recipient`) and a transfer mode, so re-assignment is just our `transfer` recreating the coin under a new `recipient` — the message authorization substitutes for the NFT transfer program's `current_owner` check, and the `settlement_id` assertion substitutes for the trade-price commitment.

Build the maker `Offer` and parse/fill takers with `chia-sdk-driver`'s offers feature (`Offer`, the settlement layer); validate end-to-end in the simulator before mainnet.

**Interoperability (scope).** These offer files are filled by **Xchannuity's own take flow only.** A generic wallet builds the take side from the offer's `driver_dict` — a `PuzzleInfo` describing each offered asset — but the streaming puzzle is not a registered driver, so third-party wallets and Sage's `chia_takeOffer` cannot route it. The dApp's `build_take_offer` (§4.6) supplies the missing routing: it injects the taker's puzzle hash as `new_recipient` into the parked streaming-coin spend and pays the requested side into `OFFER_MOD`. Generic interoperability would require authoring and upstreaming a `chia-wallet-sdk` driver for the streaming puzzle — explicitly out of scope (§0.1).

### 2.5 Security of the transfer path
- **Authorization & binding:** transfer requires a `SEND_MESSAGE` from a coin whose puzzle hash is the current `recipient`, committed to this coin's id (mode `23`). The authorizing standard spend signs its own conditions, so it cannot be forged or rewritten by a mempool watcher. For a **plain transfer** the message body is `new_recipient` (binds the destination); for a **transfer-via-offer** it is the `settlement_id` (binds the trade terms — the requested payment — while letting the taker name themselves as recipient). In the offer case the puzzle also `AssertPuzzleAnnouncement { id: settlement_id }`, so the annuity cannot move unless the buyer's payment side is spent in the same bundle.
- **Clawback interaction:** if the annuity still carries a clawback, transferring it does not remove the issuer's clawback right. Xchannuity's sell flow refuses to list (or loudly flags) any annuity whose `clawback_ph ≠ nil`. Product rule: only permanent annuities are sellable; clawbackable ones are transferable only with a prominent warning.
- **Accrual integrity:** transfer preserves `last_payment_time` and the amount, so vesting math is unchanged across owners.

## 3. System Architecture

```
+-----------------------------------------------------------------+
|  Next.js 15 / React 19 dApp (browser, static export)            |
|                                                                 |
|  Landing page  ──(no session)──►  shown                         |
|       │  useSage().session ?                                    |
|       └──(session)──►  dApp: Create · Claim · Transfer · Sell    |
|     ┌─────────────────────────────┐   ┌──────────────────────┐  |
|     │ xchannuity-core (Rust→WASM) │   │ @walletconnect/      │  |
|     │  embeds stream.rue.hex      │   │  sign-client 2.19    │  |
|     │  build_create_annuity()     │   │  → Sage (chia:*)     │  |
|     │  build_claim()              │   │  chip0002_signCoin.. │  |
|     │  build_clawback()           │   │  chip0002_getAsset.. │  |
|     │  build_transfer()           │   │  chia_getCurrentAddr │  |
|     │  build_sell_offer()         │   └──────────┬───────────┘  |
|     │  build_take_offer()         │              │ signatures   |
|     │  parse_annuity()            │              │              |
|     └──────────────┬──────────────┘              │              |
|                    │ unsigned CoinSpend[] / Offer │              |
|                    └───────────────┬──────────────┘             |
|                                    ▼                            |
|              SpendBundle / Offer assembly + push_tx             |
+------------------------------------+----------------------------+
                                     ▼
                       Chia full node (api.coinset.org)
```

Two off-chain pieces run in the browser: a deterministic Rust→WASM builder (which embeds the compiled Rue puzzle hex) and a stateful WalletConnect client. No server component; deploys as a static site (`next build` → `out/`), matching cXCH.

## 4. Rust Core

### 4.1 Cargo.toml

Pinned to the **chia-sdk sub-crates** (cXCH-proven, WASM-safe). Do **not** add the umbrella `chia-wallet-sdk` — it pulls `chia-sdk-client` (tokio + TLS) which breaks `wasm32-unknown-unknown`.

```toml
[package]
name = "xchannuity-core"
version = "0.1.0"
edition = "2021"
description = "Spend-bundle builder for Xchannuity, a transferable streamed-CAT annuity on Chia"
license = "MIT"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
chia-sdk-driver    = "0.27"
chia-sdk-types     = "0.27"
chia-sdk-signer    = "0.27"
chia-sdk-utils     = "0.27"
chia-puzzle-types  = "0.26"
chia-puzzles       = "0.20"
chia-protocol      = "0.26"
chia-bls           = "0.26"
clvm-traits        = "0.26"
clvm-utils         = "0.26"
clvmr              = "0.14"

wasm-bindgen       = "0.2"
serde              = { version = "1", features = ["derive"] }
serde_json         = "1"
serde-wasm-bindgen = "0.6"
hex                = "0.4"
thiserror          = "1"
getrandom          = { version = "0.2", features = ["js"] }   # mandatory for wasm32

[dev-dependencies]
chia-sdk-test = "0.27"
anyhow        = "1"

[profile.release]
opt-level     = "z"
lto           = true
codegen-units = 1
panic         = "abort"

[package.metadata.wasm-pack.profile.release]
wasm-opt = false   # avoids the binaryen network fetch at build time
```

The compiled Rue puzzle is embedded at build time, e.g. `const STREAM_PUZZLE_HEX: &str = include_str!("../puzzles/stream.rue.hex");`, parsed to a CLVM program once, and its tree hash asserted against the committed `stream.rue.hash` in a unit test.

### 4.2 Module layout

```
cxch-core/                      # (named xchannuity-core for this project)
├── Cargo.toml
├── puzzles/                    # Rue entrypoint (see Rue.toml)
│   ├── stream.rue              # the streaming + transfer inner puzzle
│   ├── stream.rue.hex          # compiled CLVM (rue build output, committed)
│   └── stream.rue.hash         # tree hash (rue build --hash, committed)
└── src/
    ├── lib.rs                  # wasm-bindgen surface
    ├── constants.rs            # genesis challenges; embedded puzzle hex + mod hash
    ├── dto.rs                  # serde DTOs for coins, spends, requests, responses
    ├── info.rs                 # AnnuityInfo: curry/uncurry the Stream struct, puzzle hash
    ├── annuity.rs              # create / claim / clawback spend builders
    ├── transfer.rs             # transfer spend (mode 2) + the owner message spend
    ├── offer.rs                # build_sell_offer / build_take_offer (settlement layer)
    ├── view.rs                 # parse a coin into AnnuityStatus; stream-id codec
    └── error.rs
```

### 4.3 Info, currying, and self-recreation

`AnnuityInfo` mirrors the Rue `Stream` struct. Currying and the continuation puzzle hash are computed in Rust the same way the puzzle computes them, so the driver and the puzzle agree byte-for-byte.

```rust
use chia_protocol::Bytes32;
use chia_sdk_driver::SpendContext;

pub struct AnnuityInfo {
    pub recipient: Bytes32,
    pub clawback_ph: Option<Bytes32>,   // None => permanent
    pub end_time: u64,
    pub last_payment_time: u64,
}

impl AnnuityInfo {
    /// Inner puzzle hash = curry_tree_hash(STREAM_MOD_HASH, [tree_hash(Stream{..})]).
    /// Mirrors `stream_puzzle_hash` in stream.rue.
    pub fn inner_puzzle_hash(&self) -> Bytes32 { /* curry + tree hash */ todo!() }

    /// The continuation after a claim: same fields, last_payment_time = payment_time.
    pub fn after_claim(&self, payment_time: u64) -> Self { /* clone w/ new time */ todo!() }

    /// The continuation after a transfer: same fields, recipient = new.
    pub fn after_transfer(&self, new_recipient: Bytes32) -> Self { /* clone w/ new recipient */ todo!() }
}
```

### 4.4 Create / Claim / Clawback

```rust
#[derive(serde::Deserialize)]
pub struct CreateAnnuityRequest {
    pub source_cat_coins: Vec<CatCoinDto>,    // funding CAT coins (the principal)
    pub source_inner_phs: Vec<Bytes32>,
    pub asset_id: Bytes32,                    // underlying token TAIL hash
    pub recipient_puzzle_hash: Bytes32,       // beneficiary p2 puzzle hash
    pub clawback_puzzle_hash: Option<Bytes32>,// None => permanent annuity
    pub principal_mojos: u64,
    pub start_time: u64,
    pub end_time: u64,
    pub fee_mojos: u64,
    pub genesis_challenge: Bytes32,
}

pub fn build_create_annuity(req: CreateAnnuityRequest) -> Result<UnsignedBundle, Error> {
    let mut ctx = SpendContext::new();
    let info = AnnuityInfo {
        recipient: req.recipient_puzzle_hash,
        clawback_ph: req.clawback_puzzle_hash,
        end_time: req.end_time,
        last_payment_time: req.start_time,
    };
    // Spend the funding CAT coins into a CAT whose inner puzzle hash is
    // info.inner_puzzle_hash(); the CAT driver wraps it and tracks lineage.
    let inner_ph = info.inner_puzzle_hash();
    spend_cats_into(&mut ctx, &req, inner_ph)?;
    Ok(UnsignedBundle {
        coin_spends: drain_spends(&mut ctx),
        stream_id: stream_id_for(eve_coin_id(&ctx), req.genesis_challenge),
        issuer_partial_sig_hex: None,
    })
}
```

`build_claim` and `build_clawback` build two coordinated spends: (1) the streaming-coin spend with solution `(mode, my_amount, payment_time, nil)`, and (2) a tiny spend of one of the authorizing party's standard coins that emits `SEND_MESSAGE(23, payment_time, [stream_coin_id])` (claim → recipient's coin; clawback → clawback authority's coin). Sage signs the standard spend at sign time.

### 4.5 Transfer

```rust
#[derive(serde::Deserialize)]
pub struct TransferRequest {
    pub annuity_coin: CatCoinDto,
    pub lineage_proof: LineageProofDto,
    pub asset_id: Bytes32,
    pub current_recipient_ph: Bytes32,   // must control a coin to author the message
    pub new_recipient_ph: Bytes32,
    pub clawback_puzzle_hash: Option<Bytes32>,
    pub end_time: u64,
    pub last_payment_time: u64,
    pub authorizing_coin: CoinDto,       // a standard coin owned by current recipient
    pub fee_mojos: u64,
    pub genesis_challenge: Bytes32,
}

/// Recreates the annuity under new_recipient_ph with identical term and accrual.
pub fn build_transfer(req: TransferRequest) -> Result<UnsignedBundle, Error> {
    let mut ctx = SpendContext::new();
    let info = AnnuityInfo {
        recipient: req.current_recipient_ph,
        clawback_ph: req.clawback_puzzle_hash,
        end_time: req.end_time,
        last_payment_time: req.last_payment_time,
    };

    // 1. Spend the streaming coin in TRANSFER mode.
    let solution = stream_solution_transfer(req.annuity_coin.amount, req.new_recipient_ph);
    cat_spend_single(&mut ctx, &req.annuity_coin, &req.lineage_proof, req.asset_id,
                     info.inner_puzzle_hash(), solution, req.fee_mojos)?;

    // 2. Spend the current recipient's standard coin to SEND_MESSAGE(23,
    //    new_recipient_ph, [stream_coin_id]). Sage signs this at sign time.
    send_owner_message(&mut ctx, &req.authorizing_coin, req.current_recipient_ph,
                       req.new_recipient_ph, req.annuity_coin.coin_id())?;

    Ok(UnsignedBundle {
        coin_spends: drain_spends(&mut ctx),
        stream_id: stream_id_for(req.annuity_coin.coin_id(), req.genesis_challenge),
        issuer_partial_sig_hex: None,
    })
}
```

### 4.6 Sell / Buy

`build_sell_offer` (maker) — enforces `clawback_puzzle_hash.is_none()`, then:

1. **Notarize** the requested payment(s) with `nonce = tree_hash(sorted offered-coin ids)` (here, the single annuity coin id).
2. **Compute** the settlement announcement: `settlement_ph` = `OFFER_MOD_HASH` for XCH, or `OFFER_MOD` wrapped in the requested CAT's layer; `msg = tree_hash((nonce, [payment_args]))`; `settlement_id = sha256(settlement_ph + msg)`.
3. **Spend the annuity** in `TRANSFER` mode with that `settlement_id` and `new_recipient` left as the taker slot (open offer), and **co-spend** one of the owner's coins emitting `SEND_MESSAGE(23, settlement_id, [annuity_coin_id])`. Sage signs this maker side.
4. **Serialize** the partial bundle as an `Offer` (`chia-sdk-driver` offers feature) → bech32 `offer1…`.

```rust
#[derive(serde::Deserialize)]
pub struct SellOfferRequest {
    pub annuity_coin: CatCoinDto,
    pub lineage_proof: LineageProofDto,
    pub asset_id: Bytes32,                     // annuity's denomination
    pub owner_ph: Bytes32,                     // current recipient (maker)
    pub end_time: u64,
    pub last_payment_time: u64,
    pub request_asset: RequestedAsset,         // Xch { amount } | Cat { asset_id, amount }
    pub maker_receive_ph: Bytes32,             // where the maker is paid
    pub authorizing_coin: CoinDto,             // owner coin that sends the message
    pub fee_mojos: u64,
    pub genesis_challenge: Bytes32,
}
pub fn build_sell_offer(req: SellOfferRequest) -> Result<OfferDto, Error> { /* steps 1–4 */ todo!() }
```

`build_take_offer` (taker) — decodes the `offer1…`, supplies the **taker's puzzle hash as `new_recipient`** in the parked annuity's transfer solution, pays the requested asset into `OFFER_MOD` (which `CREATE_COIN`s the payment to the maker and announces), and aggregates the completing spends with the maker bundle (`Offer.aggregate` / `to_valid_spend`). Validate against `chia-blockchain`'s NFT-trade path in the simulator.

### 4.7 View / parse and the stream id

`view.rs` parses an annuity coin into an `AnnuityStatus` for the UI and encodes/decodes the bech32m stream id. The id is the bech32m encoding of the launch (eve) coin id with HRP `stream` (mainnet → `stream1…`) or `tstream` (testnet → `tstream1…`).

```rust
#[derive(serde::Serialize)]
pub struct AnnuityStatus {
    pub stream_id: String,
    pub asset_id_hex: String,
    pub recipient_hex: String,
    pub clawbackable: bool,
    pub principal_mojos: u64,
    pub remaining_mojos: u64,
    pub start_time: u64,
    pub end_time: u64,
    pub last_payment_time: u64,
    pub claimable_now_mojos: u64,   // computed against a passed-in `now`
    pub fully_vested_at: u64,
}
```

### 4.8 Protocol fee

A flat protocol fee is taken on **create only**, separate from the network tx fee:

- **Constant:** `PROTOCOL_FEE_BPS = 50` (0.5%) and `PROTOCOL_FEE_PUZZLE_HASH` in `constants.rs` — set the address before launch.
- **Create:** `build_create_annuity` carves `principal_mojos * PROTOCOL_FEE_BPS / 10_000` from the funding CATs into a `CREATE_COIN` to `PROTOCOL_FEE_PUZZLE_HASH` (a CAT coin in the annuity's denomination), and streams the remainder. Surface both the gross input and the net streamed principal in the UI preview.
- **Claim / clawback / transfer / sale:** no protocol fee (network tx fee only).

The fee output is listed in the "what am I signing" disclosure (§8) so the user sees the exact protocol cut before approving.

## 5. wasm-bindgen Surface (lib.rs)

Mirrors cXCH's pattern: `serde_wasm_bindgen` with the JSON-compatible serializer (numbers stay JS numbers, not BigInt), errors as `JsValue`.

```rust
use wasm_bindgen::prelude::*;
use serde_wasm_bindgen::{from_value, Serializer};
use serde::Serialize;

mod constants; mod dto; mod info; mod annuity; mod transfer; mod offer; mod view; mod error;

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsValue> {
    v.serialize(&Serializer::json_compatible()).map_err(|e| JsValue::from_str(&e.to_string()))
}

macro_rules! wasm_fn {
    ($name:ident, $module:path, $req:ty) => {
        #[wasm_bindgen]
        pub fn $name(req: JsValue) -> Result<JsValue, JsValue> {
            let r: $req = from_value(req).map_err(|e| JsValue::from_str(&e.to_string()))?;
            to_js(&$module(r).map_err(|e| JsValue::from_str(&e.to_string()))?)
        }
    };
}

wasm_fn!(build_create_annuity, annuity::build_create_annuity, annuity::CreateAnnuityRequest);
wasm_fn!(build_claim,          annuity::build_claim,          annuity::ClaimRequest);
wasm_fn!(build_clawback,       annuity::build_clawback,       annuity::ClawbackRequest);
wasm_fn!(build_transfer,       transfer::build_transfer,      transfer::TransferRequest);
wasm_fn!(build_sell_offer,     offer::build_sell_offer,       offer::SellOfferRequest);
wasm_fn!(build_take_offer,     offer::build_take_offer,       offer::TakeOfferRequest);

#[wasm_bindgen]
pub fn parse_annuity(coin: JsValue, now: u64) -> Result<JsValue, JsValue> {
    let c = from_value(coin).map_err(|e| JsValue::from_str(&e.to_string()))?;
    to_js(&view::parse_annuity(c, now).map_err(|e| JsValue::from_str(&e.to_string()))?)
}

#[wasm_bindgen]
pub fn stream_puzzle_hash_hex() -> String { constants::STREAM_MOD_HASH_HEX.to_string() }

#[wasm_bindgen]
pub fn aggregate_signatures(sigs: Vec<String>) -> Result<String, JsValue> {
    use chia_bls::{aggregate, Signature};
    let mut v = vec![];
    for s in sigs {
        v.push(Signature::from_bytes(&hex::decode(s.trim_start_matches("0x")).map_err(|_| JsValue::from_str("bad hex"))?
            .try_into().map_err(|_| JsValue::from_str("bad len"))?).map_err(|_| JsValue::from_str("bad sig"))?);
    }
    Ok(format!("0x{}", hex::encode(aggregate(&v).to_bytes())))
}
```

### 5.1 Build (Rue first, then WASM)

```bash
# 1. Compile the Rue puzzle to CLVM hex + tree hash (committed to the repo)
rue build cxch-core/puzzles/stream.rue --hex --hash

# 2. Build the Rust core to WASM (it include_str!s the hex from step 1)
cargo install wasm-pack
wasm-pack build cxch-core --release --target web --out-dir ../app/wasm-pkg
# emits xchannuity_core.js, xchannuity_core_bg.wasm, xchannuity_core.d.ts
```

`--target web` matches the cXCH packaging. The app imports the package via a tsconfig path alias `@wasm` → `./wasm-pkg/xchannuity_core.js`.

### 5.2 Rue.toml

At the core crate root, pin the Rue compiler and point its entrypoint at the puzzles directory (mirrors cXCH's `Rue.toml`):

```toml
[compiler]
version = "0.6.0"
entrypoint = "cxch-core/puzzles"
```

## 6. WASM Import Pattern (mirror cXCH / streaming-ui)

Deviating from this causes `Error occurred prerendering page "/"` and WebAssembly LinkErrors.

### 6.1 next.config.ts (verbatim shape from cXCH)

```ts
import type { NextConfig } from "next";

// Pure client-side SPA via static export. No SSR/API routes/edge runtime:
//  * WalletConnect's SignClient opens IndexedDB at construction (absent in Node).
//  * The xchannuity-core WASM bundle is browser-only.
//  * Sage integration is inherently client-side.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },

  webpack(config, { isServer, dev }) {
    config.externals.push("pino-pretty", "lokijs", "encoding");

    // Use the client static directory in the server bundle and prod mode.
    // Fixes `Error occurred prerendering page "/"`.
    config.output.webassemblyModuleFilename =
      isServer && !dev
        ? "../static/wasm/[modulehash].wasm"
        : "static/wasm/[modulehash].wasm";

    // Webpack 5 does not enable WebAssembly by default.
    config.experiments = { ...config.experiments, asyncWebAssembly: true };

    return config;
  },
};

export default nextConfig;
```

### 6.2 WASM initializer (app/lib/wasm.ts)

```ts
"use client";
import init, {
  build_create_annuity, build_claim, build_clawback,
  build_transfer, build_sell_offer, build_take_offer,
  parse_annuity, aggregate_signatures, stream_puzzle_hash_hex,
} from "@wasm";

let _ready: Promise<void> | null = null;
export function ensureWasm(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("browser only"));
  if (!_ready) _ready = init().then(() => {});
  return _ready;
}
export {
  build_create_annuity, build_claim, build_clawback,
  build_transfer, build_sell_offer, build_take_offer,
  parse_annuity, aggregate_signatures, stream_puzzle_hash_hex,
};
```

Call `init()` with no argument so webpack's `asyncWebAssembly` resolves the `.wasm`. In `page.tsx`, gate all rendering on `ensureWasm()` in a `useEffect` (show "Loading engine…" until ready) so static generation never touches WASM before `window` exists — exactly the cXCH gate.

## 7. Frontend: WalletConnect + the Landing Swap

### 7.1 WalletConnect provider (app/lib/walletconnect.tsx)

Follows cXCH: **`optionalNamespaces`** (Sage rejects the deprecated `requiredNamespaces` path), a pre-declared `METHODS` set, session restore from storage, and a 60-second request timeout (a backgrounded mobile Sage otherwise hangs forever).

```tsx
"use client";
import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import SignClient from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";
import toast from "react-hot-toast";

const PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "";
export const CHAIN_ID = process.env.NEXT_PUBLIC_CHIA_CHAIN_ID ?? "chia:mainnet";

const METHODS = [
  "chip0002_connect", "chip0002_chainId", "chip0002_getPublicKeys",
  "chip0002_getAssetCoins", "chip0002_getAssetBalance",
  "chip0002_signCoinSpends", "chia_getCurrentAddress",
];

interface Ctx {
  session: SessionTypes.Struct | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}
const WC = createContext<Ctx>(null as never);
export const useSage = () => useContext(WC);

export function WalletConnectProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<SignClient | null>(null);
  const [session, setSession] = useState<SessionTypes.Struct | null>(null);
  const [, setUri] = useState<string | null>(null);

  useEffect(() => {
    SignClient.init({
      logger: "error",
      projectId: PROJECT_ID,
      metadata: {
        name: "Xchannuity",
        description: "Create, transfer, and trade annuities on Chia",
        url: typeof window !== "undefined" ? window.location.origin : "",
        icons: ["/icon.svg"],
      },
    }).then((c) => {
      setClient(c);
      const last = c.session.getAll().pop();
      if (last) setSession(last);
      c.on("session_delete", () => setSession(null));
      c.on("session_expire", () => setSession(null));
    });
  }, []);

  const connect = useCallback(async () => {
    if (!client) return;
    const { uri, approval } = await client.connect({
      optionalNamespaces: { chia: { methods: METHODS, chains: [CHAIN_ID], events: [] } },
    });
    if (uri) setUri(uri);          // render a QR modal from this
    setSession(await approval());
    setUri(null);
    toast.success("Connected to Sage");
  }, [client]);

  const disconnect = useCallback(async () => {
    if (!client || !session) return;
    await client.disconnect({ topic: session.topic, reason: { code: 6000, message: "bye" } });
    setSession(null);
  }, [client, session]);

  const request = useCallback(async <T,>(method: string, params: unknown): Promise<T> => {
    if (!client || !session) throw new Error("Wallet not connected");
    const call = client.request<T>({ topic: session.topic, chainId: CHAIN_ID, request: { method, params } });
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("Sage did not respond — open the Sage app and try again.")), 60_000));
    return Promise.race([call, timeout]);
  }, [client, session]);

  return <WC.Provider value={{ session, connect, disconnect, request }}>{children}</WC.Provider>;
}
```

### 7.2 The landing-on-connect swap (app/page.tsx)

The marketing landing page is shown until a wallet session exists; on connect it is replaced by the dApp UI. The swap is a single ternary on `useSage().session` — the cXCH pattern.

```tsx
"use client";
import { useEffect, useState } from "react";
import { Toaster } from "react-hot-toast";
import { WalletConnectProvider, useSage } from "./lib/walletconnect";
import { ensureWasm } from "./lib/wasm";
import { Landing } from "./components/Landing";

function Content() {
  const { session } = useSage();
  return (
    <main className="mx-auto max-w-4xl p-6">
      {session ? (
        <div className="mx-auto flex w-full max-w-xl flex-col gap-5">
          {/* AnnuityList · CreatePanel · Claim/Transfer/Sell dialogs */}
        </div>
      ) : (
        <Landing />        {/* hero, how-it-works, ConnectButton */}
      )}
    </main>
  );
}

export default function Page() {
  const [ready, setReady] = useState(false);
  useEffect(() => { ensureWasm().then(() => setReady(true)).catch(console.error); }, []);
  return (
    <WalletConnectProvider>
      <Toaster position="bottom-center" />
      {ready ? <Content /> : <div className="p-8 text-center text-gray-400">Loading engine…</div>}
    </WalletConnectProvider>
  );
}
```

### 7.3 Sage command set used

| Method | Used by |
|---|---|
| `chip0002_getPublicKeys` | resolve the owner/recipient key; derive the authorizing standard coin |
| `chip0002_getAssetCoins` (`type: "cat", assetId`) | fund create; find annuities and authorizing XCH coins |
| `chip0002_getAssetBalance` | display balances |
| `chia_getCurrentAddress` | maker payout address; new-owner derivation |
| `chip0002_signCoinSpends` (`partialSign: true`) | sign each flow's coin spends (the streaming spend + the authorizing message spend) |

### 7.4 Sign-and-broadcast helper (app/lib/flow.ts)

```ts
import { aggregate_signatures } from "./wasm";

type RequestFn = (m: string, p: unknown) => Promise<any>;
export interface BuiltBundle { coin_spends: any[]; issuer_partial_sig_hex?: string | null; }

export async function signAndBroadcast(request: RequestFn, built: BuiltBundle): Promise<string> {
  const resp = await request("chip0002_signCoinSpends",
    { coinSpends: built.coin_spends, partialSign: true });
  // Sage returns the sig under varying field casings — normalize.
  const walletSig: string = resp.signature ?? resp.aggregatedSignature ?? resp.aggregated_signature ?? resp;
  const sigs = built.issuer_partial_sig_hex ? [walletSig, built.issuer_partial_sig_hex] : [walletSig];
  const aggregated = aggregate_signatures(sigs);
  const r = await fetch("https://api.coinset.org/push_tx", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ spend_bundle: { coin_spends: built.coin_spends, aggregated_signature: aggregated } }),
  });
  const j = await r.json();
  return j.status ?? "SUCCESS";
}
```

For an annuity (no TAIL co-signature, unlike cXCH's wrapped CAT) `issuer_partial_sig_hex` is null and the wallet signature is used directly. Each flow gathers inputs via `chip0002_getAssetCoins`, calls the matching `build_*`, then `signAndBroadcast`. Sell writes the returned offer string to a downloadable `.offer` file plus copy-to-clipboard and QR; Buy reads/pastes an offer string, calls `build_take_offer`, and broadcasts.

## 8. World-Class UX

The design goal: a non-crypto user understands, at a glance, what an annuity is worth right now and what they can do with it.

**Design system.** One accent color, generous whitespace, a single legible type scale, rounded cards, motion only where it communicates state (a smoothly advancing claimable counter). No dense tables on mobile; cards instead. Tailwind v4, as in both reference UIs.

**The annuity card (centerpiece).** For each annuity: a live vesting progress bar (start → now → end), a claimable-now figure that ticks upward in real time (interpolated client-side between blocks, recomputed from `parse_annuity` on each poll), total remaining, the end date with a human countdown ("vests fully in 4 months"), the denomination token, and a clawbackable/permanent badge. The primary action adapts: Claim when anything is claimable, otherwise Transfer or Sell.

**Create flow.** A guided form: token, amount, beneficiary (self or paste an address), term (presets 1/3/5/10 years or custom dates), and a permanent vs clawbackable toggle with plain-language consequences ("Permanent: you can never reclaim unvested funds. Required to sell this annuity."). A live preview card shows the vesting curve and per-day rate before signing.

**Claim flow.** One tap. Show the exact amount about to land and the fee. After success, animate the claimable counter resetting and the remaining balance stepping down, with a toast linking to the coin on a block explorer.

**Transfer flow.** Enter or paste the new owner's address; confirm a clear summary ("You are giving the entire remaining annuity, worth up to X over the remaining term, to <address>. This cannot be undone."), then sign. If the annuity is clawbackable, force an explicit acknowledgment that the issuer can still claw it back after transfer.

**Sell flow.** Choose the asking asset and amount (XCH or a CAT), see an instant fairness hint comparing the ask to the present value of the remaining stream (a time-discounted estimate, computed client-side, clearly labeled an estimate not an oracle), generate the offer, and manage it: copy string, download `.offer`, show QR, and a list of open offers with a cancel action (cancel = spend the annuity back to the owner, invalidating the offer).

**Buy flow.** Paste or upload an offer, render a preview of exactly what is received (term, remaining amount, vesting curve, clawbackable badge) versus what is paid, then one-tap accept.

**States and feedback.** Every async action has explicit pending/success/error toasts (`react-hot-toast`). Disable the action button and show a spinner while a spend is in the mempool; poll the coin record until confirmed, then refresh. Empty state invites creating a first annuity. Errors are plain language ("Sage rejected the signature", not a stack trace).

**Discovery.** Let users paste a stream id (`stream1…`/`tstream1…`) to load any annuity, and auto-list the connected wallet's annuities by fetching its CAT coins for known asset ids and filtering, in WASM, to those whose inner puzzle is our streaming puzzle. Cache discovered ids in local storage purely as convenience; never treat that cache as authoritative.

**Accessibility and trust.** Full keyboard navigation, visible focus rings, AA contrast, and a persistent "what am I signing" disclosure that lists every `CREATE_COIN` output (and the authorizing message) before the user approves in Sage.

## 9. Address, Asset, and Balance Handling

- Addresses from Sage are bech32m (`xch1…`/`txch1…`); convert to/from puzzle hashes in WASM.
- The annuity's denomination asset id is the underlying token TAIL hash; surface a friendly token name via a small built-in map or CATalog lookup.
- Balances: `chip0002_getAssetBalance` for the user's free token balance; annuity-held amounts come from `parse_annuity` on each discovered coin.
- Stream id: bech32m of the eve coin id, HRP `stream` (mainnet) / `tstream` (testnet).

## 10. Security Considerations

1. **Transfer authorization & destination binding.** Transfer requires a `SEND_MESSAGE` from a coin whose puzzle hash equals the current `recipient`, body = the new recipient, committed to the streaming coin's id (mode `23`). The authorizing standard spend signs its own conditions, so the destination cannot be rewritten by a mempool watcher. Verify the message construction and the `RECEIVE_MESSAGE` match in tests.
2. **Clawback vs sale.** Never let a clawbackable annuity be sold as if permanent. Enforce `clawback_ph == nil` before producing a sell offer; badge clawbackable annuities everywhere.
3. **Offer atomicity.** The maker bundle must assert the settlement-payment announcement so the annuity only transfers if the buyer pays. Use the coin id as the nonce. Confirm no path releases the annuity without the counter-payment.
4. **Accrual correctness.** `vested()` must clamp at `end_time`, use integer math that never lets the sum of claims exceed the principal, and round so dust cannot be extracted. Test boundary times (before start, exactly at end, far past end).
5. **Permanent-commitment guarantee.** When `clawback_ph == nil`, prove in tests that no spend path returns funds to the issuer; this is the property buyers rely on.
6. **Puzzle provenance (Rue).** The on-chain puzzle is `stream.rue`. CI must run `rue build stream.rue --hash` and assert it equals the `stream.rue.hash` constant compiled into the Rust core. The committed `stream.rue.hex` must match a fresh build bit-for-bit (deterministic compile with the pinned Rue `0.6.0`).
7. **Settlement reuse.** Model offer settlement on the audited NFT-trade path in `chia-sdk-driver`; do not invent a bespoke settlement scheme.
8. **Fee handling.** Network tx fee defaults to 0.0001 XCH (100,000,000 mojos); claims, transfers, and the authorizing message spend pay it in XCH — ensure the wallet has XCH and surface the amount. The **protocol fee** (§4.8, 0.5% on create only, paid in the annuity's CAT to `PROTOCOL_FEE_PUZZLE_HASH`) is separate and must be shown in the signing disclosure.
9. **Sage trust boundary.** Sage signs only spends for keys it controls and shows outputs for confirmation; the dApp cannot forge an owner transfer the wallet did not approve. The authorizing message spend is precisely the point where the owner's signature gates the transfer.
10. **Determinism and reproducibility.** Pin the Rust toolchain and `Cargo.lock`, pin the chia-sdk sub-crate versions, pin Rue `0.6.0`, and publish the WASM sha256 plus the `stream.rue.hash` so users can verify both the package and the on-chain puzzle.

## 11. Testing Strategy

**Rue tests.** Use `rue test` for puzzle-level unit tests of the vesting math and mode branching where expressible.

**Rust tests on the simulator.** `chia-sdk-test` ships a simulator. Cover: create → claim partial → claim remainder (sum equals principal exactly); create permanent → attempt clawback (must fail); create clawbackable → clawback (beneficiary gets accrued, issuer gets remainder); transfer → claim as new owner (continuation valid under new recipient); transfer preserves `last_payment_time` and amount; transfer without the authorizing message (must fail); transfer with a forged/rewritten destination (must fail); sell → take (annuity lands with the buyer, payment with the maker, atomic); take with insufficient payment (must fail).

**testnet11 integration.** Switch Sage to testnet11, fund TXCH, create a CAT, run the Sage RPC (`sage rpc start`, never alongside the Sage UI), validate create/claim/clawback against the baseline, then exercise Xchannuity's transfer and offer flows end-to-end through the dApp with Sage over WalletConnect. Broadcast via `https://api.coinset.org/push_tx?network=testnet11`.

**CI checks.** `cargo test`; `wasm-pack test --headless --firefox`; `rue build stream.rue --hex --hash` matches the committed `stream.rue.hex`/`stream.rue.hash` and the Rust-side mod-hash constant; an offer round-trip property test; a "permanent annuity is irreversible" canary.

## 12. Build & Run

**Prereqs:** Rust 1.78+ with `wasm32-unknown-unknown`; `wasm-pack`; the Rue CLI `0.6.0` (`cargo install` from `Rigidity/rue` at the matching tag); Node 20+; Sage Wallet from `sagewallet.net`; a WalletConnect Cloud project id.

```bash
# 0. Compile the Rue puzzle (commit the .hex and .hash)
rue build cxch-core/puzzles/stream.rue --hex --hash

# 1. core → WASM
wasm-pack build cxch-core --release --target web --out-dir ../app/wasm-pkg

# 2. app
cd app
npm install
cp .env.example .env.local   # NEXT_PUBLIC_WC_PROJECT_ID, NEXT_PUBLIC_CHIA_CHAIN_ID
npm run dev                  # http://localhost:3000
npm run build                # static export → app/out/
```

**Project layout**

```
xchannuity/
├── Rue.toml                         # [compiler] version = "0.6.0", entrypoint = "cxch-core/puzzles"
├── cxch-core/                       # Rust crate (named xchannuity-core)
│   ├── Cargo.toml
│   ├── puzzles/
│   │   ├── stream.rue               # the Rue streaming + transfer puzzle
│   │   ├── stream.rue.hex           # compiled CLVM (committed)
│   │   └── stream.rue.hash          # tree hash (committed)
│   └── src/{lib,constants,dto,info,annuity,transfer,offer,view,error}.rs
└── app/                             # Next.js 15 dApp (static export)
    ├── next.config.ts               # output: "export" + asyncWebAssembly
    ├── tsconfig.json                # path alias @wasm → ./wasm-pkg/xchannuity_core.js
    ├── package.json
    ├── wasm-pkg/                    # wasm-pack output
    └── app/
        ├── layout.tsx, page.tsx     # page.tsx holds the landing-on-connect swap
        ├── lib/{wasm,walletconnect,flow,format}.ts
        └── components/{Landing,ConnectButton,AnnuityCard,CreatePanel,ClaimButton,TransferDialog,SellDialog,BuyDialog,QrModal}.tsx
```

**Dependency parity (frontend):** `next@15.2.1`, `react@^19`, `react-dom@^19`, `@walletconnect/sign-client@^2.19.0`, `@walletconnect/types@^2.19.0`, `qrcode.react@^4.2.0`, `react-hot-toast@^2.5.2`, `@reduxjs/toolkit@^2.6.1` + `react-redux@^9.2.0` (optional — cXCH uses React context and so do we), Tailwind v4, plus the local WASM package at `./wasm-pkg`.

## 13. Caveats

- **The transfer mode is a real puzzle change.** The base CHIP-0041 puzzle has no transfer path. The Rue in §2.3 is a faithful design, not drop-in code: `rue build` it, diff behavior against `stream.clsp` in the simulator, and verify the mod hash and every branch before mainnet. The `clawback_ph` union narrowing and the `sender_ph` union are the most likely spots to need a Rue idiom adjustment.
- **Rue-only, pinned.** All on-chain logic is Rue. The Rue.toml pins compiler `0.6.0` (the version cXCH uses); the Rue language repo is currently at `0.8.4` with stable syntax, but the CLI version must match the pin or the build fails.
- **WASM dependency discipline.** Use the chia-sdk sub-crates, never the umbrella `chia-wallet-sdk` (it pulls `chia-sdk-client`/tokio/TLS and breaks `wasm32`). This is the single most common build failure for browser Chia cores.
- **Auth is message-based.** Unlike the original whitepaper's `AGG_SIG_ME OWNER_PUBKEY` sketch, authorization comes from a co-spent owner coin emitting `SEND_MESSAGE`. Every flow (claim, clawback, transfer, sell) builds that second spend, and Sage signs it.
- **Offer-trading a unique ownership coin is subtle.** It mirrors NFT trading; validate the new-owner-through-settlement wiring against the SDK's NFT offer path. The settlement-intermediate fallback (§2.4) is the documented alternative for open offers.
- **`chia-sdk-*` API drift.** Module paths and signatures vary across releases; the names here track the 0.27 line. Check against the pinned versions.
- **Sage is beta.** Its WalletConnect method names can change; prefer the `chip0002_*` namespace and `optionalNamespaces`. Run the Sage RPC and the Sage UI separately, never together.
- **Annuity discovery without an indexer is best-effort.** Pasting a stream id always works; auto-listing scans the wallet's CAT coins and filters in WASM. A small optional indexer keyed on the annuity asset ids improves UX without becoming authoritative state.

---

*This document is a design proposal for technical discussion and implementation. It has not been audited. The streaming puzzle is CHIP-0041 by Yakuhito; the Rue port, the transfer extension, and the offer integration described here are additions that must be independently reviewed and tested before any production or mainnet deployment.*
