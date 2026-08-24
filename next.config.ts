import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 ships a native addon — keep it out of the server bundle
  // and require()'d directly at runtime instead.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
