import { describe, expect, it } from "vitest";
import {
  sessionIdFromHeaders,
  workflowActivityContextFromHeaders,
} from "./workflow-session.js";

describe("workflow activity context extraction", () => {
  it("reads semantic workflow activity context from baggage headers", () => {
    const context = workflowActivityContextFromHeaders({
      baggage:
        "caller.id=smoke,workflow.activity.correlation_id=exec-1%3Anode-a%3A0,workflow.node.id=node-a,workflow.node.sequence=0,workflow.execution.id=exec-1,workflow.id=wf-1,session.id=exec-1",
    });

    expect(context).toMatchObject({
      sessionId: "exec-1",
      workflowExecutionId: "exec-1",
      workflowId: "wf-1",
      activityCorrelationId: "exec-1:node-a:0",
      nodeId: "node-a",
      nodeSequence: "0",
    });
  });

  it("falls back to body _otel when Dapr invocation metadata headers are absent", () => {
    const context = workflowActivityContextFromHeaders(
      {},
      {
        baggage:
          "workflow.activity.correlation_id=exec-2%3Anode-b%3A1,workflow.node.id=node-b,workflow.execution.id=exec-2,session.id=exec-2",
        "workflow.node.name": "Node B",
        "workflow.node.action_type": "workspace/profile",
      },
    );

    expect(context).toMatchObject({
      sessionId: "exec-2",
      workflowExecutionId: "exec-2",
      activityCorrelationId: "exec-2:node-b:1",
      nodeId: "node-b",
      nodeName: "Node B",
      actionType: "workspace/profile",
    });
    expect(sessionIdFromHeaders({}, { "workflow.execution.id": "exec-2" })).toBe(
      "exec-2",
    );
  });

  it("prefers header baggage over body fallback values", () => {
    const context = workflowActivityContextFromHeaders(
      {
        baggage:
          "workflow.activity.correlation_id=header-exec%3Anode%3A0,workflow.execution.id=header-exec",
      },
      {
        baggage:
          "workflow.activity.correlation_id=body-exec%3Anode%3A0,workflow.execution.id=body-exec",
      },
    );

    expect(context.workflowExecutionId).toBe("header-exec");
    expect(context.activityCorrelationId).toBe("header-exec:node:0");
  });
});
