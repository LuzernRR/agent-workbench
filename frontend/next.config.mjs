/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["pg"],
  // Support mounting the same workbench under an optional path prefix.
  basePath: process.env.WORKBENCH_BASE_PATH || "",
  env: {
    NEXT_PUBLIC_WORKBENCH_BASE_PATH: process.env.WORKBENCH_BASE_PATH || ""
  },
  experimental: {
    optimizePackageImports: ["lucide-react", "@assistant-ui/react"]
  }
};

export default nextConfig;
