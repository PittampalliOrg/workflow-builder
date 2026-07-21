import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateDynamicScriptSpec } from "../src/lib/server/workflows/dynamic-script-validation";

import {
  assertResourceOwner,
  buildSpec,
  isDirectExecution,
  parseArgs,
  PYDANTIC_AGENT_CONFIG,
  PYDANTIC_AGENT_SLUG,
  resolveOwner,
  WORKFLOW_ID,
} from "./upsert-pydantic-ai-k3-3blue1brown-animation-workflow";

function fakeSql(resolver: (query: string, values: unknown[]) => unknown[]) {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    resolver(strings.join("?"), values)) as never;
}

describe("fresh Pydantic AI K3 animation workflow upsert", () => {
  it("binds structured values with postgres JSON parameters", () => {
    const source = readFileSync(
      new URL(
        "./upsert-pydantic-ai-k3-3blue1brown-animation-workflow.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain("sql.json(");
    expect(source).toContain("tx.json(");
    expect(source).toContain("jsonb_typeof(av.config) as config_type");
    expect(source).toContain('existing.config_type === "object"');
    expect(source).toContain('config.runtime !== "pydantic-ai-agent-py"');
    expect(source).toContain("a.created_by, a.project_id");
    expect(source).not.toContain("jsonbParameter");
  });

  it("defines an isolated Pydantic AI K3 agent at max reasoning and 1M context", () => {
    expect(WORKFLOW_ID).toBe("pydantic-ai-k3-3blue1brown-animation");
    expect(PYDANTIC_AGENT_SLUG).toBe(
      "pydantic-ai-k3-dynamic-animation-builder",
    );
    expect(PYDANTIC_AGENT_CONFIG).toMatchObject({
      runtime: "pydantic-ai-agent-py",
      runtimeClass: "coding",
      runtimeIsolation: "shared",
      modelSpec: "kimi/kimi-k3",
      reasoningEffort: "max",
      contextWindowTokens: 1_048_576,
      cwd: "/sandbox/work",
      memory: { backend: "none" },
      builtinTools: [
        "read_file",
        "write_file",
        "edit_file",
        "list_directory",
        "search_files",
        "find_files",
        "create_directory",
        "file_info",
        "ReadMediaFile",
        "run_command",
        "start_command",
        "check_command",
        "stop_command",
      ],
    });
  });

  it("builds a valid pinned script with a deterministic JuiceFS to OpenShell bridge", () => {
    const agentRef = { id: "agnt_pydantic_k3_animation", version: 2 };
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
        agentRuntime: "pydantic-ai-agent-py",
        timeoutMinutes: 60,
      },
      meta: {
        name: "pydantic-ai-k3-3blue1brown-animation",
        input: { required: ["animationDescription"] },
      },
    });

    expect(spec.script).toContain('agent: "agnt_pydantic_k3_animation"');
    expect(spec.script).toContain("agentVersion: 2");
    expect(spec.script).toContain('agentType: "pydantic-ai-agent-py"');
    expect(spec.script).toContain('model: "kimi/kimi-k3"');
    expect(spec.script).toContain('effort: "max"');
    expect(spec.script).toContain('isolation: "shared"');
    expect(spec.script).toContain(
      'sandbox: {\n      cwd: "/sandbox/work",\n      maxTurns: 60,',
    );
    expect(spec.script).not.toContain("sandbox: {\n      workspaceRef");

    expect(spec.script.match(/cliWorkspace: true/g)).toHaveLength(5);
    expect(spec.script.match(/readFile: `\$\{sourceAppPath\}\//g)).toHaveLength(
      4,
    );
    expect(spec.script.match(/"workspace\/write_file"/g)).toHaveLength(4);
    expect(spec.script).toContain(
      'sourceAppPath = "/sandbox/work/pydantic-ai-k3-math-animation"',
    );
    expect(spec.script).toContain(
      'appPath = "/sandbox/pydantic-ai-k3-math-animation"',
    );
    expect(spec.script).toContain(
      'name: "pydantic-ai-k3-animation-preview-workspace"',
    );
    expect(spec.script).toContain(
      'managedBy: "workflow-builder:demos:pydantic-ai-k3-animation"',
    );
    expect(spec.script).toContain(
      "`pydantic-ai-k3-animation-preview-${workspaceRef}`",
    );
    expect(spec.script).toContain('"browser/validate"');
    expect(spec.script).toContain('"browser/start-preview"');
    expect(spec.script).toContain('label: "validate_materialized_app"');

    expect(spec.script).not.toContain("kimi-k3-dynamic-animation-builder");
    expect(spec.script).not.toContain('name: "kimi-k3-dynamic-animation"');
    expect(spec.script).not.toContain("__PYDANTIC_AGENT_");
    expect(spec.script).not.toContain("${ .");
  });

  it("uses the managed Pydantic agent by default and preserves explicit overrides", () => {
    expect(parseArgs([])).toEqual({ userEmail: "", projectId: "" });
    expect(
      parseArgs([
        "--user-email",
        "vinod@pittampalli.com",
        "--project-id",
        "project-1",
        "--agent-id",
        "agnt_override",
        "--agent-version",
        "4",
      ]),
    ).toEqual({
      userEmail: "vinod@pittampalli.com",
      projectId: "project-1",
      agentOverride: { id: "agnt_override", version: 4 },
    });
  });

  it("requires an explicit owner for a new standalone workflow", async () => {
    await expect(
      resolveOwner(
        fakeSql(() => []),
        undefined,
        "",
      ),
    ).rejects.toThrow("--user-email is required");
  });

  it("requires a non-null project on an existing standalone workflow", async () => {
    await expect(
      resolveOwner(
        fakeSql(() => []),
        { user_id: "user-1", project_id: null } as never,
        "",
      ),
    ).rejects.toThrow("must have both a user and a project");
  });

	it("fails closed when an explicit user does not own the existing workflow", async () => {
		const sql = fakeSql((query) => {
			if (query.includes("from project_members")) return [{ "?column?": 1 }];
			if (query.includes("from users")) return [{ user_id: "user-2" }];
			return [];
		});
    await expect(
      resolveOwner(
        sql,
        { user_id: "user-1", project_id: "project-1" } as never,
        "other@example.com",
      ),
    ).rejects.toThrow("belongs to a different user");
  });

  it("requires --project-id when the explicit user has multiple projects", async () => {
    const sql = fakeSql((query) => {
      if (query.includes("from users")) return [{ user_id: "user-1" }];
      if (query.includes("from project_members")) {
        return [{ project_id: "project-1" }, { project_id: "project-2" }];
      }
      return [];
    });
    await expect(
      resolveOwner(sql, undefined, "owner@example.com"),
    ).rejects.toThrow("pass --project-id explicitly");
  });

  it("refuses to reuse a globally unique agent slug across owners", () => {
    expect(() =>
      assertResourceOwner(
        "Agent slug pydantic-ai-k3-dynamic-animation-builder",
        { userId: "user-2", projectId: "project-1" },
        { userId: "user-1", projectId: "project-1" },
      ),
    ).toThrow("refusing to reuse it");
  });

  it("accepts an existing agent only for the resolved owner and project", () => {
    expect(() =>
      assertResourceOwner(
        "Agent slug pydantic-ai-k3-dynamic-animation-builder",
        { userId: "user-1", projectId: "project-1" },
        { userId: "user-1", projectId: "project-1" },
      ),
    ).not.toThrow();
  });

  it("rejects an agent version without an agent id", () => {
    expect(() => parseArgs(["--agent-version", "1"])).toThrow(
      "--agent-version requires --agent-id",
    );
  });

  it("does not run its standalone main when bundled into the canonical seed", () => {
    const path =
      "/app/scripts/upsert-pydantic-ai-k3-3blue1brown-animation-workflow.ts";
    expect(
      isDirectExecution(
        "file:///app/scripts/upsert-pydantic-ai-k3-3blue1brown-animation-workflow.ts",
        path,
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
