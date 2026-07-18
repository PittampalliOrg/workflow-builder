import { describe, expect, it, vi } from "vitest";
import type {
  PreviewDevelopmentTarget,
  PreviewDevelopmentWorkflowInput,
  WorkflowExecutionRecord,
} from "$lib/server/application/ports";
import {
  ApplicationPreviewTargetDevelopmentLocalService,
  __previewTargetDevelopmentForTest,
} from "$lib/server/application/preview-target-development";
import { workflowSpecDigest } from "$lib/server/application/workflow-spec-digest";

const { normalizeWorkflowInput } = __previewTargetDevelopmentForTest;

const spec = {
  document: {
    dsl: "1.0.0",
    namespace: "dev",
    name: "preview-ui-development-gan",
    "x-workflow-builder": { launch: { surface: "dev-environment" } },
  },
  do: [],
};
const digest = workflowSpecDigest(spec);
const target: PreviewDevelopmentTarget = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  platformRevision: "a".repeat(40),
  sourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}`,
};

/** Drive the preview-local receiver and capture the child triggerData. */
async function startLocalChild(
  workflowInput: PreviewDevelopmentWorkflowInput,
): Promise<Record<string, unknown>> {
  let execution: WorkflowExecutionRecord | null = null;
  const startWorkflowRun = vi.fn(async (input) => {
    execution = {
      id: input.executionId!,
      userId: "preview-admin",
      status: "running",
      workflowId: "preview-ui-development-gan",
      projectId: "preview-project",
      input: input.triggerData as Record<string, unknown>,
      executionIr: { spec, triggerData: input.triggerData },
      daprInstanceId: "instance-1",
    } as WorkflowExecutionRecord;
    return {
      ok: true as const,
      executionId: input.executionId!,
      instanceId: "instance-1",
      workflowId: "preview-ui-development-gan",
      workflowName: "Preview UI development GAN",
      reused: false,
    };
  });
  const service = new ApplicationPreviewTargetDevelopmentLocalService({
    identity: {
      current: () => ({
        previewName: target.previewName,
        environmentRequestId: target.environmentRequestId,
        environmentPlatformRevision: target.platformRevision,
        environmentSourceRevision: target.sourceRevision,
        catalogDigest: target.catalogDigest,
      }),
    },
    scope: {
      current: () => ({
        kind: "preview",
        preview: {
          name: target.previewName,
          profile: "app-live",
          platformRevision: target.platformRevision,
          sourceRevision: target.sourceRevision,
          origin: "https://wfb-feature-one.tail286401.ts.net",
        },
      }),
      isControlPlane: () => false,
      allowsPreviewName: (name) => name === target.previewName,
    },
    definitions: {
      getByRef: vi.fn(
        async () =>
          ({
            id: "preview-ui-development-gan",
            name: "Preview UI development GAN",
            userId: "preview-admin",
            projectId: "preview-project",
            spec,
          }) as never,
      ),
    },
    executions: {
      getById: vi.fn(async () => execution),
      listSessionIdsByExecutionId: vi.fn(async () => []),
    },
    projects: {
      getProjectExternalId: vi.fn(async () => "workspace-one"),
    },
    starter: { startWorkflowRun },
    events: { raiseWorkflowEvent: vi.fn(async () => ({ ok: true as const })) },
  });
  await service.startWorkflow({
    parentExecutionId: "parent-execution",
    actorUserId: "admin-1",
    operationId: `pdt-start-workflow-${"7".repeat(64)}`,
    target,
    workflow: {
      executionId: __previewTargetDevelopmentForTest.childExecutionId({
        parentExecutionId: "parent-execution",
        target,
        workflowSpecDigest: digest,
      }),
      workflowName: "preview-ui-development-gan" as const,
      workflowSpecDigest: digest,
    },
    workflowInput,
  });
  return startWorkflowRun.mock.calls[0]![0].triggerData as Record<
    string,
    unknown
  >;
}

describe("preview development optional child control pass-through", () => {
  it("passes retention and verifier controls through verbatim", () => {
    expect(
      normalizeWorkflowInput({
        intent: "x",
        services: ["workflow-builder"],
        ttlHours: 12,
        retainAfterCompletion: true,
        interactiveHandoff: false,
        impactReview: true,
        diffScope: ["src/routes/dashboard"],
        maxIterations: 2,
      }),
    ).toEqual({
      intent: "x",
      services: ["workflow-builder"],
      ttlHours: 12,
      retainAfterCompletion: true,
      interactiveHandoff: false,
      impactReview: true,
      diffScope: ["src/routes/dashboard"],
      maxIterations: 2,
    });
  });

  it("accepts the child fixture's string boolean forms without coercing them", () => {
    expect(
      normalizeWorkflowInput({
        intent: "x",
        services: ["workflow-builder"],
        retainAfterCompletion: "true",
        interactiveHandoff: "false",
        impactReview: "true",
      }),
    ).toMatchObject({
      retainAfterCompletion: "true",
      interactiveHandoff: "false",
      impactReview: "true",
    });
  });

  it("keeps the default payload free of optional controls", () => {
    const normalized = normalizeWorkflowInput({
      intent: "x",
      services: ["workflow-builder"],
    });
    expect(normalized).toEqual({
      intent: "x",
      services: ["workflow-builder"],
    });
    expect(normalized).not.toHaveProperty("ttlHours");
    expect(normalized).not.toHaveProperty("retainAfterCompletion");
    expect(normalized).not.toHaveProperty("interactiveHandoff");
    expect(normalized).not.toHaveProperty("impactReview");
    expect(normalized).not.toHaveProperty("diffScope");
    expect(normalized).not.toHaveProperty("maxIterations");
  });

  it("rejects out-of-range or non-integer ttlHours", () => {
    for (const ttlHours of [1, 25, 2.5, "12" as never]) {
      expect(() =>
        normalizeWorkflowInput({
          intent: "x",
          services: ["workflow-builder"],
          ttlHours,
        }),
      ).toThrow("ttlHours must be an integer between 2 and 24");
    }
  });

  it("rejects non-boolean opt-in flags", () => {
    expect(() =>
      normalizeWorkflowInput({
        intent: "x",
        services: ["workflow-builder"],
        retainAfterCompletion: "yes" as never,
      }),
    ).toThrow("retainAfterCompletion must be a boolean");
    expect(() =>
      normalizeWorkflowInput({
        intent: "x",
        services: ["workflow-builder"],
        interactiveHandoff: 1 as never,
      }),
    ).toThrow("interactiveHandoff must be a boolean");
    expect(() =>
      normalizeWorkflowInput({
        intent: "x",
        services: ["workflow-builder"],
        impactReview: "yes" as never,
      }),
    ).toThrow("impactReview must be a boolean");
  });

  it("rejects invalid verifier bounds", () => {
    for (const diffScope of [[""], ["src\u0000routes"]]) {
      expect(() =>
        normalizeWorkflowInput({
          intent: "x",
          services: ["workflow-builder"],
          diffScope,
        }),
      ).toThrow("diffScope must contain valid path prefixes");
    }
    for (const maxIterations of [0, 4, 1.5]) {
      expect(() =>
        normalizeWorkflowInput({
          intent: "x",
          services: ["workflow-builder"],
          maxIterations,
        }),
      ).toThrow("maxIterations must be an integer between 1 and 3");
    }
  });

  it("forwards opt-in keys into the preview-local child triggerData", async () => {
    const trigger = await startLocalChild({
      intent: "Change the dashboard",
      services: ["workflow-builder"],
      ttlHours: 12,
      retainAfterCompletion: true,
      interactiveHandoff: true,
      impactReview: true,
      diffScope: ["src/routes/dashboard"],
      maxIterations: 2,
    });
    expect(trigger).toMatchObject({
      intent: "Change the dashboard",
      services: ["workflow-builder"],
      ttlHours: 12,
      retainAfterCompletion: true,
      interactiveHandoff: true,
      impactReview: true,
      diffScope: ["src/routes/dashboard"],
      maxIterations: 2,
    });
  });

  it("keeps the default child triggerData byte-identical", async () => {
    const trigger = await startLocalChild({
      intent: "Change the dashboard",
      services: ["workflow-builder"],
    });
    expect(trigger).not.toHaveProperty("ttlHours");
    expect(trigger).not.toHaveProperty("retainAfterCompletion");
    expect(trigger).not.toHaveProperty("interactiveHandoff");
    expect(trigger).not.toHaveProperty("impactReview");
    expect(trigger).not.toHaveProperty("diffScope");
    expect(trigger).not.toHaveProperty("maxIterations");
  });
});
