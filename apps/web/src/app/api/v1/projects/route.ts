import { proxyJson } from "@/server/backend-proxy";

export async function GET(request: Request) {
  return proxyJson(request, "/api/v1/projects");
}

export async function POST(request: Request) {
  return proxyJson(request, "/api/v1/projects");
}
