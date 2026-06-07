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
