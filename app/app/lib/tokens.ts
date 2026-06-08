// The only denominations Xchannuity supports — mirrors the on-chain allow-list
// (xchannuity-core/src/assets.rs). Verified ids/decimals (dexie + spacescan).
export interface Token {
  symbol: string;
  name: string;
  assetId: string; // 0x-prefixed
  decimals: number;
  /** XCH virtual token: balance is native XCH; create wraps XCH→cMOJO and claim
   *  melts cMOJO→XCH. `assetId` is the cMOJO bridge asset used under the hood. */
  isXch?: boolean;
}

// cMOJO is the wrapped-XCH bridge asset — never shown to users; "XCH" stands in
// for it (wrap on create, melt on claim).
export const CMOJO_ASSET_ID =
  "0x8808ca01803e09bf6d067075c9373b227aa8b086504ff0ac63cb3f02fe21c9ba";

export const SUPPORTED_TOKENS: Token[] = [
  {
    symbol: "XCH",
    name: "Chia",
    assetId: CMOJO_ASSET_ID, // under the hood the annuity is a cMOJO CAT
    decimals: 12,
    isXch: true,
  },
  {
    symbol: "wUSDC",
    name: "Ethereum warp.green USDC",
    assetId: "0xbbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e",
    decimals: 3,
  },
  {
    symbol: "wUSDC.b",
    name: "Base warp.green USDC",
    assetId: "0xfa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d",
    decimals: 3,
  },
  {
    symbol: "BYC",
    name: "Bytecash (Circuit DAO stablecoin)",
    assetId: "0xae1536f56760e471ad85ead45f00d680ff9cca73b8cc3407be778f1c0c606eac",
    decimals: 3,
  },
  // cMOJO is intentionally NOT listed in the picker. It is used only under the
  // hood as the wrapped-XCH bridge; the picker surfaces "XCH" instead once the
  // wrap/melt feature lands. Never shown to users as "cMOJO".
];

export function tokenByAssetId(assetId: string): Token | undefined {
  const norm = assetId.startsWith("0x") ? assetId : `0x${assetId}`;
  return SUPPORTED_TOKENS.find((t) => t.assetId.toLowerCase() === norm.toLowerCase());
}
