import { describe, expect, it, vi } from "vitest";
import type {
  AuthorizedPreviewControlSource,
  ImmutableGitSha,
  PreviewDevelopmentTarget,
  PreviewTargetDevelopmentBrokerPort,
  WorkflowExecutionRecord,
} from "$lib/server/application/ports";
import {
  ApplicationPreviewTargetDevelopmentBrokerService,
  ApplicationPreviewTargetDevelopmentLocalService,
  ApplicationPreviewTargetDevelopmentService,
  __previewTargetDevelopmentForTest,
} from "$lib/server/application/preview-target-development";
import { previewDevelopmentParentBindingPrefix } from "$lib/server/application/preview-development-environment";
import { workflowSpecDigest } from "$lib/server/application/workflow-spec-digest";

const spec = {
  document: {
    dsl: "1.0.0",
    namespace: "dev",
    name: "microservice-dev-session",
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

function operation(
  kind:
    | "start-workflow"
    | "get-workflow-status"
    | "signal-workflow"
    | "verify-promotion",
  char: string,
): string {
  return `pdt-${kind}-${char.repeat(64)}`;
}

function parent(status: "pending" | "running" | "success" = "running") {
  return {
    id: "parent-execution",
    userId: "admin-1",
    status,
  } as WorkflowExecutionRecord;
}

describe("ApplicationPreviewTargetDevelopmentService", () => {
  it("derives actor, digest, and child id before calling the broker", async () => {
    const getDefinitionByRef = vi.fn(
      async () =>
        ({
          id: "microservice-dev-session",
          name: "Microservice dev-session: preview-local development",
          spec,
        }) as never,
    );
    const broker: PreviewTargetDevelopmentBrokerPort = {
      startWorkflow: vi.fn(async (input) => ({
        kind: "start-workflow",
        operationId: input.operationId,
        target: input.target,
        ...input.workflow,
        instanceId: "instance-1",
        status: "running",
        reused: false,
      })),
      getWorkflowStatus: vi.fn(),
      signalWorkflow: vi.fn(),
      verifyPromotion: vi.fn(),
    };
    const service = new ApplicationPreviewTargetDevelopmentService({
      executions: { getById: vi.fn(async () => parent()) },
      definitions: { getByRef: getDefinitionByRef },
      admins: { isPlatformAdmin: vi.fn(async () => true) },
      broker,
      scope: {
        current: () => ({ kind: "control-plane" }),
        isControlPlane: () => true,
        allowsPreviewName: () => true,
      },
    });

    const result = await service.startWorkflow({
      parentExecutionId: "parent-execution",
      operationId: operation("start-workflow", "1"),
      target,
      workflowInput: {
        intent: "Implement the dashboard change",
        services: ["workflow-builder"],
        keepPreview: true,
      },
    });

    expect(result.workflowSpecDigest).toBe(digest);
    expect(result.executionId).toMatch(/^pdc_[0-9a-f]{60}$/);
    expect(getDefinitionByRef).toHaveBeenCalledWith({
      workflowId: "microservice-dev-session",
    });
    expect(broker.startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "admin-1",
        parentExecutionId: "parent-execution",
        target,
        workflow: expect.objectContaining({
          workflowName: "microservice-dev-session",
          workflowSpecDigest: digest,
        }),
        workflowInput: {
          intent: "Implement the dashboard change",
          services: ["workflow-builder"],
          keepPreview: "true",
        },
      }),
    );

    await service.verifyPromotion({
      parentExecutionId: "parent-execution",
      operationId: operation("verify-promotion", "a"),
      target,
      childExecutionId: "child-execution",
      receiptId: `pspr_${"d".repeat(64)}`,
      services: ["workflow-builder"],
    });
    expect(broker.verifyPromotion).toHaveBeenCalledWith({
      parentExecutionId: "parent-execution",
      actorUserId: "admin-1",
      operationId: operation("verify-promotion", "a"),
      target,
      childExecutionId: "child-execution",
      receiptId: `pspr_${"d".repeat(64)}`,
      services: ["workflow-builder"],
    });
  });

  it("rejects inactive parents and callers that are not administrators", async () => {
    const dependencies = {
      definitions: { getByRef: vi.fn() },
      broker: {} as PreviewTargetDevelopmentBrokerPort,
      scope: {
        current: () => ({ kind: "control-plane" as const }),
        isControlPlane: () => true,
        allowsPreviewName: () => true,
      },
    };
    const inactive = new ApplicationPreviewTargetDevelopmentService({
      ...dependencies,
      executions: { getById: vi.fn(async () => parent("success")) },
      admins: { isPlatformAdmin: vi.fn(async () => true) },
    });
    await expect(
      inactive.startWorkflow({
        parentExecutionId: "parent-execution",
        operationId: operation("start-workflow", "2"),
        target,
        workflowInput: { intent: "x", services: ["workflow-builder"] },
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });

    const nonAdmin = new ApplicationPreviewTargetDevelopmentService({
      ...dependencies,
      executions: { getById: vi.fn(async () => parent()) },
      admins: { isPlatformAdmin: vi.fn(async () => false) },
    });
    await expect(
      nonAdmin.startWorkflow({
        parentExecutionId: "parent-execution",
        operationId: operation("start-workflow", "3"),
        target,
        workflowInput: { intent: "x", services: ["workflow-builder"] },
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects URL, identity, and credential fields at the typed input boundary", () => {
    expect(() =>
      __previewTargetDevelopmentForTest.normalizeWorkflowInput({
        intent: "x",
        services: ["https://attacker.invalid"],
      }),
    ).toThrow("workflow input is invalid");
    expect(() =>
      __previewTargetDevelopmentForTest.validateOperationId(
        operation("signal-workflow", "4"),
        "start-workflow",
      ),
    ).toThrow("operation id");
  });
});

describe("ApplicationPreviewTargetDevelopmentLocalService", () => {
  it("starts canonically, reports read-only status, and raises only the fixed event", async () => {
    let execution: WorkflowExecutionRecord | null = null;
    const getByRef = vi.fn(
      async () =>
        ({
          id: "microservice-dev-session",
          name: "Microservice dev-session: preview-local development",
          userId: "preview-admin",
          projectId: "preview-project",
          spec,
        }) as never,
    );
    const startWorkflowRun = vi.fn(async (input) => {
      execution = {
        ...parent(),
        userId: "preview-admin",
        id: input.executionId!,
        workflowId: "microservice-dev-session",
        projectId: "preview-project",
        input: input.triggerData as Record<string, unknown>,
        executionIr: { spec, triggerData: input.triggerData },
        daprInstanceId: "instance-1",
        currentNodeId: "await_control",
        phase: "awaiting-control",
        progress: 75,
        output: { pullRequest: null },
        error: null,
      } as WorkflowExecutionRecord;
      return {
        ok: true as const,
        executionId: input.executionId!,
        instanceId: "instance-1",
        workflowId: "microservice-dev-session",
        workflowName: "Microservice dev-session: preview-local development",
        reused: false,
      };
    });
    const raiseWorkflowEvent = vi.fn(async () => ({ ok: true as const }));
    const listSessionIdsByExecutionId = vi.fn(async () => ["session-1"]);
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
      definitions: { getByRef },
      executions: {
        getById: vi.fn(async () => execution),
        listSessionIdsByExecutionId,
      },
      projects: {
        getProjectExternalId: vi.fn(async () => "workspace-one"),
      },
      starter: { startWorkflowRun },
      events: { raiseWorkflowEvent },
    });
    const startOperation = operation("start-workflow", "5");
    const workflow = {
      executionId: __previewTargetDevelopmentForTest.childExecutionId({
        parentExecutionId: "parent-execution",
        operationId: startOperation,
        target,
        workflowSpecDigest: digest,
      }),
      workflowName: "microservice-dev-session" as const,
      workflowSpecDigest: digest,
    };

    const started = await service.startWorkflow({
      parentExecutionId: "parent-execution",
      actorUserId: "admin-1",
      operationId: startOperation,
      target,
      workflow,
      workflowInput: {
        intent: "Change the dashboard",
        services: ["workflow-builder"],
        keepPreview: true,
      },
    });

    expect(started.executionId).toBe(workflow.executionId);
    expect(startWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "microservice-dev-session",
        executionId: workflow.executionId,
        idempotent: true,
        launchSurface: "dev-environment",
        launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
        expectedWorkflowSpecDigest: digest,
      }),
    );
    expect(startWorkflowRun.mock.calls[0]![0]).not.toHaveProperty("userId");
    expect(getByRef).toHaveBeenCalledWith({
      workflowId: "microservice-dev-session",
    });
    const trigger = startWorkflowRun.mock.calls[0]![0].triggerData as Record<
      string,
      unknown
    >;
    expect(trigger).toMatchObject({
      intent: "Change the dashboard",
      services: ["workflow-builder"],
      keepPreview: "true",
      __previewDevelopment: {
        version: 2,
        remoteActorUserId: "admin-1",
      },
    });
    expect(trigger).not.toHaveProperty("previewOrigin");
    expect(trigger).not.toHaveProperty("sourceRevision");

    execution = {
      ...execution!,
      userId: "admin-1",
    } as WorkflowExecutionRecord;
    await expect(
      service.getWorkflowStatus({
        parentExecutionId: "parent-execution",
        actorUserId: "admin-1",
        operationId: operation("get-workflow-status", "6"),
        target,
        workflow,
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
    execution = {
      ...execution!,
      userId: "preview-admin",
    } as WorkflowExecutionRecord;

    await expect(
      service.getWorkflowStatus({
        parentExecutionId: "parent-execution",
        actorUserId: "other-remote-admin",
        operationId: operation("get-workflow-status", "6"),
        target,
        workflow,
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });

    const status = await service.getWorkflowStatus({
      parentExecutionId: "parent-execution",
      actorUserId: "admin-1",
      operationId: operation("get-workflow-status", "6"),
      target,
      workflow,
    });
    expect(status).toMatchObject({
      kind: "get-workflow-status",
      controlReady: true,
      sessionId: "session-1",
      sessionUrl:
        "https://wfb-feature-one.tail286401.ts.net/workspaces/workspace-one/sessions/session-1",
      terminal: false,
      output: null,
    });

    listSessionIdsByExecutionId.mockResolvedValueOnce([
      "session-1",
      "session-2",
    ]);
    await expect(
      service.getWorkflowStatus({
        parentExecutionId: "parent-execution",
        actorUserId: "admin-1",
        operationId: operation("get-workflow-status", "6"),
        target,
        workflow,
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });

    const promotionBranch = __previewTargetDevelopmentForTest.promotionBranch({
      target,
      executionId: workflow.executionId,
    });
    execution = {
      ...execution!,
      status: "success",
      output: {
        controlAction: "submit_preview_pr",
        controlOutcome: "submitted",
        pullRequestReceipt: {
          ok: true,
          receiptId: `pspr_${"d".repeat(64)}`,
          previewName: target.previewName,
          requestId: target.environmentRequestId,
          executionId: workflow.executionId,
          services: ["workflow-builder"],
          branch: promotionBranch,
          commitSha: "f".repeat(40),
          prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
          pullRequest: {
            repository: "PittampalliOrg/workflow-builder",
            number: 42,
            baseSha: "e".repeat(40),
            headSha: "f".repeat(40),
          },
          draft: true,
          credential: "must-not-cross",
        },
        preview: {
          services: [{ info: { syncCapability: "hmr-secret" } }],
        },
        sourceCapture: { token: "capture-secret" },
      },
    } as WorkflowExecutionRecord;
    const terminalStatus = await service.getWorkflowStatus({
      parentExecutionId: "parent-execution",
      actorUserId: "admin-1",
      operationId: operation("get-workflow-status", "6"),
      target,
      workflow,
    });
    expect(terminalStatus.output).toEqual({
      controlOutcome: "submitted",
      pullRequestReceipt: {
        ok: true,
        receiptId: `pspr_${"d".repeat(64)}`,
        previewName: target.previewName,
        requestId: target.environmentRequestId,
        executionId: workflow.executionId,
        services: ["workflow-builder"],
        branch: promotionBranch,
        commitSha: "f".repeat(40),
        prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
        pullRequest: {
          repository: "PittampalliOrg/workflow-builder",
          number: 42,
          baseSha: "e".repeat(40),
          headSha: "f".repeat(40),
        },
        draft: true,
      },
    });
    expect(JSON.stringify(terminalStatus)).not.toContain("syncCapability");
    expect(JSON.stringify(terminalStatus)).not.toContain("hmr-secret");
    expect(JSON.stringify(terminalStatus)).not.toContain("capture-secret");
    expect(JSON.stringify(terminalStatus)).not.toContain("must-not-cross");

    execution = {
      ...execution,
      status: "running",
      daprInstanceId: "instance-1",
      output: null,
    } as WorkflowExecutionRecord;

    await service.signalWorkflow({
      parentExecutionId: "parent-execution",
      actorUserId: "admin-1",
      operationId: operation("signal-workflow", "7"),
      target,
      workflow,
      action: "submit_preview_pr",
    });
    expect(raiseWorkflowEvent).toHaveBeenCalledWith({
      instanceId: "instance-1",
      eventName: "preview.development.control",
      eventData: { action: "submit_preview_pr" },
    });

    execution = {
      ...execution!,
      status: "success",
      daprInstanceId: null,
      output: { controlAction: "submit_preview_pr" },
    } as WorkflowExecutionRecord;
    await expect(
      service.signalWorkflow({
        parentExecutionId: "parent-execution",
        actorUserId: "admin-1",
        operationId: operation("signal-workflow", "7"),
        target,
        workflow,
        action: "submit_preview_pr",
      }),
    ).resolves.toMatchObject({ accepted: true, action: "submit_preview_pr" });
    expect(raiseWorkflowEvent).toHaveBeenCalledTimes(1);

    await expect(
      service.signalWorkflow({
        parentExecutionId: "parent-execution",
        actorUserId: "admin-1",
        operationId: operation("signal-workflow", "8"),
        target,
        workflow,
        action: "discard",
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
    expect(raiseWorkflowEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects a different local generation before any workflow lookup", async () => {
    const definitions = { getByRef: vi.fn() };
    const service = new ApplicationPreviewTargetDevelopmentLocalService({
      identity: {
        current: () => ({
          previewName: target.previewName,
          environmentRequestId: "other-request",
          environmentPlatformRevision: target.platformRevision,
          environmentSourceRevision: target.sourceRevision,
          catalogDigest: target.catalogDigest,
        }),
      },
      scope: {
        current: () => ({ kind: "control-plane" }),
        isControlPlane: () => true,
        allowsPreviewName: () => true,
      },
      definitions,
      executions: {
        getById: vi.fn(),
        listSessionIdsByExecutionId: vi.fn(),
      },
      projects: { getProjectExternalId: vi.fn() },
      starter: { startWorkflowRun: vi.fn() },
      events: { raiseWorkflowEvent: vi.fn() },
    });
    await expect(
      service.getWorkflowStatus({
        parentExecutionId: "parent-execution",
        actorUserId: "admin-1",
        operationId: operation("get-workflow-status", "8"),
        target,
        workflow: {
          executionId: "child-execution",
          workflowName: "microservice-dev-session",
          workflowSpecDigest: digest,
        },
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
    expect(definitions.getByRef).not.toHaveBeenCalled();
  });
});

describe("ApplicationPreviewTargetDevelopmentBrokerService", () => {
  const receiptId = `pspr_${"d".repeat(64)}`;
  const childExecutionId = "child-execution";
  const receipt = {
    receiptId,
    artifactId: "artifact-1",
    previewName: target.previewName,
    requestId: target.environmentRequestId,
    executionId: childExecutionId,
    platformRevision: target.platformRevision,
    sourceRevision: target.sourceRevision,
    catalogDigest: target.catalogDigest,
    repository: "PittampalliOrg/workflow-builder",
    baseBranch: "main",
    baseSha: "e".repeat(40),
    branch: __previewTargetDevelopmentForTest.promotionBranch({
      target,
      executionId: childExecutionId,
    }),
    commitSha: "f".repeat(40),
    prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
    pullRequestNumber: 42,
    draft: true as const,
    services: ["workflow-builder"],
    changedPaths: ["src/routes/dashboard/+page.svelte"],
    createdAt: "2026-07-16T12:00:00.000Z",
  };

  function previewRecord(parentExecutionId = "parent-execution") {
    return {
      name: target.previewName,
      provenance: {
        requestId: target.environmentRequestId,
        parentEnvironmentId: `${previewDevelopmentParentBindingPrefix(parentExecutionId)}${"1".repeat(64)}`,
      },
      origin: { kind: "workflow", reference: parentExecutionId },
      platformRevision: target.platformRevision as ImmutableGitSha,
      sourceRevision: target.sourceRevision as ImmutableGitSha,
      catalogDigest: target.catalogDigest,
      ready: true,
      phase: "ready",
      profile: "app-live",
      mode: "live",
      trustedCode: true,
      pool: null,
      url: "https://wfb-feature-one.tail286401.ts.net",
    };
  }

  function harness(
    stored: typeof receipt | null = receipt,
    authorizedOwner = "admin-1",
  ) {
    const getScoped = vi.fn(async () => stored as never);
    const authorizeRuntimeTuple = vi.fn(async () => ({
      owner: authorizedOwner,
      services: ["workflow-builder", "function-router"],
    }));
    const service = new ApplicationPreviewTargetDevelopmentBrokerService({
      previews: { get: vi.fn(async () => previewRecord() as never) },
      authority: {
        authorizeRuntime: vi.fn(),
        authorizeRuntimeTuple,
      } as never,
      capabilities: { mintControl: vi.fn() } as never,
      transport: {} as never,
      receipts: { getScoped },
    });
    return { service, getScoped, authorizeRuntimeTuple };
  }

  function command() {
    return {
      parentExecutionId: "parent-execution",
      actorUserId: "admin-1",
      operationId: operation("verify-promotion", "9"),
      target,
      childExecutionId,
      receiptId,
      services: ["workflow-builder"],
    } as const;
  }

  it("reauthorizes and attests start, status, and signal on the exact physical generation", async () => {
    const workflow = {
      executionId: "child-execution",
      workflowName: "microservice-dev-session" as const,
      workflowSpecDigest: digest,
    };
    const physicalPreview = previewRecord();
    const authorizedRuntime = {
      previewName: target.previewName,
      requestId: target.environmentRequestId,
      owner: "admin-1",
      platformRevision: target.platformRevision as ImmutableGitSha,
      sourceRevision: target.sourceRevision as ImmutableGitSha,
      catalogDigest: target.catalogDigest,
      services: ["workflow-builder"],
    } as AuthorizedPreviewControlSource;
    const authorizeRuntime = vi.fn(async () => authorizedRuntime);
    const authorizeRuntimeTuple = vi.fn(async () => authorizedRuntime);
    const get = vi.fn(async () => physicalPreview as never);
    const mintControl = vi.fn(() => "leaf-capability");
    const startWorkflow = vi.fn(async (input) => ({
      kind: "start-workflow" as const,
      operationId: input.operationId,
      target: input.target,
      ...input.workflow,
      instanceId: "instance-1",
      status: "running",
      reused: false,
    }));
    const getWorkflowStatus = vi.fn(async (input) => ({
      kind: "get-workflow-status" as const,
      operationId: input.operationId,
      target: input.target,
      ...input.workflow,
      status: "running",
      phase: "awaiting-control",
      progress: 75,
      currentNodeId: "await_control",
      controlReady: true,
      sessionId: "session-1",
      sessionUrl:
        "https://wfb-feature-one.tail286401.ts.net/workspaces/workspace-one/sessions/session-1",
      error: "candidate-controlled-error",
      output: { preview: { syncCapability: "must-not-cross" } },
      terminal: false,
      credential: "must-not-cross",
    }));
    const signalWorkflow = vi.fn(async (input) => ({
      kind: "signal-workflow" as const,
      operationId: input.operationId,
      target: input.target,
      ...input.workflow,
      action: input.action,
      accepted: true as const,
    }));
    const service = new ApplicationPreviewTargetDevelopmentBrokerService({
      previews: { get },
      authority: { authorizeRuntime, authorizeRuntimeTuple },
      capabilities: { mintControl },
      transport: {
        startWorkflow,
        getWorkflowStatus,
        signalWorkflow,
      },
      receipts: { getScoped: vi.fn() },
    });

    const startInput = {
      parentExecutionId: "parent-execution",
      actorUserId: "admin-1",
      operationId: operation("start-workflow", "1"),
      target,
      workflow,
      workflowInput: {
        intent: "Change the dashboard",
        services: ["workflow-builder"],
        keepPreview: true,
      },
    } as const;
    const statusInput = {
      parentExecutionId: "parent-execution",
      actorUserId: "admin-1",
      operationId: operation("get-workflow-status", "2"),
      target,
      workflow,
    } as const;
    const signalInput = {
      ...statusInput,
      operationId: operation("signal-workflow", "3"),
      action: "submit_preview_pr" as const,
    };

    await expect(service.startWorkflow(startInput)).resolves.toMatchObject({
      kind: "start-workflow",
      executionId: workflow.executionId,
    });
    const brokerStatus = await service.getWorkflowStatus(statusInput);
    expect(brokerStatus).toMatchObject({
      kind: "get-workflow-status",
      sessionId: "session-1",
      controlReady: true,
      error: null,
      output: null,
    });
    expect(JSON.stringify(brokerStatus)).not.toContain("must-not-cross");
    expect(JSON.stringify(brokerStatus)).not.toContain("candidate-controlled");
    await expect(service.signalWorkflow(signalInput)).resolves.toMatchObject({
      kind: "signal-workflow",
      action: "submit_preview_pr",
      accepted: true,
    });

    await expect(
      service.getWorkflowStatus({
        ...statusInput,
        parentExecutionId: "other-parent-execution",
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
    expect(getWorkflowStatus).toHaveBeenCalledTimes(1);

    expect(authorizeRuntime).toHaveBeenCalledWith({
      previewName: target.previewName,
      environmentRequestId: target.environmentRequestId,
      environmentPlatformRevision: target.platformRevision,
      environmentSourceRevision: target.sourceRevision,
      catalogDigest: target.catalogDigest,
      requiredServices: ["workflow-builder"],
    });
    expect(authorizeRuntimeTuple).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledTimes(4);
    expect(mintControl).toHaveBeenCalledTimes(3);
    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: physicalPreview.url,
        capability: "leaf-capability",
      }),
    );
    expect(getWorkflowStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: physicalPreview.url,
        capability: "leaf-capability",
      }),
    );
    expect(signalWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: physicalPreview.url,
        capability: "leaf-capability",
      }),
    );

    getWorkflowStatus.mockResolvedValueOnce({
      ...(await getWorkflowStatus.mock.results[0]!.value),
      operationId: statusInput.operationId,
      sessionUrl:
        "https://wfb-feature-one.other-tailnet.ts.net/workspaces/workspace-one/sessions/session-1",
    });
    await expect(service.getWorkflowStatus(statusInput)).rejects.toMatchObject({
      code: "contract-mismatch",
    });

    get.mockResolvedValueOnce({
      ...physicalPreview,
      provenance: { requestId: "replacement-request" },
    } as never);
    await expect(service.signalWorkflow(signalInput)).rejects.toMatchObject({
      code: "contract-mismatch",
    });
    expect(signalWorkflow).toHaveBeenCalledTimes(1);

    authorizeRuntimeTuple.mockResolvedValueOnce({
      ...authorizedRuntime,
      owner: "other-admin",
    });
    await expect(service.getWorkflowStatus(statusInput)).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(get).toHaveBeenCalledTimes(6);
    expect(getWorkflowStatus).toHaveBeenCalledTimes(2);
  });

  it("rejects a same-owner command from a different parent workflow", async () => {
    const h = harness();

    await expect(
      h.service.verifyPromotion({
        ...command(),
        parentExecutionId: "other-parent-execution",
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
    expect(h.getScoped).not.toHaveBeenCalled();
  });

  it("returns canonical immutable proof from the physical scoped receipt", async () => {
    const h = harness();
    await expect(h.service.verifyPromotion(command())).resolves.toEqual({
      kind: "verify-promotion",
      operationId: command().operationId,
      target,
      executionId: childExecutionId,
      verified: true,
      receipt: {
        ok: true,
        receiptId,
        previewName: target.previewName,
        requestId: target.environmentRequestId,
        executionId: childExecutionId,
        artifactId: "artifact-1",
        services: ["workflow-builder"],
        branch: receipt.branch,
        commitSha: receipt.commitSha,
        prUrl: receipt.prUrl,
        pullRequest: {
          repository: "PittampalliOrg/workflow-builder",
          number: 42,
          baseSha: receipt.baseSha,
          headSha: receipt.commitSha,
        },
        draft: true,
      },
    });
    expect(h.getScoped).toHaveBeenCalledWith({
      receiptId,
      previewName: target.previewName,
      requestId: target.environmentRequestId,
      executionId: childExecutionId,
      platformRevision: target.platformRevision,
      sourceRevision: target.sourceRevision,
      catalogDigest: target.catalogDigest,
      repository: "PittampalliOrg/workflow-builder",
      baseBranch: "main",
    });
    expect(h.authorizeRuntimeTuple).toHaveBeenCalledWith({
      previewName: target.previewName,
      environmentRequestId: target.environmentRequestId,
      environmentPlatformRevision: target.platformRevision,
      environmentSourceRevision: target.sourceRevision,
      catalogDigest: target.catalogDigest,
    });
  });

  it("rejects a parent actor that does not own the reauthorized generation", async () => {
    const h = harness(receipt, "other-admin");
    await expect(h.service.verifyPromotion(command())).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(h.getScoped).not.toHaveBeenCalled();
  });

  it("rejects a receipt that is only a subset of the lifecycle-selected services", async () => {
    const h = harness();
    await expect(
      h.service.verifyPromotion({
        ...command(),
        services: ["workflow-builder", "function-router"],
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
  });

  it.each([
    ["missing receipt", null],
    ["non-draft receipt", { ...receipt, draft: false }],
    ["service outside preview", { ...receipt, services: ["other-service"] }],
    [
      "wrong deterministic branch",
      { ...receipt, branch: "preview-feature-other" },
    ],
    ["inconsistent PR URL", { ...receipt, prUrl: `${receipt.prUrl}/files` }],
    ["identical Git heads", { ...receipt, baseSha: receipt.commitSha }],
  ])("rejects %s", async (_label, stored) => {
    const h = harness(stored as never);
    await expect(h.service.verifyPromotion(command())).rejects.toMatchObject({
      code: "contract-mismatch",
    });
  });
});

describe("workflowSpecDigest", () => {
  it("is stable across object key order", () => {
    expect(workflowSpecDigest({ b: 2, a: { d: 4, c: 3 } })).toBe(
      workflowSpecDigest({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });
});

describe("preview development session links", () => {
  const status = {
    kind: "get-workflow-status",
    operationId: operation("get-workflow-status", "a"),
    target,
    executionId: "child-execution",
    workflowName: "microservice-dev-session",
    workflowSpecDigest: digest,
    status: "running",
    phase: "awaiting-control",
    progress: 75,
    currentNodeId: "await_control",
    controlReady: true,
    sessionId: "session-1",
    sessionUrl:
      "https://wfb-feature-one.tail286401.ts.net/workspaces/workspace-one/sessions/session-1",
    error: null,
    output: null,
    terminal: false,
  } as const;

  it("accepts only the target preview's workspace-scoped HTTPS session URL", () => {
    expect(
      __previewTargetDevelopmentForTest.validSessionLink(
        status,
        target,
        "https://wfb-feature-one.tail286401.ts.net",
      ),
    ).toBe(true);
    expect(
      __previewTargetDevelopmentForTest.validSessionLink(
        { ...status, sessionUrl: "https://evil.example/sessions/session-1" },
        target,
        "https://wfb-feature-one.tail286401.ts.net",
      ),
    ).toBe(false);
    expect(
      __previewTargetDevelopmentForTest.validSessionLink(
        { ...status, sessionId: null, sessionUrl: null },
        target,
        "https://wfb-feature-one.tail286401.ts.net",
      ),
    ).toBe(false);
    expect(
      __previewTargetDevelopmentForTest.validSessionLink(
        {
          ...status,
          sessionUrl:
            "https://wfb-feature-one.other-tailnet.ts.net/workspaces/workspace-one/sessions/session-1",
        },
        target,
        "https://wfb-feature-one.tail286401.ts.net",
      ),
    ).toBe(false);
    expect(
      __previewTargetDevelopmentForTest.validSessionLink(
        { ...status, sessionUrl: `${status.sessionUrl}?token=must-not-cross` },
        target,
        "https://wfb-feature-one.tail286401.ts.net",
      ),
    ).toBe(false);
  });
});
