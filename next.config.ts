import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 and node-pty ship native addons — keep them out of the
  // server bundle and require()'d directly at runtime instead. `ws` is here
  // too since it pulls in optional native accelerators that don't bundle.
  serverExternalPackages: [
    "better-sqlite3",
    "@homebridge/node-pty-prebuilt-multiarch",
    "ws",
  ],
};

export default nextConfig;
