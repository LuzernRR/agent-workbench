import { proxyJson } from "@/server/backend-proxy";

export async function GET(request: Request) {
  return proxyJson(request, "/api/v1/tools");
}
