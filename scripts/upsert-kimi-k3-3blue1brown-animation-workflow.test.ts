import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateDynamicScriptSpec } from "../src/lib/server/workflows/dynamic-script-validation";

import {
  buildSpec,
  isDirectExecution,
  KIMI_AGENT_CONFIG,
  KIMI_AGENT_SLUG,
  parseArgs,
  WORKFLOW_ID,
} from "./upsert-kimi-k3-3blue1brown-animation-workflow";

describe("fresh Kimi K3 animation workflow upsert", () => {
  it("binds structured values with postgres JSON parameters", () => {
    const source = readFileSync(
      new URL(
        "./upsert-kimi-k3-3blue1brown-animation-workflow.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain("sql.json(");
    expect(source).toContain("tx.json(");
    expect(source).toContain("jsonb_typeof(av.config) as config_type");
    expect(source).toContain('existing.config_type === "object"');
    expect(source).not.toContain("jsonbParameter");
  });

  it("defines a dapr-agent-py Kimi K3 agent at max reasoning and 1M context", () => {
    expect(WORKFLOW_ID).toBe("kimi-k3-3blue1brown-animation");
    expect(KIMI_AGENT_SLUG).toBe("kimi-k3-dynamic-animation-builder");
    expect(KIMI_AGENT_CONFIG).toMatchObject({
      runtime: "dapr-agent-py",
      modelSpec: "kimi/kimi-k3",
      reasoningEffort: "max",
      contextWindowTokens: 1_048_576,
      builtinTools: [
        "execute_command",
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "glob_files",
        "grep_search",
      ],
    });
  });

  it("builds a valid dynamic script pinned to the exact K3 agent version", () => {
    const agentRef = { id: "agnt_kimi_k3_dynamic_animation", version: 3 };
    const spec = buildSpec(agentRef) as {
      engine: string;
      script: string;
      meta: Record<string, unknown>;
      defaults: Record<string, unknown>;
    };

    expect(validateDynamicScriptSpec(spec)).toMatchObject({ ok: true });
    expect(spec).toMatchObject({
      engine: "dynamic-script",
      defaults: {
        model: "kimi/kimi-k3",
        agentRuntime: "dapr-agent-py",
        timeoutMinutes: 60,
      },
      meta: {
        name: "kimi-k3-3blue1brown-animation",
        input: {
          required: ["animationDescription"],
        },
      },
    });
    expect(spec.script).toContain('agent: "agnt_kimi_k3_dynamic_animation"');
    expect(spec.script).toContain("agentVersion: 3");
    expect(spec.script).toContain('agentType: "dapr-agent-py"');
    expect(spec.script).toContain('model: "kimi/kimi-k3"');
    expect(spec.script).toContain('effort: "max"');
    expect(spec.script).toContain("schema: buildSchema");
    expect(spec.script).toContain("minItems: 4");
    expect(spec.script).toContain("animation.files.length < 4");
    expect(spec.script).toContain('action(\n  "browser/validate"');
    expect(spec.script).toContain('action(\n  "browser/start-preview"');
    expect(spec.script).not.toContain("agnt_claude_code_sdk_smoke");
    expect(spec.script).not.toContain("${ .");
    expect(spec.script).not.toContain("allowFailure");
    expect(spec.script).not.toContain("__KIMI_AGENT_");
  });

  it("uses the managed Kimi agent by default and preserves explicit overrides", () => {
    expect(parseArgs([])).toEqual({ userEmail: "" });
    expect(
      parseArgs(["--agent-id", "agnt_override", "--agent-version", "4"]),
    ).toEqual({
      userEmail: "",
      agentOverride: { id: "agnt_override", version: 4 },
    });
  });

  it("rejects an agent version without an agent id", () => {
    expect(() => parseArgs(["--agent-version", "1"])).toThrow(
      "--agent-version requires --agent-id",
    );
  });

  it("does not run its standalone main when bundled into the canonical seed", () => {
    expect(
      isDirectExecution(
        "file:///app/scripts/upsert-kimi-k3-3blue1brown-animation-workflow.ts",
        "/app/scripts/upsert-kimi-k3-3blue1brown-animation-workflow.ts",
      ),
    ).toBe(true);
    expect(
      isDirectExecution(
        "file:///app/scripts/seed-workflows.bundle.js",
        "/app/scripts/seed-workflows.bundle.js",
      ),
    ).toBe(false);
  });
});
