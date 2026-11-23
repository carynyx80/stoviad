import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      // Same issue under Turbopack: use the CJS fat build, which inlines the wasm and has no
      // statically analysable `new URL(..., import.meta.url)`.
      "@lightprotocol/hasher.rs": "./node_modules/@lightprotocol/hasher.rs/dist/browser-fat/cjs/index_browser_fat.cjs",
    },
  },
  webpack(config) {
    // @lightprotocol/hasher.rs (Poseidon, used by @heliuslabs/spr) ships a "fat" build with
    // the wasm inlined as base64, plus a dead `new URL("*.wasm", import.meta.url)` fallback
    // pointing at files that are not next to it. Don't let webpack try to resolve those.
    config.module.rules.push({
      test: /[\\/]@lightprotocol[\\/]hasher\.rs[\\/].*\.js$/,
      parser: { url: false },
    });
    return config;
  },
};

export default nextConfig;
