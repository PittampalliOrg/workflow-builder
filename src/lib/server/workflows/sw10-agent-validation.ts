const REMOVED_SW10_AGENT_CALLS = new Set([
  "claude/run",
  "openshell/run",
  "openshell/session-start",
  "openshell-langgraph/run",
  "openshell-langgraph-observable/run",
  "dapr-agent-py/run",
  "dapr-swe/run",
  "durable/plan",
]);

type ValidationIssue = {
  code: "removed_call" | "missing_workspace_ref" | "invalid_agent_runtime";
  call: string;
  path: string;
  value?: string;
};

function walk(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walk(item, `${path}[${index}]`, issues);
    }
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  const record = value as Record<string, unknown>;
  const call = typeof record.call === "string" ? record.call.trim() : "";
  if (REMOVED_SW10_AGENT_CALLS.has(call)) {
    issues.push({ code: "removed_call", call, path: `${path}.call` });
  } else if (call === "durable/run") {
    const withRecord =
      typeof record.with === "object" &&
      record.with !== null &&
      !Array.isArray(record.with)
        ? (record.with as Record<string, unknown>)
        : null;
    const workspaceRef =
      typeof withRecord?.workspaceRef === "string"
        ? withRecord.workspaceRef.trim()
        : "";
    const runtime =
      typeof withRecord?.agentRuntime === "string"
        ? withRecord.agentRuntime.trim()
        : "";
    if (
      !workspaceRef &&
      !["dapr-agent-py", "dapr-agent-py-testing"].includes(runtime)
    ) {
      issues.push({
        code: "missing_workspace_ref",
        call,
        path: `${path}.with.workspaceRef`,
      });
    }
    if (
      runtime &&
      ![
        "dapr-agent-py",
        "dapr-agent-py-testing",
        "durable-agent",
        "openshell-durable-agent",
      ].includes(runtime)
    ) {
      issues.push({
        code: "invalid_agent_runtime",
        call,
        path: `${path}.with.agentRuntime`,
        value: runtime,
      });
    }
  }

  for (const [key, child] of Object.entries(record)) {
    walk(child, `${path}.${key}`, issues);
  }
}

export function findRemovedSw10AgentCalls(spec: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walk(spec, "$", issues);
  return issues;
}

export function getRemovedSw10AgentCallsError(spec: unknown): string | null {
  const issues = findRemovedSw10AgentCalls(spec);
  if (issues.length === 0) {
    return null;
  }

  const removedIssues = issues.filter((issue) => issue.code === "removed_call");
  if (removedIssues.length > 0) {
    const details = removedIssues
      .map((issue) => `${issue.call} at ${issue.path}`)
      .slice(0, 5)
      .join(", ");

    return `SW 1.0 workflows only support durable/run for embedded agents. Remove retired agent calls: ${details}`;
  }

  const workspaceIssues = issues.filter(
    (issue) => issue.code === "missing_workspace_ref",
  );
  if (workspaceIssues.length > 0) {
    const details = workspaceIssues
      .map((issue) => issue.path)
      .slice(0, 5)
      .join(", ");
    return `SW 1.0 durable/run steps require an explicit with.workspaceRef for non-local agent runtimes. Add a workspace/profile step and bind its workspaceRef before execution: ${details}`;
  }

  const runtimeIssues = issues.filter(
    (issue) => issue.code === "invalid_agent_runtime",
  );
  if (runtimeIssues.length > 0) {
    const details = runtimeIssues
      .map((issue) => `${issue.value} at ${issue.path}`)
      .slice(0, 5)
      .join(", ");
    return `SW 1.0 durable/run only supports an approved agentRuntime: ${details}`;
  }

  return null;
}
