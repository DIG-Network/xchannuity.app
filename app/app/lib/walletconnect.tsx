"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import SignClient from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";
import toast from "react-hot-toast";

const PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "";
export const CHAIN_ID = process.env.NEXT_PUBLIC_CHIA_CHAIN_ID ?? "chia:mainnet";

// Pre-declared CHIP-0002 / Sage method set. Sage grants only these.
const METHODS = [
  "chip0002_connect",
  "chip0002_chainId",
  "chip0002_getPublicKeys",
  "chip0002_getAssetCoins",
  "chip0002_getAssetBalance",
  "chip0002_signCoinSpends",
  "chia_getAddress",
];

interface Ctx {
  session: SessionTypes.Struct | null;
  qrUri: string | null;
  connecting: boolean;
  connect(): Promise<void>;
  cancelConnect(): void;
  disconnect(): Promise<void>;
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

const WC = createContext<Ctx>(null as never);
export const useSage = () => useContext(WC);

export function WalletConnectProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<SignClient | null>(null);
  const [session, setSession] = useState<SessionTypes.Struct | null>(null);
  const [qrUri, setQrUri] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    SignClient.init({
      logger: "error",
      projectId: PROJECT_ID,
      metadata: {
        name: "XCH Annuity",
        description: "Create, transfer, and trade annuities on Chia",
        url: typeof window !== "undefined" ? window.location.origin : "",
        icons: ["/icon.svg"],
      },
    })
      .then((c) => {
        setClient(c);
        const last = c.session.getAll().pop();
        if (last) setSession(last);
        c.on("session_delete", () => setSession(null));
        c.on("session_expire", () => setSession(null));
      })
      .catch((e) => toast.error(`WalletConnect init failed: ${(e as Error)?.message ?? e}`));
  }, []);

  const connect = useCallback(async () => {
    if (!client) {
      toast.error("WalletConnect not ready yet — try again in a second.");
      return;
    }
    setConnecting(true);
    try {
      // optionalNamespaces — Sage rejects the deprecated requiredNamespaces path.
      const { uri, approval } = await client.connect({
        optionalNamespaces: { chia: { methods: METHODS, chains: [CHAIN_ID], events: [] } },
      });
      if (uri) setQrUri(uri);
      setSession(await approval());
      toast.success("Connected to Sage");
    } catch {
      toast.error("Connection rejected or failed");
    } finally {
      setQrUri(null);
      setConnecting(false);
    }
  }, [client]);

  const cancelConnect = useCallback(() => {
    setQrUri(null);
    setConnecting(false);
  }, []);

  const disconnect = useCallback(async () => {
    if (!client || !session) return;
    await client.disconnect({ topic: session.topic, reason: { code: 6000, message: "bye" } });
    setSession(null);
  }, [client, session]);

  const request = useCallback(
    async <T,>(method: string, params: unknown): Promise<T> => {
      if (!client || !session) throw new Error("Wallet not connected");
      // 60s timeout guard: a backgrounded mobile Sage can hang forever.
      const call = client.request<T>({
        topic: session.topic,
        chainId: CHAIN_ID,
        request: { method, params },
      });
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error("Sage did not respond — open the Sage app and try again.")),
          60_000,
        ),
      );
      return Promise.race([call, timeout]);
    },
    [client, session],
  );

  return (
    <WC.Provider value={{ session, qrUri, connecting, connect, cancelConnect, disconnect, request }}>
      {children}
    </WC.Provider>
  );
}
