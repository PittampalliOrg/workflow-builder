/**
 * Canonical async coding workflow template.
 * Follows the reference architecture phases:
 * 1. Ingestion & Sandbox Provisioning
 * 2. Async Code Editing (CodeAct Loop)
 * 3. Dev Server & Visual Telemetry
 */

export type CodingWorkflowBackend = "openshell-deepagent" | "openshell-durable";

export type CodingWorkflowParams = {
  backend: CodingWorkflowBackend;
  repoUrl?: string;
  prompt?: string;
  maxTurns?: number;
};

type TemplateNode = {
  id: string;
  type: string;
  label: string;
  description: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
};

type TemplateEdge = {
  id: string;
  source: string;
  target: string;
};

export type WorkflowTemplate = {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
};

const NODE_SPACING_Y = 150;
const NODE_X = 400;

export function buildCodingWorkflow(params: CodingWorkflowParams): WorkflowTemplate {
  const { backend, repoUrl = "", prompt = "", maxTurns = 50 } = params;
  const actionPrefix = backend === "openshell-durable" ? "openshell-durable" : "openshell-deepagent";

  const nodes: TemplateNode[] = [
    {
      id: "trigger-1",
      type: "trigger",
      label: "Manual Trigger",
      description: "Start the coding workflow",
      position: { x: NODE_X, y: 0 },
      config: { triggerType: "Manual" },
    },
    {
      id: "workspace-profile",
      type: "action",
      label: "Workspace Profile",
      description: "Get sandbox workspace info",
      position: { x: NODE_X, y: NODE_SPACING_Y },
      config: {
        actionType: "workspace/profile",
        input: {},
      },
    },
    {
      id: "workspace-clone",
      type: "action",
      label: "Clone Repository",
      description: "Clone the target repo into sandbox",
      position: { x: NODE_X, y: NODE_SPACING_Y * 2 },
      config: {
        actionType: "workspace/clone",
        input: {
          repo_url: repoUrl,
        },
      },
    },
    {
      id: "agent-plan",
      type: "action",
      label: "Agent Plan",
      description: "Generate execution plan (requires approval)",
      position: { x: NODE_X, y: NODE_SPACING_Y * 3 },
      config: {
        actionType: `${actionPrefix}/run`,
        input: {
          prompt: prompt || "Implement the requested changes",
          mode: "plan_mode",
          maxTurns,
        },
      },
    },
    {
      id: "agent-execute",
      type: "action",
      label: "Agent Execute",
      description: "Execute the approved plan",
      position: { x: NODE_X, y: NODE_SPACING_Y * 4 },
      config: {
        actionType: `${actionPrefix}/run`,
        input: {
          prompt: prompt || "Execute the approved plan",
          mode: "execute_direct",
          maxTurns,
        },
      },
    },
    {
      id: "review-changes",
      type: "action",
      label: "Review Changes",
      description: "Review file changes made by the agent",
      position: { x: NODE_X, y: NODE_SPACING_Y * 5 },
      config: {
        actionType: "workspace/command",
        input: {
          command: "git diff --stat",
        },
      },
    },
    {
      id: "browser-validate",
      type: "action",
      label: "Browser Validation",
      description: "Capture screenshots for visual validation",
      position: { x: NODE_X, y: NODE_SPACING_Y * 6 },
      config: {
        actionType: "browser/validate",
        input: {
          urls: ["http://localhost:3000"],
        },
      },
    },
  ];

  const edges: TemplateEdge[] = [
    { id: "e-trigger-profile", source: "trigger-1", target: "workspace-profile" },
    { id: "e-profile-clone", source: "workspace-profile", target: "workspace-clone" },
    { id: "e-clone-plan", source: "workspace-clone", target: "agent-plan" },
    { id: "e-plan-execute", source: "agent-plan", target: "agent-execute" },
    { id: "e-execute-review", source: "agent-execute", target: "review-changes" },
    { id: "e-review-validate", source: "review-changes", target: "browser-validate" },
  ];

  return { nodes, edges };
}
