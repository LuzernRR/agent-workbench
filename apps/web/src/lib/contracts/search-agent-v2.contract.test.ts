import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_SCHEMA_BASE,
  SearchAgentV2ContractValidator,
  containsPrivateReasoning,
  contractErrorCodes,
  loadContractManifest,
  loadFixture
} from "./search-agent-v2";

const contractsRoot = path.resolve(process.cwd(), "..", "..", "packages", "contracts", "v2");
const manifest = loadContractManifest(contractsRoot);

describe("Search Agent v2 跨语言合同", () => {
  it("逐条验证 manifest 的合法性和稳定错误码", () => {
    const validator = new SearchAgentV2ContractValidator(contractsRoot);
    expect(manifest.schemaVersion).toBe("2.0");
    expect(manifest.errorCodes).toEqual(contractErrorCodes);
    expect(new Set(manifest.entries.map((entry) => entry.id)).size).toBe(manifest.entries.length);
    expect(manifest.entries.length).toBeGreaterThan(100);
    for (const entry of manifest.entries) {
      const result = validator.validateFixture(entry);
      expect(result.valid, entry.id).toBe(entry.expectedValid);
      expect(result.errorCode, entry.id).toBe(entry.expectedErrorCode);
      if (entry.expectedErrorCode) expect(contractErrorCodes).toContain(entry.expectedErrorCode);
    }
  });

  it("manifest 精确覆盖全部正反 fixture", () => {
    const listed = manifest.entries.map((entry) => entry.path).sort();
    const files = ["valid", "invalid"]
      .flatMap((directory) => readdirSync(path.join(contractsRoot, "fixtures", directory))
        .filter((name) => name.endsWith(".json"))
        .map((name) => `${directory}/${name}`))
      .sort();
    expect(listed).toEqual(files);
  });

  it("所有合法 fixture 都不含私有思维链字段", () => {
    for (const entry of manifest.entries.filter((candidate) => candidate.expectedValid)) {
      expect(containsPrivateReasoning(loadFixture(entry, contractsRoot)), entry.id).toBe(false);
    }
  });

  it("全部 Schema 使用 Draft 2020-12 和稳定离线 id", () => {
    const schemaRoot = path.join(contractsRoot, "schemas");
    for (const filename of readdirSync(schemaRoot).filter((name) => name.endsWith(".schema.json"))) {
      const schema = JSON.parse(readFileSync(path.join(schemaRoot, filename), "utf8")) as {
        $schema: string;
        $id: string;
      };
      expect(schema.$schema, filename).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.$id, filename).toBe(`${CONTRACT_SCHEMA_BASE}${filename}`);
    }
    expect(() => new SearchAgentV2ContractValidator(contractsRoot)).not.toThrow();
  });

  it("AgentEvent 不混入线程队列事件且工具 unknown 不暴露完整错误", () => {
    const eventSchema = JSON.parse(
      readFileSync(path.join(contractsRoot, "schemas", "agent-event.schema.json"), "utf8")
    ) as {
      properties: { type: { enum: string[] } };
      $defs: { ToolUnknownPayload: { properties: Record<string, unknown> } };
    };
    expect(eventSchema.properties.type.enum).not.toContain("queue.updated");
    expect(eventSchema.$defs.ToolUnknownPayload.properties).not.toHaveProperty("error");
    expect(eventSchema.$defs.ToolUnknownPayload.properties).not.toHaveProperty("providerStatus");
  });
});
