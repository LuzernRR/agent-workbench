export const dynamic = "force-dynamic";

/** 仅用于编排器存活探针；不读取配置、数据库或上游服务，也不返回内部信息。 */
export function GET() {
  return Response.json({ service: "agent-workbench-web", status: "ok" }, {
    headers: { "Cache-Control": "no-store" }
  });
}
