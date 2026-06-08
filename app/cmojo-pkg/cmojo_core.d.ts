/* tslint:disable */
/* eslint-disable */

/**
 * Converts a bech32m address into a `0x`-prefixed puzzle hash.
 */
export function address_to_puzzle_hash(address: string): string;

/**
 * Aggregates a list of `0x`-prefixed hex BLS signatures into one. Used to
 * combine the wallet's partial signature with the issuer's partial signature.
 */
export function aggregate_signatures(signatures: string[]): string;

/**
 * The canonical cMojo asset id (TAIL hash), as a `0x`-prefixed hex string.
 */
export function cmojo_asset_id(): string;

/**
 * The CAT2 outer puzzle hash for a cMojo coin with the given inner puzzle hash.
 */
export function cmojo_outer_puzzle_hash(inner_puzzle_hash: string): string;

/**
 * Derives the synthetic public key (with the default hidden puzzle) from an
 * observer public key. Wallets expose observer keys; the standard puzzle is
 * curried with the synthetic key.
 */
export function derive_synthetic_key(observer_key: string): string;

/**
 * The cMojo issuer public key, as a `0x`-prefixed hex string.
 */
export function issuer_public_key(): string;

/**
 * WASM: build the unsigned coin spends for a MELT (burn). The dev fee is
 * included.
 */
export function melt(request: any): any;

/**
 * Converts a `0x`-prefixed puzzle hash into a mainnet (`xch`) bech32m address.
 */
export function puzzle_hash_to_address(puzzle_hash: string): string;

/**
 * The standard puzzle hash for a synthetic public key.
 */
export function standard_puzzle_hash(synthetic_key: string): string;

/**
 * WASM: build the unsigned coin spends for a WRAP (mint). Returns
 * `{ coin_spends, issuer_partial_signature }`. The dev fee is included.
 */
export function wrap(request: any): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly address_to_puzzle_hash: (a: number, b: number) => [number, number, number, number];
    readonly aggregate_signatures: (a: number, b: number) => [number, number, number, number];
    readonly cmojo_asset_id: () => [number, number];
    readonly cmojo_outer_puzzle_hash: (a: number, b: number) => [number, number, number, number];
    readonly derive_synthetic_key: (a: number, b: number) => [number, number, number, number];
    readonly issuer_public_key: () => [number, number];
    readonly melt: (a: any) => [number, number, number];
    readonly puzzle_hash_to_address: (a: number, b: number) => [number, number, number, number];
    readonly standard_puzzle_hash: (a: number, b: number) => [number, number, number, number];
    readonly wrap: (a: any) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
