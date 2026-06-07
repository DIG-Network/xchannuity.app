"use client";
// Adapts Sage / CHIP-0002 WalletConnect responses into the shapes our WASM
// builders expect. Sage returns coins/lineage in camelCase with wallet-specific
// keys; these normalizers accept both casings and tolerate 0x prefixes.
// Ported from the cXCH reference dApp.

import { standard_puzzle_hash, cat_puzzle_hash } from "./wasm";
import { strip0x, with0x } from "./format";

type RequestFn = <T = unknown>(method: string, params: unknown) => Promise<T>;
type AnyRecord = Record<string, unknown>;

function pick(obj: AnyRecord, ...keys: string[]): unknown {
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  return undefined;
}
function asString(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Math.round(v).toString();
  return String(v);
}

export interface CoinJson {
  parent_coin_info: string;
  puzzle_hash: string;
  amount: number;
}
export interface LineageProofJson {
  parent_parent_coin_info: string;
  parent_inner_puzzle_hash: string;
  parent_amount: number;
}

/** Coin from any wallet shape → snake_case + 0x. */
export function normalizeCoin(raw: unknown): CoinJson {
  const obj = raw as AnyRecord;
  const inner = (obj.coin ?? obj) as AnyRecord;
  return {
    parent_coin_info: with0x(asString(pick(inner, "parent_coin_info", "parentCoinInfo"))),
    puzzle_hash: with0x(asString(pick(inner, "puzzle_hash", "puzzleHash"))),
    amount: Number(pick(inner, "amount") ?? 0),
  };
}

/** CAT lineage proof from any wallet shape. Sage returns
 * `{ parentName, innerPuzzleHash, amount }`. */
export function normalizeLineageProof(raw: unknown): LineageProofJson {
  const obj = (raw ?? {}) as AnyRecord;
  return {
    parent_parent_coin_info: with0x(
      asString(pick(obj, "parentName", "parent_parent_coin_info", "parentParentCoinInfo", "parentCoinInfo")),
    ),
    parent_inner_puzzle_hash: with0x(
      asString(pick(obj, "innerPuzzleHash", "parent_inner_puzzle_hash", "parentInnerPuzzleHash")),
    ),
    parent_amount: Number(pick(obj, "parent_amount", "parentAmount", "amount") ?? 0),
  };
}

/** The coin id ("coin name") Sage attaches to each asset coin. */
export function extractCoinName(raw: unknown): string | undefined {
  const obj = raw as AnyRecord;
  const name = pick(obj, "coinName", "coin_name", "name");
  return typeof name === "string" && name.length > 0 ? with0x(name) : undefined;
}

export function extractPublicKeys(response: unknown): string[] {
  if (Array.isArray(response)) return response as string[];
  const obj = response as AnyRecord;
  const keys = pick(obj, "publicKeys", "public_keys", "keys");
  return Array.isArray(keys) ? (keys as string[]) : [];
}

export async function getPublicKeys(request: RequestFn): Promise<string[]> {
  const r = await request("chip0002_getPublicKeys", { limit: 500, offset: 0 });
  return extractPublicKeys(r).map(with0x);
}

/** The connected wallet's receive address (xch1…). Sage: `chia_getAddress`. */
export async function getAddress(request: RequestFn): Promise<string> {
  const r = await request("chia_getAddress", {});
  const addr =
    typeof r === "string"
      ? r
      : (pick(r as AnyRecord, "address", "data") as string | AnyRecord | undefined);
  const out = typeof addr === "string" ? addr : (pick(addr as AnyRecord, "address") as string);
  if (!out) throw new Error("Couldn't read your wallet address from Sage");
  return out;
}

/** All spendable coins for an asset (XCH when assetId null), paging Sage's window. */
export async function getAssetCoins(
  request: RequestFn,
  type: "cat" | null,
  assetId: string | null,
): Promise<unknown[]> {
  const PAGE = 100;
  const all: unknown[] = [];
  for (let offset = 0; offset < 20 * PAGE; offset += PAGE) {
    const page = await request<unknown[]>("chip0002_getAssetCoins", {
      type,
      assetId: assetId === null ? null : strip0x(assetId),
      includedLocked: false,
      offset,
      limit: PAGE,
    });
    const arr = Array.isArray(page) ? page : [];
    all.push(...arr);
    if (arr.length < PAGE) break;
  }
  return all;
}

export function sumCoinAmounts(coins: unknown[]): bigint {
  let total = 0n;
  for (const raw of coins) {
    try {
      total += BigInt(normalizeCoin(raw).amount);
    } catch {
      /* skip */
    }
  }
  return total;
}

/** Map a CAT coin's OUTER puzzle hash → the synthetic key that controls it. */
export function buildCatKeyResolver(
  keys: string[],
  assetId: string,
): (outerPuzzleHash: string) => string | undefined {
  const map = new Map<string, string>();
  for (const raw of keys) {
    const pk = with0x(raw);
    try {
      const inner = standard_puzzle_hash(pk);
      map.set(cat_puzzle_hash(assetId, inner).toLowerCase(), pk);
    } catch {
      /* not a valid key */
    }
  }
  return (ph: string) => map.get(with0x(ph).toLowerCase());
}

/** Map a standard (XCH) puzzle hash → the synthetic key that controls it. */
export function buildKeyResolver(keys: string[]): (puzzleHash: string) => string | undefined {
  const map = new Map<string, string>();
  for (const raw of keys) {
    const pk = with0x(raw);
    try {
      map.set(standard_puzzle_hash(pk).toLowerCase(), pk);
    } catch {
      /* skip */
    }
  }
  return (ph: string) => map.get(with0x(ph).toLowerCase());
}
