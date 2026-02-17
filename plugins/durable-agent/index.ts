import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import { DurableAgentIcon } from "./icon";
import { MastraAgentResult } from "../mastra-agent/result-component";

const durableAgentPlugin: IntegrationPlugin = {
  type: "durable",
  label: "Durable Agent",
  description: "Durable AI agent with workspace tools, backed by Dapr Workflow for reliability",

  icon: DurableAgentIcon,

  formFields: [],

  actions: [
    {
      slug: "run",
      label: "Durable Agent Run",
      description:
        "Run the durable agent with a prompt — survives restarts, has built-in retries",
      category: "AI",
      stepFunction: "durableRunStep",
      stepImportPath: "durable-run",
      configFields: [
        {
          key: "prompt",
          label: "Prompt",
          type: "template-textarea",
          placeholder: "What should the agent do?",
          required: true,
          rows: 4,
        },
        {
          key: "timeoutMinutes",
          label: "Timeout (minutes)",
          type: "number",
          defaultValue: "30",
          placeholder: "30",
          min: 1,
          required: false,
        },
      ],
      outputFields: [
        { field: "text", description: "Agent response text" },
        { field: "toolCalls", description: "Tools called during execution" },
        { field: "fileChanges", description: "Files created, modified, or deleted by the agent" },
        { field: "patch", description: "Unified diff patch of all file changes" },
        { field: "patchRef", description: "Reference to full patch artifact" },
        { field: "changeSummary", description: "Structured file change metadata" },
        { field: "usage", description: "Token usage statistics" },
      ],
      outputConfig: {
        type: "component",
        component: MastraAgentResult,
      },
    },
  ],
};

registerIntegration(durableAgentPlugin);
