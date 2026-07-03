import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { insertActionTask } from "$lib/helpers/workflow-action-spec";
import { getRemovedSw10AgentCallsError } from "$lib/server/workflows/sw10-agent-validation";
import type { ActionCatalogItem } from "$lib/stores/action-catalog.svelte";
import type { CodeFunctionDetail } from "$lib/server/code-functions/model";
import { getActionCatalogDetail, loadActionCatalogSnapshot } from "./index";
import type { PieceMetadataActionSourceReader } from "./piece-metadata-source";

vi.mock("$lib/server/dapr-client", () => ({
  daprFetch: vi.fn(async () => new Response("offline", { status: 503 })),
  getFnSystemUrl: () => "http://fn-system",
  getOrchestratorUrl: () => "http://workflow-orchestrator",
}));

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

async function loadOneShotCliAction() {
  const snapshot = await loadActionCatalogSnapshot(null);
  const action = snapshot.items.find(
    (item) => item.id === "builtin.cli-agent/run-one-shot",
  );
  expect(action).toBeDefined();
  return action!;
}

const codeFunctionDetail: CodeFunctionDetail = {
  id: "fn-1",
  name: "Parse User",
  slug: "parse-user",
  description: "Parse user text",
  version: "0.1.0",
  language: "typescript",
  entrypoint: "main",
  path: null,
  updatedAt: "2026-07-03T00:00:00.000Z",
  createdAt: "2026-07-03T00:00:00.000Z",
  isEnabled: true,
  hasDiagnostics: false,
  latestPublishedVersion: "pub-1",
  lastPublishedAt: "2026-07-03T00:00:00.000Z",
  role: "function",
  compositionGraph: null,
  source: "export function main(input) { return input; }",
  supportingFiles: {},
  sourceHash: "abc123",
  revisions: [],
  model: {
    language: "typescript",
    entrypoint: "main",
    is_async: false,
    imports: [],
    params: [],
    dynamic_inputs: [],
    return_type: { kind: "unknown" },
    schema: { type: "object" },
    diagnostics: [],
    capabilities: {
      has_enums: false,
      has_nested_objects: false,
      has_nullable_types: false,
      has_relative_imports: false,
      has_resource_types: false,
      has_dynamic_inputs: false,
    },
  },
};

describe("action-catalog code-function boundary", () => {
  it("keeps action-catalog free of direct code-function persistence imports", () => {
    const actionCatalogSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
      "utf8",
    );
    expect(actionCatalogSource).not.toContain("$lib/server/code-functions\"");
    expect(actionCatalogSource).not.toContain("$lib/server/code-functions'");
    expect(actionCatalogSource).not.toContain("$lib/server/db");
    expect(actionCatalogSource).not.toContain("drizzle-orm");
  });

  it("loads code-function catalog items through an injected reader", async () => {
    const codeFunctions = {
      listCodeFunctions: vi.fn(async () => [codeFunctionDetail]),
      getCodeFunction: vi.fn(async () => codeFunctionDetail),
    };

    const snapshot = await loadActionCatalogSnapshot("user-1", { codeFunctions });

    expect(codeFunctions.listCodeFunctions).toHaveBeenCalledWith("user-1");
    expect(codeFunctions.getCodeFunction).toHaveBeenCalledWith("fn-1", "user-1");
    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "code-function.fn-1",
          name: "parse-user",
          service: "code-functions",
          sourceKind: "catalog",
        }),
      ]),
    );

    await expect(
      getActionCatalogDetail("code-function.fn-1", "user-1", { codeFunctions }),
    ).resolves.toMatchObject({
      id: "code-function.fn-1",
      slug: "parse-user",
      sourceKind: "code",
    });
  });

  it("loads activepieces actions through an injected piece metadata source", async () => {
    const pieceMetadataSource: PieceMetadataActionSourceReader = {
      listLatestRunnableActionRows: vi.fn(async () => [
        {
          name: "github",
          displayName: "GitHub",
          logoUrl: null,
          description: "GitHub integration",
          version: "1.2.3",
          auth: { type: "OAUTH2", displayName: "GitHub OAuth" },
          actions: {
            create_issue: {
              displayName: "Create Issue",
              description: "Create a GitHub issue",
              requireAuth: true,
              inputSchema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                },
              },
              props: {
                title: {
                  type: "SHORT_TEXT",
                  displayName: "Title",
                  required: true,
                },
              },
            },
          },
          categories: ["developer-tools"],
          catalogDigest: "digest-1",
          catalogSourceImage: "image-1",
          availableOnly: false,
        },
      ]),
    };

    const snapshot = await loadActionCatalogSnapshot(null, {
      pieceMetadataSource,
    });

    expect(pieceMetadataSource.listLatestRunnableActionRows).toHaveBeenCalled();
    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "github-create_issue",
          name: "github-create_issue",
          service: "activepieces",
          pieceName: "github",
          actionName: "create_issue",
          insertable: true,
        }),
      ]),
    );
  });
});

describe("built-in one-shot CLI agent action", () => {
  it("is exposed as an insertable agent action backed by durable/run", async () => {
    const action = await loadOneShotCliAction();

    expect(action).toMatchObject({
      id: "builtin.cli-agent/run-one-shot",
      name: "cli-agent/run-one-shot",
      displayName: "Run CLI Agent",
      category: "agent",
      service: "cli-agent-py",
      kind: "dapr-activity",
      insertable: true,
    });

    const taskConfig = asRecord(action.taskConfig);
    expect(taskConfig.call).toBe("durable/run");

    const withBlock = asRecord(taskConfig.with);
    expect(withBlock.mode).toBe("execute_direct");
    expect(withBlock.workspaceRef).toBe("${ .runtime.executionId }");
    expect(withBlock.agentRuntime).toBeUndefined();

    const agentRef = asRecord(withBlock.agentRef);
    expect(agentRef.slug).toBe("cli-evaluator-critic-agent");

    const body = asRecord(withBlock.body);
    expect(body.prompt).toBe("");
    const overrides = asRecord(body.overrides);
    expect(overrides).toMatchObject({
      cwd: "/sandbox/work",
      maxTurns: 20,
      timeoutMinutes: 25,
    });
  });

  it("inserts a valid provider-neutral durable/run task for each CLI provider slug", async () => {
    const action = await loadOneShotCliAction();
    const taskConfig = asRecord(action.taskConfig);

    const inserted = insertActionTask(
      null,
      "CLI Agent Workflow",
      action as unknown as ActionCatalogItem,
      {
        sw: {
          taskConfig,
          definition: taskConfig,
        },
      },
    );

    expect(inserted.taskDef.call).toBe("durable/run");

    for (const slug of [
      "cli-evaluator-critic-agent",
      "codex-cli-evaluator-critic-agent",
      "agy-cli-evaluator-critic-agent",
    ]) {
      const providerTask = cloneRecord(inserted.taskDef);
      const withBlock = asRecord(providerTask.with);
      const agentRef = asRecord(withBlock.agentRef);
      agentRef.slug = slug;

      expect(
        getRemovedSw10AgentCallsError({
          do: [{ run_cli_agent: providerTask }],
        }),
      ).toBeNull();
    }
  });
});
