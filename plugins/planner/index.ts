import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import { PlannerIcon } from "./icon";

/**
 * AI Planner Agent Plugin
 *
 * This plugin provides actions for invoking the planner-dapr-agent workflow
 * via Dapr service invocation. This enables:
 *
 * - planner/run-workflow: Full planning → approval → execution workflow
 * - planner/plan: Just the planning phase (create tasks)
 * - planner/execute: Just the execution phase (implement tasks)
 *
 * When used in the workflow-builder, these actions invoke the planner-dapr-agent
 * service running in the same namespace via Dapr service invocation.
 */
const plannerPlugin: IntegrationPlugin = {
  type: "planner" as const,
  label: "AI Planner Agent",
  description: "Plan and execute features using Claude Code SDK with human approval",

  icon: PlannerIcon,

  formFields: [
    {
      id: "anthropicApiKey",
      label: "Anthropic API Key",
      type: "password",
      placeholder: "sk-ant-...",
      configKey: "apiKey",
      envVar: "ANTHROPIC_API_KEY",
      helpText: "Required for Claude-based planning and execution agents",
      helpLink: {
        text: "console.anthropic.com",
        url: "https://console.anthropic.com/settings/keys",
      },
    },
  ],

  // No test config - planner requires K8s infrastructure
  testConfig: undefined,

  // No NPM dependencies - planner runs as a separate service
  dependencies: {},

  actions: [
    {
      slug: "clone",
      label: "Clone Repository",
      description:
        "Clone a Git repository into an isolated workspace for planning and execution",
      category: "AI Planner",
      stepFunction: "cloneRepository",
      stepImportPath: "clone",
      configFields: [
        {
          key: "repositoryOwner",
          label: "GitHub Owner",
          type: "template-input",
          placeholder: "myorg",
          required: true,
        },
        {
          key: "repositoryRepo",
          label: "Repository Name",
          type: "template-input",
          placeholder: "my-repo",
          required: true,
        },
        {
          key: "repositoryBranch",
          label: "Branch",
          type: "template-input",
          defaultValue: "main",
        },
        {
          key: "repositoryToken",
          label: "GitHub Token (override)",
          type: "template-input",
          placeholder: "Uses GitHub integration token if blank",
        },
      ],
      outputFields: [
        { field: "success", description: "Whether the clone completed successfully" },
        {
          field: "clonePath",
          description:
            "Path to cloned repo. Use as cwd for plan/execute: {{Clone Repository.clonePath}}",
        },
        { field: "commitHash", description: "HEAD commit hash of cloned repo" },
        { field: "repository", description: "owner/repo string" },
        { field: "file_count", description: "Number of files in cloned repo" },
      ],
    },
    {
      slug: "run-workflow",
      label: "Run Planner Workflow",
      description:
        "Full planning → approval → execution workflow (invoked as child workflow)",
      category: "AI Planner",
      stepFunction: "runPlannerWorkflow",
      stepImportPath: "run-workflow",
      configFields: [
        {
          key: "featureRequest",
          label: "Feature Request",
          type: "template-textarea",
          placeholder:
            "Describe the feature you want to implement. Use {{NodeName.field}} to reference previous outputs.",
          rows: 4,
          example: "Add a logout button to the navbar that clears the user session",
          required: true,
        },
        {
          key: "cwd",
          label: "Working Directory",
          type: "template-input",
          placeholder: "/workspace",
          defaultValue: "/workspace",
          example: "/workspace/my-project",
        },
        {
          key: "autoApprove",
          label: "Auto-Approve Plan (true/false)",
          type: "select",
          defaultValue: "false",
          options: [
            { value: "false", label: "No - Require approval" },
            { value: "true", label: "Yes - Auto-approve" },
          ],
          placeholder: "Skip the approval gate and execute immediately",
        },
      ],
      outputFields: [
        { field: "success", description: "Whether the workflow completed successfully" },
        { field: "workflow_id", description: "Planner workflow ID for chaining with execute step" },
        { field: "task_count", description: "Number of tasks executed" },
        { field: "tasks", description: "Array of task objects" },
        { field: "requires_approval", description: "True if workflow is waiting for approval" },
      ],
    },
    {
      slug: "plan",
      label: "Plan Tasks Only",
      description:
        "Just the planning phase - creates tasks without execution (use with separate approval gate)",
      category: "AI Planner",
      stepFunction: "runPlanningOnly",
      stepImportPath: "plan",
      configFields: [
        {
          key: "featureRequest",
          label: "Feature Request",
          type: "template-textarea",
          placeholder:
            "Describe the feature to plan. Use {{NodeName.field}} to reference previous outputs.",
          rows: 4,
          example: "Implement dark mode toggle with system preference detection",
          required: true,
        },
        {
          key: "cwd",
          label: "Working Directory",
          type: "template-input",
          placeholder: "/workspace",
          defaultValue: "/workspace",
        },
        {
          key: "planningTimeoutMinutes",
          label: "Planning Timeout (minutes)",
          type: "number",
          defaultValue: "30",
          placeholder: "Maximum time to wait for planning completion",
        },
      ],
      outputFields: [
        { field: "success", description: "Whether planning succeeded" },
        { field: "workflow_id", description: "Planner workflow ID for chaining with execute step" },
        { field: "tasks", description: "Array of planned task objects" },
        { field: "task_count", description: "Number of tasks planned" },
        { field: "phase", description: "Current phase (planning_complete)" },
      ],
    },
    {
      slug: "execute",
      label: "Execute Tasks Only",
      description:
        "Execute previously planned tasks after approval (uses {{PlanNode.workflow_id}})",
      category: "AI Planner",
      stepFunction: "runExecutionOnly",
      stepImportPath: "execute",
      configFields: [
        {
          key: "workflowId",
          label: "Planner Workflow ID",
          type: "template-input",
          placeholder: "{{PlanNode.workflow_id}}",
          example: "{{Plan.workflow_id}}",
          required: true,
        },
        {
          key: "cwd",
          label: "Working Directory",
          type: "template-input",
          placeholder: "{{Clone Repository.clonePath}}",
          example: "{{Clone Repository.clonePath}}",
        },
        {
          key: "executionTimeoutMinutes",
          label: "Execution Timeout (minutes)",
          type: "number",
          defaultValue: "120",
          placeholder: "Maximum time to wait for execution completion",
        },
      ],
      outputFields: [
        { field: "success", description: "Whether execution succeeded" },
        { field: "workflow_id", description: "Planner workflow ID" },
        { field: "result", description: "Execution result object" },
        { field: "tasks", description: "Array of executed tasks" },
        { field: "task_count", description: "Number of tasks executed" },
        { field: "phase", description: "Current phase (execution_complete)" },
      ],
    },
    {
      slug: "multi-step",
      label: "Clone, Plan & Execute in Sandbox",
      description:
        "Full workflow: clone repo → plan tasks → approve → execute+test in isolated sandbox",
      category: "AI Planner",
      stepFunction: "runMultiStep",
      stepImportPath: "multi-step",
      configFields: [
        {
          key: "featureRequest",
          label: "Feature Request",
          type: "template-textarea",
          placeholder:
            "Describe the feature to implement. Use {{NodeName.field}} to reference previous outputs.",
          rows: 4,
          example: "Add a logout button to the navbar that clears the user session",
          required: true,
        },
        {
          key: "repositoryOwner",
          label: "GitHub Owner",
          type: "template-input",
          placeholder: "myorg",
        },
        {
          key: "repositoryRepo",
          label: "Repository Name",
          type: "template-input",
          placeholder: "my-repo",
        },
        {
          key: "repositoryBranch",
          label: "Branch",
          type: "template-input",
          defaultValue: "main",
        },
        {
          key: "repositoryToken",
          label: "GitHub Token",
          type: "template-input",
          placeholder: "Optional - for private repos",
        },
        {
          key: "model",
          label: "Model",
          type: "template-input",
          defaultValue: "gpt-5.2-codex",
        },
        {
          key: "maxTurns",
          label: "Max Agent Turns",
          type: "number",
          defaultValue: "20",
        },
        {
          key: "maxTestRetries",
          label: "Max Test Retries",
          type: "number",
          defaultValue: "3",
        },
        {
          key: "autoApprove",
          label: "Auto-Approve Plan",
          type: "select",
          defaultValue: "false",
          options: [
            { value: "false", label: "No - Require approval" },
            { value: "true", label: "Yes - Auto-approve" },
          ],
        },
      ],
      outputFields: [
        { field: "success", description: "Whether the workflow completed successfully" },
        { field: "workflow_id", description: "Planner workflow ID" },
        { field: "tasks", description: "Array of planned/executed tasks" },
        { field: "taskCount", description: "Number of tasks" },
        { field: "output", description: "Full workflow output including execution and test results" },
        { field: "phase", description: "Final phase (completed/failed)" },
      ],
    },
    {
      slug: "approve",
      label: "Approve Plan",
      description: "Approve or reject a planner workflow's plan",
      category: "AI Planner",
      stepFunction: "approvePlan",
      stepImportPath: "approve",
      configFields: [
        {
          key: "workflowId",
          label: "Planner Workflow ID",
          type: "template-input",
          placeholder: "{{PlanNode.workflow_id}}",
          example: "{{Plan.workflow_id}}",
          required: true,
        },
        {
          key: "approved",
          label: "Approved",
          type: "select",
          defaultValue: "true",
          options: [
            { value: "true", label: "Approve" },
            { value: "false", label: "Reject" },
          ],
          placeholder: "Whether to approve or reject the plan",
        },
        {
          key: "reason",
          label: "Reason",
          type: "template-input",
          placeholder: "Optional reason for approval/rejection",
        },
      ],
      outputFields: [
        { field: "success", description: "Whether the approval action succeeded" },
        { field: "approved", description: "Whether the plan was approved" },
        { field: "workflow_id", description: "Planner workflow ID" },
      ],
    },
    {
      slug: "status",
      label: "Check Plan Status",
      description: "Get current status of a planner workflow",
      category: "AI Planner",
      stepFunction: "getPlanStatus",
      stepImportPath: "status",
      configFields: [
        {
          key: "workflowId",
          label: "Planner Workflow ID",
          type: "template-input",
          placeholder: "{{PlanNode.workflow_id}}",
          example: "{{Plan.workflow_id}}",
          required: true,
        },
      ],
      outputFields: [
        { field: "success", description: "Whether the status check succeeded" },
        { field: "workflow_id", description: "Planner workflow ID" },
        { field: "runtime_status", description: "Dapr workflow runtime status" },
        { field: "phase", description: "Current phase (planning, awaiting_approval, executing, completed)" },
        { field: "progress", description: "Progress percentage" },
        { field: "message", description: "Status message" },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(plannerPlugin);

export default plannerPlugin;
