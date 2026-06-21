import { describe, expect, it, vi } from "vitest";
import { insertActionTask } from "$lib/helpers/workflow-action-spec";
import { getRemovedSw10AgentCallsError } from "$lib/server/workflows/sw10-agent-validation";
import type { ActionCatalogItem } from "$lib/stores/action-catalog.svelte";
import { loadActionCatalogSnapshot } from "./index";

vi.mock("$lib/server/code-functions", () => ({
  getCodeFunction: vi.fn(),
  listCodeFunctions: vi.fn(async () => []),
  toCodeFunctionDefinitionFromDetail: vi.fn(() => ({})),
}));

vi.mock("$lib/server/dapr-client", () => ({
  daprFetch: vi.fn(async () => new Response("offline", { status: 503 })),
  getFnSystemUrl: () => "http://fn-system",
  getOrchestratorUrl: () => "http://workflow-orchestrator",
}));

vi.mock("./piece-metadata-source", () => ({
  AP_CATALOG_SERVICE_ID: "activepieces",
  loadPieceMetadataActionSource: vi.fn(async () => ({
    actions: [],
    service: {
      service: "activepieces",
      version: "test",
      runtime: "piece-metadata",
      ready: true,
      features: [],
      registeredWorkflows: [],
      registeredActivities: [],
      additional: {},
    },
  })),
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
