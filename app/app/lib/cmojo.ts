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
