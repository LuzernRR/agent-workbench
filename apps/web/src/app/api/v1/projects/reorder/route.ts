import { proxyJson } from "@/server/backend-proxy";

export async function PATCH(request: Request) {
  return proxyJson(request, "/api/v1/projects/reorder");
}
