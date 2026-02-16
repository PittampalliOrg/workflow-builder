import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import { MastraAgentIcon } from "./icon";
import { MastraAgentResult } from "./result-component";

const mastraAgentPlugin: IntegrationPlugin = {
  type: "agent",
  label: "Mastra Agent",
  description: "Run the Mastra agent with tools and real-time monitoring",

  icon: MastraAgentIcon,

  formFields: [],

  actions: [
    {
      slug: "mastra-run",
      label: "Run Mastra Agent",
      description:
        "Run the Mastra agent with a prompt. The agent has access to tools and returns a text response with tool call history and token usage.",
      category: "AI",
      stepFunction: "mastraRunStep",
      stepImportPath: "mastra-run",
      configFields: [
        {
          key: "prompt",
          label: "Prompt",
          type: "template-textarea",
          placeholder: "Enter the prompt for the agent...",
          required: true,
          rows: 4,
        },
        {
          key: "maxTurns",
          label: "Max Turns",
          type: "number",
          defaultValue: "50",
          placeholder: "50",
          min: 1,
          required: false,
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
        { field: "usage", description: "Token usage statistics" },
      ],
      outputConfig: {
        type: "component",
        component: MastraAgentResult,
      },
    },
  ],
};

registerIntegration(mastraAgentPlugin);
