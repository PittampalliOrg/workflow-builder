import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MCP_SRC = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(MCP_SRC, "../../..");
const BFF_ROUTES = [
  "src/routes/api/internal/preview-environments/+server.ts",
  "src/routes/api/internal/preview-environments/services/+server.ts",
  "src/routes/api/internal/preview-environments/[name]/+server.ts",
  "src/routes/api/internal/preview-environments/[name]/runtime/+server.ts",
  "src/routes/api/internal/preview-environments/[name]/traces/+server.ts",
  "src/routes/api/internal/preview-environments/[name]/teardown/status/+server.ts",
];
const MCP_FILES = [
  "services/workflow-mcp-server/src/ports/preview-environments.ts",
  "services/workflow-mcp-server/src/application/preview-environments.ts",
  "services/workflow-mcp-server/src/adapters/http-preview-environments.ts",
  "services/workflow-mcp-server/src/preview-tools.ts",
];

describe("preview MCP hexagonal boundary", () => {
  it("contains no direct Kubernetes discovery or cross-target MCP proxy", () => {
    for (const file of [...BFF_ROUTES, ...MCP_FILES]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, file).not.toContain("$lib/server/kube");
      expect(source, file).not.toContain("kubernetes.io/serviceaccount");
      expect(source, file).not.toContain("KUBERNETES_SERVICE_HOST");
      expect(source, file).not.toContain("node:https");
      expect(source, file).not.toContain("callRemoteWorkflowTargetTool");
    }
    expect(existsSync(join(MCP_SRC, "targets.ts"))).toBe(false);
    expect(existsSync(join(MCP_SRC, "target-tools.ts"))).toBe(false);
    expect(existsSync(join(MCP_SRC, "remote-mcp.ts"))).toBe(false);
  });

  it("keeps BFF routes thin and application-service backed", () => {
    for (const file of BFF_ROUTES) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, file).toContain("guardPreviewMcp");
      expect(source, file).not.toContain("application/adapters");
      expect(source, file).not.toContain("$lib/server/db");
      expect(source, file).not.toContain("drizzle-orm");
    }
  });
});
