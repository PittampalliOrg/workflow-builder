/**
 * AI Canvas tools for CNCF Serverless Workflow 1.0.
 *
 * These tools replace the custom canvas-tools.ts with SW 1.0 task types.
 * LLMs have training data for the CNCF Serverless Workflow specification,
 * so they can generate valid task configurations natively.
 */

import { tool } from "ai";
import { z } from "zod";

export type SWCanvasToolResult = {
  op:
    | "addTask"
    | "updateTask"
    | "deleteTask"
    | "addEdge"
    | "deleteEdge"
    | "setWorkflowName"
    | "setWorkflowDescription"
    | "selectTask"
    | "clearWorkflow"
    | "autoArrange";
  payload: Record<string, unknown>;
  summary: string;
};

const taskTypeEnum = z.enum([
  "call",
  "set",
  "switch",
  "wait",
  "emit",
  "listen",
  "for",
  "fork",
  "try",
  "run",
  "raise",
  "do",
]);

export function getSWCanvasTools() {
  return {
    add_task: tool({
      description: `Add a new task node to the workflow canvas. This creates a visual node for a CNCF Serverless Workflow 1.0 task.

Task types and their key config fields:
- call: { call: "http"|"grpc"|functionName, with: { method, endpoint, body, ... } }
- set: { set: { key: value, ... } }
- switch: { switch: [{ caseName: { when: "expression", then: "taskName" } }] }
- wait: { wait: "PT30S" } (ISO 8601 duration)
- emit: { emit: { event: { with: { type: "event.type", data: {...} } } } }
- listen: { listen: { to: { one: { with: { type: "event.type" } } } } }
- for: { for: { each: "item", in: "\${ .items }" }, do: [...] }
- fork: { fork: { branches: [...] } }
- try: { try: [...], catch: { do: [...] } }
- run: { run: { shell: { command: "..." } } } or { run: { workflow: { name: "..." } } }
- raise: { raise: { error: { type: "...", status: 500 } } }
- do: { do: [...] }

Position nodes 250px apart. The start node already exists.`,
      inputSchema: z.object({
        id: z.string().describe("Unique task ID (e.g. 'fetch-data', 'check-status')"),
        type: taskTypeEnum.describe("The SW 1.0 task type"),
        label: z.string().describe("Human-readable label"),
        description: z.string().optional().describe("Optional task description"),
        position: z.object({
          x: z.number(),
          y: z.number(),
        }).describe("Canvas position. Start at x:350 y:200. Space 250px horizontally."),
        taskConfig: z.record(z.string(), z.unknown()).describe(
          "Task configuration matching the SW 1.0 spec for the selected type.",
        ),
      }),
      execute: async (args) => {
        return {
          op: "addTask",
          payload: {
            id: args.id,
            type: args.type,
            label: args.label,
            description: args.description,
            position: args.position,
            taskConfig: args.taskConfig,
          },
          summary: `Added ${args.type} task: ${args.label}`,
        } satisfies SWCanvasToolResult;
      },
    }),

    update_task: tool({
      description: "Update the configuration of an existing task node.",
      inputSchema: z.object({
        id: z.string().describe("The task node ID to update"),
        updates: z.record(z.string(), z.unknown()).describe(
          "Fields to update. Can include label, description, taskConfig, position.",
        ),
      }),
      execute: async (args) => {
        return {
          op: "updateTask",
          payload: { id: args.id, updates: args.updates },
          summary: `Updated task: ${args.id}`,
        } satisfies SWCanvasToolResult;
      },
    }),

    delete_task: tool({
      description: "Remove a task node and its connected edges.",
      inputSchema: z.object({
        id: z.string().describe("The task node ID to delete"),
      }),
      execute: async (args) => {
        return {
          op: "deleteTask",
          payload: { id: args.id },
          summary: `Deleted task: ${args.id}`,
        } satisfies SWCanvasToolResult;
      },
    }),

    add_edge: tool({
      description: "Connect two task nodes with an edge.",
      inputSchema: z.object({
        source: z.string().describe("Source task ID"),
        target: z.string().describe("Target task ID"),
        sourceHandle: z.string().optional().describe("Source handle (e.g. 'true'/'false' for switch nodes)"),
        label: z.string().optional().describe("Edge label"),
      }),
      execute: async (args) => {
        return {
          op: "addEdge",
          payload: {
            source: args.source,
            target: args.target,
            sourceHandle: args.sourceHandle,
            label: args.label,
          },
          summary: `Connected ${args.source} -> ${args.target}`,
        } satisfies SWCanvasToolResult;
      },
    }),

    delete_edge: tool({
      description: "Remove a connection between two task nodes.",
      inputSchema: z.object({
        source: z.string().describe("Source task ID"),
        target: z.string().describe("Target task ID"),
      }),
      execute: async (args) => {
        return {
          op: "deleteEdge",
          payload: { source: args.source, target: args.target },
          summary: `Disconnected ${args.source} -> ${args.target}`,
        } satisfies SWCanvasToolResult;
      },
    }),

    set_workflow_name: tool({
      description: "Set the workflow name and optional description.",
      inputSchema: z.object({
        name: z.string().describe("Workflow name"),
        description: z.string().optional().describe("Optional description"),
      }),
      execute: async (args) => {
        return {
          op: "setWorkflowName",
          payload: { name: args.name, description: args.description },
          summary: `Set workflow name: ${args.name}`,
        } satisfies SWCanvasToolResult;
      },
    }),

    clear_workflow: tool({
      description: "Clear all tasks and edges from the workflow (keeps start/end nodes).",
      inputSchema: z.object({}),
      execute: async () => {
        return {
          op: "clearWorkflow",
          payload: {},
          summary: "Cleared workflow",
        } satisfies SWCanvasToolResult;
      },
    }),

    auto_arrange: tool({
      description: "Auto-arrange all nodes using the DAG layout algorithm.",
      inputSchema: z.object({}),
      execute: async () => {
        return {
          op: "autoArrange",
          payload: {},
          summary: "Auto-arranged workflow",
        } satisfies SWCanvasToolResult;
      },
    }),
  };
}

