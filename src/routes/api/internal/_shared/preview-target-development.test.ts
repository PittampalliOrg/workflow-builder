import { describe, expect, it } from "vitest";
import {
  parsePreviewDevelopmentHostRequest,
  parsePreviewDevelopmentWireRequest,
} from "./preview-target-development";

const target = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  platformRevision: "platform-1",
  sourceRevision: "source-1",
  catalogDigest: `sha256:${"a".repeat(64)}`,
};

const operationId = (kind: string) => `pdt-${kind}-${"b".repeat(64)}`;

describe("preview development command boundary", () => {
  it("accepts only user-authored start input on the host boundary", () => {
    expect(
      parsePreviewDevelopmentHostRequest({
        parentExecutionId: "parent-1",
        command: {
          kind: "start-workflow",
          operationId: operationId("start-workflow"),
          target,
          input: {
            intent: "Update the dashboard",
            services: ["workflow-builder"],
            keepPreview: true,
          },
        },
      }),
    ).toMatchObject({
      parentExecutionId: "parent-1",
      command: {
        kind: "start-workflow",
        input: { intent: "Update the dashboard" },
      },
    });
  });

  it("passes optional child controls through both boundaries verbatim", () => {
    const input = {
      intent: "Update the dashboard",
      services: ["workflow-builder"],
      ttlHours: 12,
      retainAfterCompletion: true,
      interactiveHandoff: "false",
      impactReview: true,
      diffScope: ["src/routes/dashboard"],
      maxIterations: 2,
    };
    expect(
      parsePreviewDevelopmentHostRequest({
        parentExecutionId: "parent-1",
        command: {
          kind: "start-workflow",
          operationId: operationId("start-workflow"),
          target,
          input,
        },
      }),
    ).toMatchObject({ command: { kind: "start-workflow", input } });
    expect(
      parsePreviewDevelopmentWireRequest({
        parentExecutionId: "parent-1",
        command: {
          kind: "start-workflow",
          actorUserId: "admin-1",
          operationId: operationId("start-workflow"),
          target,
          executionId: "child-1",
          workflowSpecDigest: `sha256:${"c".repeat(64)}`,
          input,
        },
      }),
    ).toMatchObject({ kind: "start-workflow", workflowInput: input });
  });

  it("keeps the default start input free of optional controls and rejects unknown ones", () => {
    const parsed = parsePreviewDevelopmentHostRequest({
      parentExecutionId: "parent-1",
      command: {
        kind: "start-workflow",
        operationId: operationId("start-workflow"),
        target,
        input: {
          intent: "Update the dashboard",
          services: ["workflow-builder"],
        },
      },
    });
    if (parsed.command.kind !== "start-workflow") {
      throw new Error("expected a start-workflow command");
    }
    expect(parsed.command.input).not.toHaveProperty("ttlHours");
    expect(parsed.command.input).not.toHaveProperty("retainAfterCompletion");
    expect(parsed.command.input).not.toHaveProperty("interactiveHandoff");
    expect(parsed.command.input).not.toHaveProperty("impactReview");
    expect(parsed.command.input).not.toHaveProperty("diffScope");
    expect(parsed.command.input).not.toHaveProperty("maxIterations");
    expect(() =>
      parsePreviewDevelopmentHostRequest({
        parentExecutionId: "parent-1",
        command: {
          kind: "start-workflow",
          operationId: operationId("start-workflow"),
          target,
          input: {
            intent: "Update the dashboard",
            services: ["workflow-builder"],
            retainForever: true,
          },
        },
      }),
    ).toThrow("workflowInput has unsupported fields: retainForever");
  });

  it.each(["actorUserId", "targetUrl", "capability", "workflowName"])(
    "rejects caller authority field %s",
    (field) => {
      expect(() =>
        parsePreviewDevelopmentHostRequest({
          parentExecutionId: "parent-1",
          command: {
            kind: "start-workflow",
            operationId: operationId("start-workflow"),
            target,
            input: {
              intent: "Update the dashboard",
              services: ["workflow-builder"],
            },
            [field]: "attacker-controlled",
          },
        }),
      ).toThrow("unsupported fields");
    },
  );

  it("reconstructs the fixed workflow receipt at the trusted broker boundary", () => {
    expect(
      parsePreviewDevelopmentWireRequest({
        parentExecutionId: "parent-1",
        command: {
          kind: "get-workflow-status",
          actorUserId: "admin-1",
          operationId: operationId("get-workflow-status"),
          target,
          executionId: "child-1",
          workflowSpecDigest: `sha256:${"c".repeat(64)}`,
        },
      }),
    ).toMatchObject({
      kind: "get-workflow-status",
      actorUserId: "admin-1",
      workflow: {
        executionId: "child-1",
        workflowName: "preview-ui-development-gan",
        workflowSpecDigest: `sha256:${"c".repeat(64)}`,
      },
    });
  });

  it("rejects the former flat wire shape and arbitrary workflow names", () => {
    expect(() =>
      parsePreviewDevelopmentWireRequest({
        parentExecutionId: "parent-1",
        actorUserId: "admin-1",
        operationId: operationId("get-workflow-status"),
        target,
        workflow: {
          executionId: "child-1",
          workflowName: "attacker-workflow",
          workflowSpecDigest: `sha256:${"c".repeat(64)}`,
        },
        command: { kind: "get-workflow-status" },
      }),
    ).toThrow("unsupported fields");

    expect(() =>
      parsePreviewDevelopmentWireRequest({
        parentExecutionId: "parent-1",
        command: {
          kind: "get-workflow-status",
          actorUserId: "admin-1",
          operationId: operationId("get-workflow-status"),
          target,
          executionId: "child-1",
          workflowSpecDigest: `sha256:${"c".repeat(64)}`,
          workflowName: "attacker-workflow",
        },
      }),
    ).toThrow("unsupported fields");
  });

  it("parses the physical verification command without a workflow spec", () => {
    const receiptId = `pspr_${"d".repeat(64)}`;
    expect(
      parsePreviewDevelopmentWireRequest({
        parentExecutionId: "parent-1",
        command: {
          kind: "verify-promotion",
          actorUserId: "admin-1",
          operationId: operationId("verify-promotion"),
          target,
          childExecutionId: "child-1",
          receiptId,
          services: ["workflow-builder"],
        },
      }),
    ).toEqual({
      kind: "verify-promotion",
      parentExecutionId: "parent-1",
      actorUserId: "admin-1",
      operationId: operationId("verify-promotion"),
      target,
      childExecutionId: "child-1",
      receiptId,
      services: ["workflow-builder"],
    });

    expect(() =>
      parsePreviewDevelopmentWireRequest({
        parentExecutionId: "parent-1",
        command: {
          kind: "verify-promotion",
          actorUserId: "admin-1",
          operationId: operationId("verify-promotion"),
          target,
          childExecutionId: "child-1",
          receiptId,
          services: ["workflow-builder"],
          workflowSpecDigest: `sha256:${"c".repeat(64)}`,
        },
      }),
    ).toThrow("unsupported fields");
  });
});
