import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  currentWorkflowMcpContext,
  hasWorkflowMcpScope,
  type WorkflowMcpRequestContext,
} from "./auth-context.js";
import { setSpanOutput } from "./observability/content.js";
import type { RegisteredTool } from "./workflow-tools.js";

export const WORKFLOW_MCP_INSTRUCTIONS = [
  "Call get_workflow_context before workflow writes to confirm the authenticated workspace and capabilities.",
  "Workflow definition operations use the authenticated Workflow Builder workspace and do not take a sessionId tool argument.",
  "A validated session attachment enables goal and trace lineage; team capabilities additionally require a signed platform team role.",
  "Do not use an MCP transport session ID, an AI-client thread ID, or a raw Workflow Builder session ID as authentication.",
].join(" ");

function textResult(data: unknown) {
  setSpanOutput(data);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function workflowContextDocument(
  context: WorkflowMcpRequestContext = currentWorkflowMcpContext(),
): Record<string, unknown> {
  const principal = context.principal;
  if (!principal) {
    return {
      authenticated: false,
      workspace: null,
      session: null,
      scopes: [],
      capabilities: {
        workflowRead: false,
        workflowWrite: false,
        workflowExecute: false,
        agentWrite: false,
      },
      error: context.error ?? {
        code: "workspace_auth_required",
        message:
          "Authenticate with a workspace-scoped Workflow Builder API key.",
      },
      setup: {
        header: "Authorization: Bearer <workspace API key>",
        message:
          "Create the key in the selected workspace's Settings > API Keys screen, then configure it on the MCP connection. Do not supply a sessionId to workflow authoring tools.",
      },
    };
  }

  return {
    authenticated: true,
    authMode: principal.authMode,
    userId: principal.userId,
    workspace: principal.workspace ?? { id: principal.projectId },
    session: principal.sessionId
      ? { attached: true, sessionId: principal.sessionId }
      : { attached: false },
    scopes: principal.scopes,
    capabilities: {
      workflowRead: hasWorkflowMcpScope(principal, "workflow:read"),
      workflowWrite: hasWorkflowMcpScope(principal, "workflow:write"),
      workflowExecute: hasWorkflowMcpScope(principal, "workflow:execute"),
      agentWrite: hasWorkflowMcpScope(principal, "agent:write"),
    },
    instructions: WORKFLOW_MCP_INSTRUCTIONS,
  };
}

export function registerWorkflowContextTool(
  server: McpServer,
  context?: WorkflowMcpRequestContext,
): RegisteredTool[] {
  (server as any).registerTool(
    "get_workflow_context",
    {
      title: "Get Workflow Context",
      description:
        "Show the authenticated Workflow Builder workspace, optional attached platform session, granted scopes, and setup guidance. Call this first when workflow operations are unavailable or their ownership is unclear.",
      inputSchema: {},
    },
    async () => textResult(workflowContextDocument(context)),
  );
  return [
    {
      name: "get_workflow_context",
      description: "Inspect the authenticated workspace and MCP capabilities",
    },
  ];
}
