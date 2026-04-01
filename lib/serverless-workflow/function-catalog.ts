/**
 * Function Catalog: Maps Dapr service action types to CNCF Serverless Workflow 1.0
 * `use.functions` definitions.
 *
 * Each function definition describes how to invoke a Dapr service via the sidecar's
 * service invocation API (localhost:3500). The `call` task references these by name.
 *
 * The function-router service dispatches actions by actionType pattern to backend services:
 *   - system/*       -> fn-system
 *   - workspace/*    -> openshell-agent-runtime
 *   - browser/*      -> openshell-agent-runtime
 *   - openshell/*    -> openshell-agent-runtime
 *   - openshell-langgraph*  -> openshell-langgraph-observable
 *   - durable/*      -> durable-agent
 *   - mcp/*          -> workflow-orchestrator
 *   - dapr-swe/*     -> dapr-swe
 *   - * (default)    -> fn-activepieces
 */

import type { FunctionDefinition } from "./types";

// ---------------------------------------------------------------------------
// Dapr sidecar base URL
// ---------------------------------------------------------------------------

const DAPR_SIDECAR = "http://localhost:3500";

function daprInvokeUrl(appId: string, method: string): string {
  return `${DAPR_SIDECAR}/v1.0/invoke/${appId}/method/${method}`;
}

// ---------------------------------------------------------------------------
// Function definitions by category
// ---------------------------------------------------------------------------

export interface CatalogFunction {
  /** SW 1.0 function name (used in `call: <name>`) */
  name: string;
  /** Human-readable label for UI */
  label: string;
  /** Description for UI/LLM context */
  description: string;
  /** Category for grouping in UI */
  category: string;
  /** The SW 1.0 function definition */
  definition: FunctionDefinition;
  /** Whether this action runs as a long-running child workflow */
  isChildWorkflow?: boolean;
}

// -- Workspace actions (routed to openshell-agent-runtime) ---

const workspaceActions: CatalogFunction[] = [
  {
    name: "workspaceProfile",
    label: "Workspace Profile",
    description: "Create or resolve an execution-scoped workspace profile",
    category: "Workspace",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "workspace/profile") },
      },
    },
  },
  {
    name: "workspaceClone",
    label: "Clone Repository",
    description: "Clone a repository into the execution workspace",
    category: "Workspace",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "workspace/clone") },
      },
    },
  },
  {
    name: "workspaceCommand",
    label: "Run Command",
    description: "Execute a shell command in the workspace",
    category: "Workspace",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "workspace/command") },
      },
    },
  },
  {
    name: "workspaceFile",
    label: "File Operation",
    description: "Read, write, or edit files in the workspace",
    category: "Workspace",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "workspace/file") },
      },
    },
  },
  {
    name: "workspaceCreatePR",
    label: "Create Pull Request",
    description: "Create a pull request in the repository",
    category: "Workspace",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "workspace/create-pull-request") },
      },
    },
  },
  {
    name: "workspaceCleanup",
    label: "Cleanup Workspace",
    description: "Cleanup the workspace session",
    category: "Workspace",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "workspace/cleanup") },
      },
    },
  },
];

// -- Browser actions (routed to openshell-agent-runtime) ---

const browserActions: CatalogFunction[] = [
  {
    name: "browserProfile",
    label: "Browser Profile",
    description: "Create an OpenShell-backed browser validation workspace",
    category: "Browser",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "browser/profile") },
      },
    },
  },
  {
    name: "browserClone",
    label: "Browser Clone",
    description: "Clone repository into browser workspace",
    category: "Browser",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "browser/clone") },
      },
    },
  },
  {
    name: "browserCommand",
    label: "Browser Command",
    description: "Execute shell command in browser workspace",
    category: "Browser",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "browser/command") },
      },
    },
  },
  {
    name: "browserValidate",
    label: "Browser Validate",
    description: "Validate changes in browser workspace",
    category: "Browser",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "browser/validate") },
      },
    },
  },
  {
    name: "browserCaptureFlow",
    label: "Capture Browser Flow",
    description: "Capture browser interactions",
    category: "Browser",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "browser/capture-flow") },
      },
    },
  },
  {
    name: "browserCleanup",
    label: "Browser Cleanup",
    description: "Cleanup browser workspace",
    category: "Browser",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "browser/cleanup") },
      },
    },
  },
];

// -- Agent actions (long-running child workflows) ---

