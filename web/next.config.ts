import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // shared/ is a workspace package outside web/, shipped as TypeScript source.
  transpilePackages: ["@sip402/shared"],
  // Trace files from the repo root so the monorepo (and shared/) is included on Vercel.
  outputFileTracingRoot: path.join(__dirname, ".."),
};

export default nextConfig;
