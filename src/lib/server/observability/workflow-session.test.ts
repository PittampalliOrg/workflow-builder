import { describe, expect, it } from "vitest";

describe("workflow session propagation", () => {
  it("injects canonical workflow and MLflow baggage keys", async () => {
    const { injectWorkflowSessionHeaders } = await import("./workflow-session");

    const headers = injectWorkflowSessionHeaders(
      { "Content-Type": "application/json", traceparent: "00-abc" },
      {
        sessionId: "session_1",
        workflowExecutionId: "exec_1",
        workflowId: "workflow_1",
        daprWorkflowInstanceId: "dapr_1",
        mlflowExperimentId: "11",
        mlflowRunId: "run_1",
        mlflowParentRunId: "parent_run_1",
        traceGroupId: "exec_1",
      },
    );

    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.traceparent).toBe("00-abc");
    expect(headers["x-workflow-session-id"]).toBe("session_1");
    expect(headers["x-workflow-execution-id"]).toBe("exec_1");
    expect(headers["x-workflow-trace-group-id"]).toBe("exec_1");
    expect(headers.baggage).toContain("session.id=session_1");
    expect(headers.baggage).toContain("workflow.execution.id=exec_1");
    expect(headers.baggage).toContain("workflow.id=workflow_1");
    expect(headers.baggage).toContain("dapr.workflow.instance_id=dapr_1");
    expect(headers.baggage).toContain("mlflow.experiment_id=11");
    expect(headers.baggage).toContain("mlflow.run_id=run_1");
    expect(headers.baggage).toContain("mlflow.parent_run_id=parent_run_1");
    expect(headers.baggage).toContain("workflow_builder.trace_group_id=exec_1");
  });

  it("preserves existing baggage while adding workflow correlation", async () => {
    const { injectWorkflowSessionHeaders } = await import("./workflow-session");

    const headers = injectWorkflowSessionHeaders(
      { baggage: "caller.id=smoke" },
      "exec_2",
    );

    expect(headers["x-workflow-session-id"]).toBe("exec_2");
    expect(headers.baggage).toContain("caller.id=smoke");
    expect(headers.baggage).toContain("workflow.execution.id=exec_2");
  });
});
