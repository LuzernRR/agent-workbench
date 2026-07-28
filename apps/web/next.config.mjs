import path from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(webDirectory, "..", "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 生产镜像使用 Next 的追踪结果，避免把开发依赖与本地配置带入运行时。
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["pg"],
  // Support mounting the same workbench under an optional path prefix.
  basePath: process.env.WORKBENCH_BASE_PATH || "",
  env: {
    NEXT_PUBLIC_WORKBENCH_BASE_PATH: process.env.WORKBENCH_BASE_PATH || ""
  },
  // apps/web consumes the versioned contracts from packages/contracts. Make the
  // monorepo boundary explicit so Turbopack and production file tracing resolve
  // the same files as TypeScript and Vitest after the directory migration.
  turbopack: {
    root: workspaceRoot
  },
  outputFileTracingRoot: workspaceRoot,
  experimental: {
    optimizePackageImports: ["lucide-react", "@assistant-ui/react"]
  }
};

export default nextConfig;
