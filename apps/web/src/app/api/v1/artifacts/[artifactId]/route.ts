import { proxyJson } from "@/server/backend-proxy";

export async function GET(request: Request, context: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await context.params;
  return proxyJson(request, `/api/v1/artifacts/${artifactId}`);
}