const agentActions: CatalogFunction[] = [
  {
    name: "openshellRun",
    label: "OpenShell Agent",
    description: "Run an OpenShell coding agent (plan mode)",
    category: "Agent",
    isChildWorkflow: true,
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "openshell/run") },
      },
    },
  },
  {
    name: "openshellSessionStart",
    label: "OpenShell Session",
    description: "Start an OpenShell interactive session",
    category: "Agent",
    isChildWorkflow: true,
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-agent-runtime", "openshell/session-start") },
      },
    },
  },
  {
    name: "langgraphRun",
    label: "LangGraph Agent",
    description: "Run a LangGraph observable agent",
    category: "Agent",
    isChildWorkflow: true,
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("openshell-langgraph-observable", "openshell-langgraph-observable/run") },
      },
    },
  },
  {
    name: "durableRun",
    label: "Durable Agent",
    description: "Run a durable LLM agent with tool-calling",
    category: "Agent",
    isChildWorkflow: true,
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("durable-agent", "durable/run") },
      },
    },
  },
  {
    name: "durableClaudePlan",
    label: "Claude Plan",
    description: "Generate a Claude execution plan",
    category: "Agent",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("durable-agent", "durable/claude-plan") },
      },
    },
  },
  {
    name: "durableMaterializePlan",
    label: "Materialize Plan",
    description: "Write plan artifacts to workspace",
    category: "Agent",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("durable-agent", "durable/materialize-plan") },
      },
    },
  },
  {
    name: "durableExecutePlanDag",
    label: "Execute Plan DAG",
    description: "Execute a plan DAG structure",
    category: "Agent",
    isChildWorkflow: true,
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("durable-agent", "durable/execute-plan-dag") },
      },
    },
  },
  {
    name: "daprSweInitialize",
    label: "Initialize Sandbox",
    description: "Create OpenShell sandbox, clone repository, configure git identity",
    category: "Dapr SWE",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/initialize") },
      },
    },
  },
  {
    name: "daprSwePlan",
    label: "Create Plan",
    description: "Run PlannerAgent to analyze codebase and produce structured implementation plan with steps",
    category: "Dapr SWE",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/plan") },
      },
    },
  },
  {
    name: "daprSweDevelop",
    label: "Implement Step",
    description: "Run DeveloperAgent to implement a plan step with tool calls (read, write, execute)",
    category: "Dapr SWE",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/develop") },
      },
    },
  },
  {
    name: "daprSweReview",
    label: "Review Changes",
    description: "Run ReviewerAgent to analyze git diff and provide approval/feedback",
    category: "Dapr SWE",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/review") },
      },
    },
  },
  {
    name: "daprSweCommitPR",
    label: "Commit & Open PR",
    description: "Stage changes, create branch, commit, push, and open a draft GitHub PR",
    category: "Dapr SWE",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/commit-pr") },
      },
    },
  },
  {
    name: "daprSweSolve",
    label: "Solve Issue (Full Agent)",
    description: "Run the full CodingAgent end-to-end: explore, plan, implement, test, commit, PR",
    category: "Dapr SWE",
    isChildWorkflow: true,
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/solve") },
      },
    },
  },
];

// -- System actions ---

const systemActions: CatalogFunction[] = [
  {
    name: "httpRequest",
    label: "HTTP Request",
    description: "Make an HTTP request to any API endpoint",
    category: "System",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("fn-system", "system/http-request") },
      },
    },
  },
  {
    name: "databaseQuery",
    label: "Database Query",
    description: "Execute a SQL query",
    category: "System",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("fn-system", "system/database-query") },
      },
    },
  },
];

// -- MCP actions ---

const mcpActions: CatalogFunction[] = [
  {
    name: "mcpReplyToClient",
    label: "MCP Reply",
    description: "Reply to an MCP client with a response",
    category: "MCP",
    definition: {
      call: "http",
      with: {
        method: "POST",
        endpoint: { uri: daprInvokeUrl("workflow-orchestrator", "mcp/reply-to-client") },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Full catalog
// ---------------------------------------------------------------------------

export const FUNCTION_CATALOG: CatalogFunction[] = [
  ...workspaceActions,
  ...browserActions,
  ...agentActions,
  ...systemActions,
  ...mcpActions,
];

/** Build SW 1.0 `use.functions` record from the catalog */
export function buildUseFunctions(
  functionNames?: string[],
): Record<string, FunctionDefinition> {
  const functions: Record<string, FunctionDefinition> = {};
  const items = functionNames
    ? FUNCTION_CATALOG.filter((f) => functionNames.includes(f.name))
    : FUNCTION_CATALOG;
  for (const fn of items) {
    functions[fn.name] = fn.definition;
  }
  return functions;
}

/** Look up a catalog function by name */
export function getCatalogFunction(name: string): CatalogFunction | undefined {
  return FUNCTION_CATALOG.find((f) => f.name === name);
}

/** Get catalog functions grouped by category */
export function getCatalogByCategory(): Record<string, CatalogFunction[]> {
  const result: Record<string, CatalogFunction[]> = {};
  for (const fn of FUNCTION_CATALOG) {
    const list = result[fn.category] || [];
    list.push(fn);
    result[fn.category] = list;
  }
  return result;
}