/**
 * System prompt for the SW 1.0 AI workflow builder.
 *
 * Because CNCF Serverless Workflow is an open standard, LLMs have
 * training data for it and can generate valid configurations natively.
 */
export const SW_AI_SYSTEM_PROMPT = `You are a workflow builder assistant that helps users create CNCF Serverless Workflow 1.0 workflows visually.

You have tools to add, update, and delete task nodes on a visual canvas. Each node represents a SW 1.0 task.

## CNCF Serverless Workflow 1.0 Task Types

The 12 unified task types:

1. **call** - Invoke HTTP endpoints, gRPC services, or custom functions
   Config: { call: "http", with: { method: "POST", endpoint: { uri: "https://..." }, body: {...} } }
   For Dapr services: { call: "functionName", with: { ...args } } (references use.functions)

2. **set** - Set workflow variables
   Config: { set: { varName: "value", count: 0 } }

3. **switch** - Conditional branching
   Config: { switch: [{ caseName: { when: "\${ .status == 'active' }", then: "targetTask" } }] }

4. **wait** - Delay execution (ISO 8601 duration)
   Config: { wait: "PT30S" } (30 seconds), { wait: "PT5M" } (5 minutes)

5. **emit** - Publish a CloudEvent
   Config: { emit: { event: { with: { type: "order.completed", data: {...} } } } }

6. **listen** - Wait for a CloudEvent
   Config: { listen: { to: { one: { with: { type: "approval.response" } } } } }

7. **for** - Iterate over a collection
   Config: { for: { each: "item", in: "\${ .items }" }, do: [...] }

8. **fork** - Parallel execution
   Config: { fork: { branches: [{ branchA: {...} }, { branchB: {...} }] } }

9. **try** - Error handling
   Config: { try: [...tasks], catch: { do: [...fallbackTasks] } }

10. **run** - Run shell commands, scripts, containers, or child workflows
    Config: { run: { shell: { command: "echo hello" } } }
    Config: { run: { workflow: { name: "child-wf", version: "1.0.0" } } }

11. **raise** - Throw an error
    Config: { raise: { error: { type: "validation", status: 400, title: "Invalid input" } } }

12. **do** - Sequential sub-tasks
    Config: { do: [{ step1: {...} }, { step2: {...} }] }

## Layout Rules
- Start node is at position (100, 200)
- Space nodes 250px horizontally for sequential flows
- Space nodes 250px vertically for parallel branches
- Connect nodes with edges to define the flow

## Runtime Expressions
Use \${ .path } syntax for runtime expressions that reference workflow context:
- \${ .input.name } - Access workflow input
- \${ .taskName.output } - Access a previous task's output
`;
