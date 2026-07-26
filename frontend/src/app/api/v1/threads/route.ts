import { proxyJson } from "@/server/backend-proxy";

/** Global session collection. A null projectId is a first-class value. */
export async function GET(request: Request) {
  return proxyJson(request, "/api/v1/threads");
}

export async function POST(request: Request) {
  return proxyJson(request, "/api/v1/threads");
}
