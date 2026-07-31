import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const webDirectory = process.cwd();
const runtimeDirectory = path.join(webDirectory, ".next", "standalone", "apps", "web");
const serverPath = path.join(runtimeDirectory, "server.js");

if (!existsSync(serverPath)) {
  throw new Error("缺少 Next standalone 产物，请先运行 npm run build");
}

const publicDirectory = path.join(webDirectory, "public");
if (existsSync(publicDirectory)) {
  cpSync(publicDirectory, path.join(runtimeDirectory, "public"), { recursive: true, force: true });
}
cpSync(
  path.join(webDirectory, ".next", "static"),
  path.join(runtimeDirectory, ".next", "static"),
  { recursive: true, force: true }
);

await import(pathToFileURL(serverPath).href);
