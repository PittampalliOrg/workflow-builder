import { describe, expect, it } from "vitest";
import {
  buildKimiK3BrowserAgentConfig,
  KIMI_K3_BROWSER_AGENT_SLUG,
  KIMI_K3_BROWSER_ALLOWED_TOOLS,
  KIMI_K3_BROWSER_PROBE_AGENT_SLUG,
  migrateLegacyBrowserAgentReferences,
} from "./kimi-k3-browser-agent";

describe("Kimi K3 browser-agent migration", () => {
  it("strips persistent target credentials while retaining host scope", () => {
    const config = buildKimiK3BrowserAgentConfig(
      {
        modelSpec: "zai/glm-5.2",
        model: "glm-5.2",
        provider: "zai",
        llmComponent: "llm-glm-5.2",
        providerModel: "glm-5.2",
        mcpServers: [
          {
            name: "browser",
            url: "http://agent-browser-mcp:8000/mcp",
            headers: {
              "X-Wfb-Target-Auth": "credential-never-hardcoded",
              "X-Wfb-Target-Auth-Host": "workflow-builder:3000",
              "X-Non-Secret-Routing": "retain-me",
            },
          },
        ],
      },
      { probe: false },
    );

    expect(config).toMatchObject({
      runtime: "dapr-agent-py",
      modelSpec: "kimi/kimi-k3",
      reasoningEffort: "max",
      contextWindowTokens: 1_048_576,
    });
    expect(config.mcpServers).toEqual([
      {
        name: "browser",
        url: "http://agent-browser-mcp:8000/mcp",
        headers: {
          "X-Wfb-Target-Auth-Host": "workflow-builder:3000",
          "X-Non-Secret-Routing": "retain-me",
        },
      },
    ]);
    expect(JSON.stringify(config)).not.toContain("zai/glm-5.2");
    expect(JSON.stringify(config)).not.toContain("glm-5.2");
    expect(JSON.stringify(config)).not.toContain("credential-never-hardcoded");
    expect(config).not.toHaveProperty("provider");
  });

  it("gives a fresh probe config an isolated browser lane", () => {
    const config = buildKimiK3BrowserAgentConfig(
      {
        mcpServers: [
          {
            url: "http://agent-browser-mcp:8000/mcp",
            headers: {
              "x-wfb-target-auth": "stale-lowercase-credential",
              "X-Wfb-Target-Auth-Host": "workflow-builder:3000",
            },
          },
        ],
      },
      { probe: true },
    );
    expect(config.mcpServers).toEqual([
      expect.objectContaining({
        headers: {
          "X-Wfb-Target-Auth-Host": "workflow-builder:3000",
          "X-Wfb-Browser-Lane": "per-node",
        },
      }),
    ]);
    expect(JSON.stringify(config)).not.toContain("stale-lowercase-credential");
  });

  it("gives a clean install the canonical target-auth host without a credential", () => {
    const config = buildKimiK3BrowserAgentConfig(null, { probe: false });
    expect(config.mcpServers).toEqual([
      expect.objectContaining({
        headers: {
          "X-Wfb-Target-Auth-Host": "workflow-builder:3000",
        },
      }),
    ]);
    expect(JSON.stringify(config)).not.toContain("Bearer ");
  });

  it("keeps raw screenshot capture without visual-description proxy tools", () => {
    expect(KIMI_K3_BROWSER_ALLOWED_TOOLS).toContain(
      "browser_agent_browser_screenshot",
    );
    expect(KIMI_K3_BROWSER_ALLOWED_TOOLS).toContain(
      "browser_agent_browser_snapshot",
    );
    expect(
      KIMI_K3_BROWSER_ALLOWED_TOOLS.some((tool) =>
        /(?:ocr|describe|caption|visual_analysis|image_analysis)/i.test(tool),
      ),
    ).toBe(false);
  });

  it("rewrites browser agent refs and descriptions without changing other GLM agents", () => {
    const migrated = migrateLegacyBrowserAgentReferences({
      description: "GLM 5.2 browser agent with all-GLM/ZAI orchestration",
      script:
        "const critic='glm-browser-agent'; const probe='glm-browser-probe-agent'; const coder='glm-coder-host'",
    });

    expect(migrated).toEqual({
      description:
        "Kimi K3 vision browser agent with Kimi K3 vision/browser critic plus coding agent orchestration",
      script: `const critic='${KIMI_K3_BROWSER_AGENT_SLUG}'; const probe='${KIMI_K3_BROWSER_PROBE_AGENT_SLUG}'; const coder='glm-coder-host'`,
    });
  });

  it("adds raw screenshot capture to the vision critic sequence", () => {
    const migrated = migrateLegacyBrowserAgentReferences(
      "max ~10 tool calls TOTAL: (2) browser_agent_browser_snapshot, (3) at most ONE obvious interaction; max ~8 tool calls TOTAL: open each reference route ONCE + snapshot, open each target route ONCE + snapshot",
    );

    expect(migrated).toContain(
      "browser_agent_browser_snapshot, (3) browser_agent_browser_screenshot",
    );
    expect(migrated).toContain(
      "open each reference route ONCE + snapshot + screenshot",
    );
    expect(migrated).toContain("max ~14 tool calls TOTAL");
    expect(migrated).toContain("max ~12 tool calls TOTAL");
  });
});
