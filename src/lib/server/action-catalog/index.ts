import { createHighlighter, type Highlighter } from "shiki";
import {
  daprFetch,
  getFnSystemUrl,
  getOrchestratorUrl,
} from "$lib/server/dapr-client";
import {
  toCodeFunctionDefinitionFromDetail,
  type CodeFunctionDetail,
  type CodeFunctionSummary,
} from "$lib/server/code-functions/model";
import {
  AP_CATALOG_SERVICE_ID,
  loadPieceMetadataActionSource,
  type PieceMetadataActionSourceReader,
} from "./piece-metadata-source";
import type {
  ActionAuthMetadata,
  ActionCatalogDetail,
  ActionCatalogServiceSnapshot,
  ActionCatalogSnapshot,
  ActionFieldMetadata,
  ActionCatalogSummary,
  ActionCompatibilityStatus,
  ActionRuntimeStatus,
  ActionSwProjection,
  ActionVisibility,
} from "./types";

let highlighterPromise: Promise<Highlighter> | null = null;

export interface ActionCatalogCodeFunctionReader {
  listCodeFunctions(userId: string): Promise<CodeFunctionSummary[]>;
  getCodeFunction(
    id: string,
    userId: string,
  ): Promise<CodeFunctionDetail | null>;
}

export interface ActionCatalogLoadOptions {
  codeFunctions?: ActionCatalogCodeFunctionReader;
  pieceMetadataSource?: PieceMetadataActionSourceReader | null;
}

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["dark-plus"],
      langs: ["python", "typescript", "json"],
    });
  }
  return highlighterPromise;
}

async function highlightCode(
  code: string,
  language?: string | null,
): Promise<string | null> {
  try {
    const highlighter = await getHighlighter();
    const lang =
      language === "python"
        ? "python"
        : language === "typescript" || language === "javascript"
          ? "typescript"
          : "json";
    return highlighter.codeToHtml(code, { lang, theme: "dark-plus" });
  } catch {
    return null;
  }
}

async function highlightJson(value: unknown): Promise<string | null> {
  if (value === null || value === undefined) return null;
  try {
    return await highlightCode(JSON.stringify(value, null, 2), "json");
  } catch {
    return null;
  }
}

type RemoteActionListResponse = {
  service?: string;
  ready?: boolean;
  errors?: string[];
  features?: string[];
  actions?: Array<Record<string, unknown>>;
};

const CACHE_TTL_MS = 30_000;
let cachedRemoteActions: {
  expiresAt: number;
  pieceMetadataSource: PieceMetadataActionSourceReader | null;
  items: Array<ActionCatalogDetail>;
  services: ActionCatalogServiceSnapshot[];
  partialErrors: { serviceId: string; error: string }[];
} | null = null;
let hasWarnedMissingCodeFunctionsTable = false;
let hasMissingCodeFunctionsTable = false;

type RemoteServiceDescriptor = {
  serviceId: "workflow-orchestrator" | "fn-system";
  getBaseUrl: () => string;
  metadataPath: string;
  introspectPath: string;
};

const REMOTE_SERVICES: RemoteServiceDescriptor[] = [
  {
    serviceId: "workflow-orchestrator",
    getBaseUrl: getOrchestratorUrl,
    metadataPath: "/api/metadata/actions",
    introspectPath: "/api/v2/runtime/introspect",
  },
  {
    serviceId: "fn-system",
    getBaseUrl: getFnSystemUrl,
    metadataPath: "/api/metadata/actions",
    introspectPath: "/api/runtime/introspect",
  },
];

function buildRuntimeStatus(
  serviceReady: boolean,
  features: string[] = [],
  errors: string[] = [],
): ActionRuntimeStatus {
  return {
    registered: true,
    ready: serviceReady,
    lastSeenAt: new Date().toISOString(),
    errors,
    features,
  };
}

function buildActionId(prefix: string, slug: string): string {
  return `${prefix}.${slug}`;
}

function buildDaprAgentPyDetail(): ActionCatalogDetail {
  // Post-cutover: durable/run nodes reference an agent by id. Sandbox config
  // comes from the agent's environment; MCP/skills from the agent's config.
  // The template below is a ref-shaped placeholder — users pick the agent in
  // the workflow side panel after dropping the node.
  const taskConfig = {
    call: "durable/run",
    with: {
      prompt: "",
      mode: "execute_direct",
      agentRuntime: "dapr-agent-py",
      cwd: "/sandbox",
      body: {
        prompt: "",
        mode: "execute_direct",
        agentRuntime: "dapr-agent-py",
        cwd: "/sandbox",
        // agentRef left unset — side-panel AgentPicker sets it
      },
    },
  };

  return {
    id: buildActionId("builtin", "durable/run"),
    slug: "durable/run",
    name: "durable/run",
    displayName: "dapr-agent-py",
    description: "Run the dapr-agent-py DurableAgent",
    providerId: "dapr-agent-py",
    providerLabel: "dapr-agent-py",
    providerIconUrl: null,
    category: "agent",
    serviceId: "dapr-agent-py",
    kind: "dapr-activity",
    visibility: "public-callable",
    compatibility: "compatible",
    group: "Agents",
    version: "1.0.0",
    language: "python",
    entrypoint: "agent/run",
    sourceKind: "activity",
    insertable: true,
    auth: null,
    fields: null,
    tags: ["dapr-agent-py", "workspace-runtime", "mcp"],
    doc: "Runs dapr-agent-py with a per-run OpenShell sandbox by default. Existing workflows can choose shared-runtime or provide an external workspaceRef.",
    inputSchema: {
      type: "object",
      required: ["prompt", "agentRef"],
      properties: {
        prompt: { type: "string" },
        agentRef: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            version: { type: "integer" },
          },
        },
        environmentRef: {
          type: "object",
          properties: {
            id: { type: "string" },
            version: { type: "integer" },
          },
        },
        overrides: {
          type: "object",
          properties: {
            maxTurns: { type: "integer" },
            timeoutMinutes: { type: "integer" },
            cwd: { type: "string" },
            tools: { type: "array", items: { type: "string" } },
            sandboxPolicy: { type: "object" },
          },
        },
      },
    },
    outputSchema: null,
    semanticModel: null,
    sourceCode: null,
    sourceHtml: null,
    sw: {
      functionName: "durable/run",
      definition: taskConfig,
      taskConfig,
      warnings: [
        "New agent workflows default to one OpenShell sandbox per workflow run.",
      ],
    },
    runtime: buildRuntimeStatus(
      true,
      ["dapr-agent-py", "workspace-runtime", "mcp-configurable"],
      [],
    ),
    rendered: null,
    raw: null,
  };
}

const CLI_AGENT_SLUG_OPTIONS = [
  { label: "Claude Code CLI", value: "cli-evaluator-critic-agent" },
  { label: "Codex CLI", value: "codex-cli-evaluator-critic-agent" },
  { label: "Antigravity CLI", value: "agy-cli-evaluator-critic-agent" },
  { label: "Claude Code Playwright Critic", value: "cli-playwright-critic-agent" },
  { label: "Codex Playwright Critic", value: "codex-playwright-critic-agent" },
  { label: "Antigravity Playwright Critic", value: "agy-playwright-critic-agent" },
];

function buildCliAgentOneShotDetail(): ActionCatalogDetail {
  const taskConfig = {
    call: "durable/run",
    with: {
      mode: "execute_direct",
      workspaceRef: "${ .runtime.executionId }",
      cwd: "/sandbox/work",
      agentRef: {
        slug: "cli-evaluator-critic-agent",
      },
      agentConfig: {
        name: "CLI Agent",
        instructions:
          "You are a one-shot CLI agent. Complete the prompt in the requested workspace, then stop.",
      },
      body: {
        prompt: "",
        mode: "execute_direct",
        overrides: {
          cwd: "/sandbox/work",
          maxTurns: 20,
          timeoutMinutes: 25,
        },
      },
    },
  };

  return {
    id: buildActionId("builtin", "cli-agent/run-one-shot"),
    slug: "cli-agent/run-one-shot",
    name: "cli-agent/run-one-shot",
    displayName: "Run CLI Agent",
    description:
      "Run a one-shot Claude Code, Codex, or Antigravity CLI agent via durable/run.",
    providerId: "cli-agent",
    providerLabel: "CLI Agents",
    providerIconUrl: null,
    category: "agent",
    serviceId: "cli-agent-py",
    kind: "dapr-activity",
    visibility: "public-callable",
    compatibility: "compatible",
    group: "Agents",
    version: "1.0.0",
    language: "python",
    entrypoint: "durable/run",
    sourceKind: "activity",
    insertable: true,
    auth: {
      required: true,
      displayName: "Linked CLI credential",
      description:
        "Uses the selected CLI agent's linked credential: Anthropic for Claude Code, OpenAI for Codex, or Google for Antigravity.",
      kinds: ["anthropic", "openai", "google"],
      authType: "subscription_oauth",
    },
    fields: [
      {
        name: "agentRef.slug",
        displayName: "CLI Agent",
        description:
          "Named agent profile to run. Swap this slug to use Claude Code CLI, Codex CLI, or Antigravity CLI with the same workflow task.",
        propertyType: "string",
        schemaType: "string",
        required: true,
        defaultValue: "cli-evaluator-critic-agent",
        dependsOn: [],
        refreshers: [],
        refreshOnSearch: false,
        options: {
          kind: "static",
          values: CLI_AGENT_SLUG_OPTIONS,
        },
      },
      {
        name: "body.prompt",
        displayName: "Prompt",
        description:
          "One-shot instruction inserted as the CLI agent's user prompt. Serverless Workflow expressions are allowed.",
        propertyType: "string",
        schemaType: "string",
        required: true,
        defaultValue: "",
        dependsOn: [],
        refreshers: [],
        refreshOnSearch: false,
        options: null,
      },
      {
        name: "body.overrides.cwd",
        displayName: "Working Directory",
        description: "Directory where the CLI agent should operate.",
        propertyType: "string",
        schemaType: "string",
        required: false,
        defaultValue: "/sandbox/work",
        dependsOn: [],
        refreshers: [],
        refreshOnSearch: false,
        options: null,
      },
    ],
    tags: [
      "agent",
      "cli-agent",
      "interactive-cli",
      "one-shot",
      "durable-run",
      "claude-code-cli",
      "claude-code-cli-glm",
      "codex-cli",
      "agy-cli",
    ],
    doc:
      "Provider-neutral one-shot CLI agent action. The workflow task is durable/run; provider differences are resolved from the selected named agent and the runtime registry before dispatch. Claude Code, Codex, and Antigravity complete via their existing hook-backed session_workflow path.",
    inputSchema: {
      type: "object",
      required: ["prompt", "agentRef"],
      properties: {
        prompt: {
          type: "string",
          title: "Prompt",
          format: "textarea",
          description: "One-shot instruction for the CLI agent.",
        },
        agentRef: {
          type: "object",
          title: "CLI Agent",
          required: ["slug"],
          properties: {
            slug: {
              type: "string",
              title: "Agent Slug",
              default: "cli-evaluator-critic-agent",
              enum: CLI_AGENT_SLUG_OPTIONS.map((item) => item.value),
            },
          },
        },
        agentConfig: {
          type: "object",
          title: "Role Framing",
          properties: {
            name: {
              type: "string",
              default: "CLI Agent",
            },
            instructions: {
              type: "string",
              format: "textarea",
            },
          },
        },
        workspaceRef: {
          type: "string",
          title: "Workspace Ref",
          default: "${ .runtime.executionId }",
          description:
            "Shared workspace reference for planner/generator/critic workflows.",
        },
        cwd: {
          type: "string",
          title: "Working Directory",
          default: "/sandbox/work",
        },
        maxTurns: {
          type: "integer",
          title: "Max Turns",
          default: 20,
        },
        timeoutMinutes: {
          type: "integer",
          title: "Timeout Minutes",
          default: 25,
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        content: { type: "string" },
        sessionId: { type: "string" },
        workspaceRef: { type: "string" },
        agentRuntime: { type: "string" },
      },
    },
    semanticModel: null,
    sourceCode: null,
    sourceHtml: null,
    sw: {
      functionName: "durable/run",
      definition: taskConfig,
      taskConfig,
      warnings: [
        "Select a named CLI agent slug before running. The selected agent supplies the provider runtime and auth binding.",
      ],
    },
    runtime: buildRuntimeStatus(
      true,
      [
        "interactive-cli",
        "durable/run",
        "hook-completion",
        "claude-code-cli",
        "claude-code-cli-glm",
        "codex-cli",
        "agy-cli",
      ],
      [],
    ),
    rendered: null,
    raw: null,
  };
}

function buildPreviewDevelopmentActionDetails(): ActionCatalogDetail[] {
	const targetSchema = {
		type: "object",
		additionalProperties: false,
		required: [
			"previewName",
			"environmentRequestId",
			"platformRevision",
			"sourceRevision",
			"catalogDigest",
		],
		properties: {
			previewName: { type: "string" },
			environmentRequestId: { type: "string" },
			platformRevision: { type: "string", pattern: "^[0-9a-f]{40}$" },
			sourceRevision: { type: "string", pattern: "^[0-9a-f]{40}$" },
			catalogDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
		},
	};
	const childIdentity = {
		executionId: { type: "string" },
		workflowSpecDigest: {
			type: "string",
			pattern: "^sha256:[0-9a-f]{64}$",
		},
	};
	const servicesSchema = {
		type: "array",
		minItems: 1,
		maxItems: 16,
		uniqueItems: true,
		items: {
			type: "string",
			pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
		},
	};
	const definitions: Array<{
		slug: string;
		displayName: string;
		description: string;
		inputSchema: Record<string, unknown>;
	}> = [
		{
			slug: "preview/environment-launch",
			displayName: "Launch Preview Environment",
			description:
				"Request an app-live PreviewEnvironment bound to the current host workflow execution.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["environmentName", "services", "ttlHours"],
				properties: {
					environmentName: { type: "string" },
					services: servicesSchema,
					ttlHours: { type: "integer", minimum: 2, maximum: 24 },
					retainAfterCompletion: { type: "boolean", default: false },
				},
			},
		},
		{
			slug: "preview/environment-status",
			displayName: "Observe Preview Environment",
			description:
				"Read the exact generation-bound PreviewEnvironment status for this host run.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["target"],
				properties: { target: targetSchema },
			},
		},
		{
			slug: "preview/workflow-start",
			displayName: "Start Preview Development Workflow",
			description:
				"Start the pinned microservice-dev-session inside the exact preview target.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["target", "intent", "services"],
				properties: {
					target: targetSchema,
					intent: { type: "string", minLength: 1, maxLength: 12000 },
					services: servicesSchema,
				},
			},
		},
		{
			slug: "preview/workflow-status",
			displayName: "Observe Preview Development Workflow",
			description: "Read the preview-local child workflow status and promotion receipt.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["target", "executionId", "workflowSpecDigest"],
				properties: { target: targetSchema, ...childIdentity },
			},
		},
		{
			slug: "preview/workflow-signal",
			displayName: "Control Preview Development Workflow",
			description:
				"Send the fixed submit_preview_pr or discard command to the exact preview-local child.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["target", "executionId", "workflowSpecDigest", "action"],
				properties: {
					target: targetSchema,
					...childIdentity,
					action: { type: "string", enum: ["submit_preview_pr", "discard"] },
				},
			},
		},
		{
			slug: "preview/workflow-verify-promotion",
			displayName: "Verify Preview Promotion",
			description:
				"Verify the child promotion against the physical broker's durable draft pull request receipt.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["target", "childExecutionId", "receiptId", "services"],
				properties: {
					target: targetSchema,
					childExecutionId: { type: "string" },
					receiptId: {
						type: "string",
						pattern: "^pspr_[0-9a-f]{64}$",
					},
					services: servicesSchema,
				},
			},
		},
		{
			slug: "preview/environment-teardown",
			displayName: "Teardown Preview Environment",
			description:
				"Request generation-fenced teardown of the PreviewEnvironment owned by this host run.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["target"],
				properties: { target: targetSchema },
			},
		},
		{
			slug: "preview/environment-teardown-status",
			displayName: "Observe Preview Teardown",
			description: "Read cleanup proof for a signed PreviewEnvironment teardown ticket.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["target", "ticket"],
				properties: {
					target: targetSchema,
					ticket: {
						type: "object",
						additionalProperties: false,
						required: [
							"name",
							"environmentUid",
							"requestId",
							"sourceRevision",
							"signature",
						],
						properties: {
							name: { type: "string" },
							environmentUid: { type: "string" },
							requestId: { type: "string" },
							sourceRevision: { type: "string", pattern: "^[0-9a-f]{40}$" },
							signature: { type: "string", pattern: "^[0-9a-f]{64}$" },
						},
					},
				},
			},
		},
	];

	return definitions.map((definition) => {
		const taskConfig = { call: definition.slug, with: {} };
		return {
			id: buildActionId("builtin", definition.slug),
			slug: definition.slug,
			name: definition.slug,
			displayName: definition.displayName,
			description: definition.description,
			providerId: "preview-development",
			providerLabel: "Preview Development",
			providerIconUrl: null,
			category: "preview",
			serviceId: "function-router",
			kind: "dapr-activity",
			visibility: "public-callable",
			compatibility: "compatible",
			group: "Preview Development",
			version: "1.0.0",
			language: "typescript",
			entrypoint: definition.slug,
			sourceKind: "activity",
			insertable: true,
			auth: null,
			fields: null,
			tags: ["preview", "vcluster", "development-lifecycle", "durable"],
			doc: "The function router binds this action to the trusted workflow execution and proxies a narrow command through the application-layer preview development ports.",
			inputSchema: definition.inputSchema,
			outputSchema: { type: "object" },
			semanticModel: null,
			sourceCode: null,
			sourceHtml: null,
			sw: {
				functionName: definition.slug,
				definition: taskConfig,
				taskConfig,
				warnings: [],
			},
			runtime: buildRuntimeStatus(true, ["host-preview-development"]),
			rendered: null,
			raw: null,
		} satisfies ActionCatalogDetail;
	});
}

function buildBrowserPreviewDetails(): ActionCatalogDetail[] {
  const startTaskConfig = {
    call: "browser/start-preview",
    with: {
      body: {
        input: {
          workspaceRef: "",
          previewId: "",
          repoPath: "",
          installCommand: "",
          devServerCommand: "",
          baseUrl: "http://127.0.0.1:3009",
          timeoutSeconds: 240,
          timeoutMs: 300000,
          keepAlive: true,
        },
      },
    },
  };
  const stopTaskConfig = {
    call: "browser/stop-preview",
    with: {
      body: {
        input: {
          previewId: "",
          workspaceRef: "",
          timeoutMs: 30000,
        },
      },
    },
  };

  const runtime = buildRuntimeStatus(
    true,
    ["openshell-agent-runtime", "generated-app-preview"],
    [],
  );

  return [
    {
      id: buildActionId("builtin", "browser/start-preview"),
      slug: "browser/start-preview",
      name: "browser/start-preview",
      displayName: "Start App Preview",
      description:
        "Start an interactive preview server for a generated app in a retained OpenShell sandbox.",
      providerId: "browser",
      providerLabel: "Browser",
      providerIconUrl: null,
      category: "preview",
      serviceId: "openshell-agent-runtime",
      kind: "dapr-activity",
      visibility: "public-callable",
      compatibility: "compatible",
      group: "Browser",
      version: "1.0.0",
      language: "python",
      entrypoint: "start-preview",
      sourceKind: "activity",
      insertable: true,
      auth: null,
      fields: null,
      tags: ["browser", "preview", "openshell", "sandbox"],
      doc:
        "Snapshots the workspace from an OpenShell sandbox, auto-detects the app directory unless repoPath is set, installs dependencies, starts a local server, and returns preview metadata.",
      inputSchema: {
        type: "object",
        required: ["workspaceRef"],
        properties: {
          workspaceRef: {
            type: "string",
            title: "Workspace Ref",
            description:
              "Workspace reference from a prior workspace/profile or durable/run step, for example ${ .workspace_profile.workspaceRef }.",
          },
          previewId: {
            type: "string",
            title: "Preview ID",
            description:
              "Optional stable preview identifier. Defaults to the workflow execution and node when omitted.",
          },
          sandboxName: {
            type: "string",
            title: "Sandbox Name",
            description:
              "Optional OpenShell sandbox name. Needed only when restarting a preview after runtime memory was lost.",
          },
          rootPath: {
            type: "string",
            title: "Sandbox Root Path",
            default: "/sandbox",
            description:
              "Root path inside the sandbox. Defaults to /sandbox.",
          },
          workingDir: {
            type: "string",
            title: "Working Directory",
            default: "/sandbox",
            description:
              "Working directory inside the sandbox. Usually /sandbox or the app root.",
          },
          repoPath: {
            type: "string",
            title: "App Path",
            description:
              "Optional app path inside the sandbox, such as /sandbox/my-app. Leave blank to auto-detect package.json or index.html.",
          },
          installCommand: {
            type: "string",
            title: "Install Command",
            format: "textarea",
            description:
              "Optional dependency install command. Leave blank to infer from package manager files.",
          },
          devServerCommand: {
            type: "string",
            title: "Dev Server Command",
            format: "textarea",
            description:
              "Optional server command. Supports {port}, $PORT, ${PORT}, and {baseUrl}; leave blank to infer.",
          },
          baseUrl: {
            type: "string",
            title: "Base URL",
            default: "http://127.0.0.1:3009",
            description:
              "Requested local URL shape. The runtime will replace the port with an available internal port.",
          },
          timeoutSeconds: {
            type: "integer",
            title: "Readiness Timeout Seconds",
            default: 240,
            description:
              "How long the runtime waits for the preview server to become ready.",
          },
          timeoutMs: {
            type: "integer",
            title: "Router Timeout Milliseconds",
            default: 300000,
            description:
              "Function-router HTTP timeout for the preview start action.",
          },
          keepAlive: {
            type: "boolean",
            title: "Keep Preview Alive",
            default: true,
            description:
              "Keep the preview server running after this action completes so the run detail page can link to it.",
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          previewId: { type: "string" },
          workspaceRef: { type: "string" },
          proxyPath: { type: "string" },
          baseUrl: { type: "string" },
          requestedRepoPath: { type: "string" },
          requestedBaseUrl: { type: "string" },
          requestedDevServerCommand: { type: "string" },
          requestedInstallCommand: { type: "string" },
          workingDirectory: { type: "string" },
          resolvedAppPath: { type: "string" },
          appPathSource: { type: "string" },
          sandbox: { type: "object" },
        },
      },
      semanticModel: null,
      sourceCode: null,
      sourceHtml: null,
      sw: {
        functionName: "browser/start-preview",
        definition: startTaskConfig,
        taskConfig: startTaskConfig,
        warnings: [],
      },
      runtime,
      rendered: null,
      raw: null,
    },
    {
      id: buildActionId("builtin", "browser/stop-preview"),
      slug: "browser/stop-preview",
      name: "browser/stop-preview",
      displayName: "Stop App Preview",
      description: "Stop a running generated app preview server.",
      providerId: "browser",
      providerLabel: "Browser",
      providerIconUrl: null,
      category: "preview",
      serviceId: "openshell-agent-runtime",
      kind: "dapr-activity",
      visibility: "public-callable",
      compatibility: "compatible",
      group: "Browser",
      version: "1.0.0",
      language: "python",
      entrypoint: "stop-preview",
      sourceKind: "activity",
      insertable: true,
      auth: null,
      fields: null,
      tags: ["browser", "preview", "openshell", "sandbox"],
      doc: "Stops a preview session previously started with browser/start-preview.",
      inputSchema: {
        type: "object",
        properties: {
          previewId: {
            type: "string",
            title: "Preview ID",
            description:
              "Preview identifier to stop. If omitted, workspaceRef is used.",
          },
          workspaceRef: {
            type: "string",
            title: "Workspace Ref",
            description:
              "Workspace reference used as a fallback preview identifier.",
          },
          timeoutMs: {
            type: "integer",
            title: "Router Timeout Milliseconds",
            default: 30000,
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          previewId: { type: "string" },
          status: { type: "string" },
        },
      },
      semanticModel: null,
      sourceCode: null,
      sourceHtml: null,
      sw: {
        functionName: "browser/stop-preview",
        definition: stopTaskConfig,
        taskConfig: stopTaskConfig,
        warnings: [],
      },
      runtime,
      rendered: null,
      raw: null,
    },
  ];
}

const RETIRED_AGENT_ACTION_PREFIXES = new Set([
  "agent",
  "mastra",
  "ms-agent",
  "openshell-langgraph",
  "openshell-langgraph-observable",
  "openshell-deepagent",
  "openshell-durable",
  "vanilla-durable",
  "dapr-agent-py",
  "dapr-swe",
  "claude",
]);

function isRetiredAgentCatalogItem(item: ActionCatalogDetail): boolean {
  if (item.slug === "durable/run") {
    return item.id !== buildActionId("builtin", "durable/run");
  }
  // AP piece actions (DB catalog) can share a slug prefix with retired agent
  // slugs (e.g. the @activepieces/piece-claude piece's `claude/*` actions)
  // but are legit function-router-routed integrations — never filter them.
  if (item.serviceId === AP_CATALOG_SERVICE_ID) return false;
  const prefix = item.slug.split("/")[0];
  return prefix === "durable" || RETIRED_AGENT_ACTION_PREFIXES.has(prefix);
}

function sanitizeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function humanizeLabel(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function normalizeVisibility(value: unknown): ActionVisibility {
  return value === "public-callable" ? "public-callable" : "inspect-only";
}

function normalizeCompatibility(
  value: unknown,
  visibility: ActionVisibility,
): ActionCompatibilityStatus {
  if (visibility === "inspect-only") return "inspect-only";
  if (value === "compatible-with-warnings") return "compatible-with-warnings";
  return "compatible";
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeAuth(value: unknown): ActionAuthMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    required: record.required === true,
    displayName:
      typeof record.displayName === "string" &&
      record.displayName.trim().length > 0
        ? record.displayName
        : null,
    description:
      typeof record.description === "string" &&
      record.description.trim().length > 0
        ? record.description
        : null,
    kinds: normalizeStringArray(record.kinds),
    authType:
      typeof record.authType === "string" && record.authType.trim().length > 0
        ? record.authType
        : null,
    connectionResourceType:
      typeof record.connectionResourceType === "string" &&
      record.connectionResourceType.trim().length > 0
        ? record.connectionResourceType
        : null,
  };
}

function normalizeActionFieldOption(
  value: unknown,
): { label: string; value: unknown } | null {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { label: String(value), value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const label =
    (typeof record.label === "string" && record.label) ||
    (typeof record.displayName === "string" && record.displayName) ||
    (typeof record.name === "string" && record.name) ||
    (typeof record.title === "string" && record.title) ||
    (typeof record.value === "string" && record.value) ||
    (typeof record.id === "string" && record.id) ||
    null;
  const optionValue =
    record.value ?? record.id ?? record.key ?? record.name ?? record.label;
  return label && optionValue !== undefined
    ? { label, value: optionValue }
    : null;
}

function normalizeActionFields(value: unknown): ActionFieldMetadata[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && !Array.isArray(item),
    )
    .map((item) => {
      const options =
        item.options && typeof item.options === "object"
          ? (item.options as Record<string, unknown>)
          : null;
      const staticValues = Array.isArray(options?.values)
        ? (options.values as unknown[])
            .map(normalizeActionFieldOption)
            .filter(
              (entry): entry is { label: string; value: unknown } =>
                entry !== null,
            )
        : [];
      return {
        name: typeof item.name === "string" ? item.name : "",
        displayName:
          typeof item.displayName === "string" &&
          item.displayName.trim().length > 0
            ? item.displayName
            : typeof item.name === "string"
              ? humanizeLabel(item.name)
              : "",
        description:
          typeof item.description === "string" &&
          item.description.trim().length > 0
            ? item.description
            : null,
        propertyType:
          typeof item.propertyType === "string" ? item.propertyType : "string",
        schemaType:
          typeof item.schemaType === "string" ? item.schemaType : "string",
        required: item.required === true,
        defaultValue: item.defaultValue ?? null,
        dependsOn: normalizeStringArray(item.dependsOn),
        refreshers: normalizeStringArray(item.refreshers),
        refreshOnSearch: item.refreshOnSearch === true,
        options:
          options?.kind === "dynamic"
            ? {
                kind: "dynamic" as const,
                refreshers: normalizeStringArray(options.refreshers),
                refreshOnSearch: options.refreshOnSearch === true,
              }
            : staticValues.length > 0
              ? {
                  kind: "static" as const,
                  values: staticValues,
                }
              : null,
      };
    })
    .filter((item) => item.name.length > 0);
}

function buildRemoteDetail(
  serviceId: string,
  serviceReady: boolean,
  serviceErrors: string[],
  serviceFeatures: string[],
  raw: Record<string, unknown>,
): ActionCatalogDetail {
  const visibility = normalizeVisibility(
    raw.visibility ??
      (raw.visibility === undefined &&
      raw.swCompatibility &&
      typeof raw.swCompatibility === "object" &&
      (raw.swCompatibility as Record<string, unknown>).status === "compatible"
        ? "public-callable"
        : "inspect-only"),
  );
  const swCompatibilityRaw =
    raw.swCompatibility && typeof raw.swCompatibility === "object"
      ? (raw.swCompatibility as Record<string, unknown>)
      : {};
  const swRaw =
    raw.sw && typeof raw.sw === "object"
      ? (raw.sw as Record<string, unknown>)
      : swCompatibilityRaw;
  const runtimeRaw =
    raw.runtime && typeof raw.runtime === "object"
      ? (raw.runtime as Record<string, unknown>)
      : {};
  const compatibility = normalizeCompatibility(
    raw.compatibility ??
      (swCompatibilityRaw.status === "compatible-with-warnings"
        ? "compatible-with-warnings"
        : swCompatibilityRaw.status === "compatible"
          ? "compatible"
          : visibility === "inspect-only"
            ? "inspect-only"
            : "compatible"),
    visibility,
  );
  const sourceRaw =
    raw.source && typeof raw.source === "object"
      ? (raw.source as Record<string, unknown>)
      : {};
  const signatureRaw =
    raw.signature && typeof raw.signature === "object"
      ? (raw.signature as Record<string, unknown>)
      : {};
  const actionName =
    sanitizeText(raw.actionName) ||
    sanitizeText(raw.name) ||
    sanitizeText(raw.id) ||
    sanitizeText(
      swCompatibilityRaw.projection &&
        typeof swCompatibilityRaw.projection === "object"
        ? (swCompatibilityRaw.projection as Record<string, unknown>)
            .functionRefName
        : "",
    );
  const inputSchema =
    raw.inputSchema && typeof raw.inputSchema === "object"
      ? (raw.inputSchema as Record<string, unknown>)
      : signatureRaw.inputSchema && typeof signatureRaw.inputSchema === "object"
        ? (signatureRaw.inputSchema as Record<string, unknown>)
        : null;
  const warnings = normalizeStringArray(
    swCompatibilityRaw.reasons ?? swRaw.warnings,
  );
  const hasExecutableProjection =
    (swRaw.taskConfig && typeof swRaw.taskConfig === "object") ||
    (swRaw.definition && typeof swRaw.definition === "object") ||
    (raw.taskConfig && typeof raw.taskConfig === "object") ||
    (raw.definition && typeof raw.definition === "object");

  const runtime: ActionRuntimeStatus = {
    registered: runtimeRaw.registered !== false,
    ready: runtimeRaw.ready === true || serviceReady,
    lastSeenAt:
      typeof runtimeRaw.lastSeenAt === "string"
        ? runtimeRaw.lastSeenAt
        : new Date().toISOString(),
    errors: normalizeStringArray(runtimeRaw.errors).concat(serviceErrors),
    features: normalizeStringArray(runtimeRaw.features).length
      ? normalizeStringArray(runtimeRaw.features)
      : serviceFeatures,
  };

  return {
    id:
      sanitizeText(raw.id) ||
      buildActionId(
        serviceId,
        sanitizeText(raw.slug) || sanitizeText(raw.name),
      ),
    slug: sanitizeText(raw.slug) || sanitizeText(raw.name),
    name: sanitizeText(raw.name) || sanitizeText(raw.slug),
    displayName:
      sanitizeText(raw.displayName) ||
      sanitizeText(raw.name) ||
      sanitizeText(raw.slug),
    description: sanitizeText(raw.description),
    providerId: sanitizeText(raw.providerId) || serviceId,
    providerLabel:
      sanitizeText(raw.providerLabel) || humanizeLabel(serviceId),
    providerIconUrl: sanitizeText(raw.providerIconUrl) || null,
    category:
      sanitizeText(raw.category) ||
      (raw.kind === "dapr-workflow" || raw.kind === "sw-subflow"
        ? "workflow"
        : "activity"),
    serviceId,
    kind:
      raw.kind === "dapr-workflow" || raw.kind === "sw-subflow"
        ? "dapr-workflow"
        : raw.kind === "code-function"
          ? "code-function"
          : raw.kind === "catalog-function" || raw.kind === "sw-function"
            ? "catalog-function"
            : "dapr-activity",
    visibility,
    compatibility,
    group:
      sanitizeText(raw.group) || sanitizeText(raw.category) || serviceId,
    version: sanitizeText(raw.version) || null,
    language: sanitizeText(raw.language) || null,
    entrypoint: sanitizeText(raw.entrypoint) || sanitizeText(raw.actionName) || null,
    sourceKind:
      raw.sourceKind === "code"
        ? "code"
        : raw.sourceKind === "workflow"
          ? "workflow"
          : raw.sourceKind === "activity"
            ? "activity"
            : "integration",
    insertable:
      visibility === "public-callable" &&
      compatibility !== "inspect-only" &&
      Boolean(hasExecutableProjection),
    auth: normalizeAuth(raw.auth),
    fields: normalizeActionFields(raw.fields),
    tags: normalizeStringArray(raw.tags),
    doc: sanitizeText(raw.doc) || null,
    inputSchema,
    outputSchema:
      raw.outputSchema && typeof raw.outputSchema === "object"
        ? (raw.outputSchema as Record<string, unknown>)
        : null,
    semanticModel:
      raw.semanticModel && typeof raw.semanticModel === "object"
        ? (raw.semanticModel as Record<string, unknown>)
        : null,
    sourceCode:
      sanitizeText(raw.sourceCode) ||
      sanitizeText(sourceRaw.sourceCode) ||
      null,
    sourceHtml: sanitizeText(raw.sourceHtml) || null,
    sw: {
      functionName:
        sanitizeText(swRaw.functionName) ||
        sanitizeText(
          swCompatibilityRaw.projection &&
            typeof swCompatibilityRaw.projection === "object"
            ? (swCompatibilityRaw.projection as Record<string, unknown>)
                .functionRefName
            : "",
        ) ||
        null,
      definition:
        swRaw.definition && typeof swRaw.definition === "object"
          ? (swRaw.definition as Record<string, unknown>)
          : raw.definition && typeof raw.definition === "object"
            ? (raw.definition as Record<string, unknown>)
            : null,
      taskConfig:
        swRaw.taskConfig && typeof swRaw.taskConfig === "object"
          ? (swRaw.taskConfig as Record<string, unknown>)
          : raw.taskConfig && typeof raw.taskConfig === "object"
            ? (raw.taskConfig as Record<string, unknown>)
            : null,
      warnings: [
        ...warnings,
        ...(visibility === "public-callable" && !hasExecutableProjection
          ? [
              "Action is visible but does not yet provide an executable SW projection.",
            ]
          : []),
      ],
    },
    runtime,
    rendered: null,
    raw,
  };
}

async function fetchRemoteService(
  descriptor: RemoteServiceDescriptor,
): Promise<{
  actions: ActionCatalogDetail[];
  service: ActionCatalogServiceSnapshot;
}> {
  const baseUrl = descriptor.getBaseUrl();
  const [metadataRes, introspectRes] = await Promise.all([
    daprFetch(`${baseUrl}${descriptor.metadataPath}`, { maxRetries: 1 }),
    daprFetch(`${baseUrl}${descriptor.introspectPath}`, { maxRetries: 1 }),
  ]);

  if (!metadataRes.ok) {
    throw new Error(`metadata HTTP ${metadataRes.status}`);
  }
  if (!introspectRes.ok) {
    throw new Error(`introspection HTTP ${introspectRes.status}`);
  }

  const payload = (await metadataRes.json()) as RemoteActionListResponse;
  const introspection = (await introspectRes.json()) as Record<string, unknown>;
  const ready = introspection.ready === true;
  const errors = normalizeStringArray(introspection.errors);
  const features = normalizeStringArray(introspection.features);
  const actions = Array.isArray(payload.actions) ? payload.actions : [];

  const details = actions
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    )
    .map((item) =>
      buildRemoteDetail(descriptor.serviceId, ready, errors, features, item),
    );

  const workflows = Array.isArray(introspection.registeredWorkflows)
    ? introspection.registeredWorkflows
    : [];

  return {
    actions: details,
    service: {
      service:
        typeof introspection.service === "string"
          ? introspection.service
          : descriptor.serviceId,
      version:
        typeof introspection.version === "string"
          ? introspection.version
          : "unknown",
      runtime:
        typeof introspection.runtime === "string"
          ? introspection.runtime
          : "unknown",
      ready,
      features,
      registeredWorkflows: workflows
        .filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null,
        )
        .map((item) => ({
          id: buildActionId(
            `${descriptor.serviceId}-workflow`,
            `${sanitizeText(item.name)}:${sanitizeText(item.version) || "latest"}`,
          ),
          name: sanitizeText(item.name),
          version: sanitizeText(item.version) || null,
          aliases: normalizeStringArray(item.aliases),
          isLatest: item.isLatest === true,
          service: descriptor.serviceId,
          source: sanitizeText(item.source) || "service-introspection",
        })),
      registeredActivities: details
        .filter((item) => item.kind === "dapr-activity")
        .map((item) => ({
          id: item.id,
          name: item.name,
          displayName: item.displayName,
          description: item.description,
          doc: item.doc ?? null,
          sourceCode: item.sourceCode ?? null,
          sourceHtml: item.sourceHtml ?? null,
        })),
      additional:
        introspection.additional && typeof introspection.additional === "object"
          ? (introspection.additional as Record<string, unknown>)
          : {},
    },
  };
}

function buildCodeFunctionDetail(
  detail: CodeFunctionDetail,
): ActionCatalogDetail {
  const definition = toCodeFunctionDefinitionFromDetail(detail);
  const runtime = buildRuntimeStatus(
    true,
    ["parser-backed", "code-runtime"],
    [],
  );
  return {
    id: buildActionId("code-function", detail.id),
    slug: detail.slug,
    name: detail.slug,
    displayName: detail.name,
    description: detail.description || "",
    providerId: "code-functions",
    providerLabel: "Code Functions",
    providerIconUrl: null,
    category: "code",
    serviceId: "code-functions",
    kind: "code-function",
    visibility: "public-callable",
    compatibility: "compatible",
    group: "Code Functions",
    version: detail.latestPublishedVersion || detail.version,
    language: detail.language,
    entrypoint: detail.entrypoint,
    sourceKind: "code",
    insertable: true,
    auth: null,
    fields: null,
    tags: [
      detail.language,
      ...(detail.model.capabilities.has_dynamic_inputs
        ? ["dynamic-inputs"]
        : []),
      ...(detail.model.capabilities.has_resource_types ? ["resources"] : []),
    ],
    doc: null,
    inputSchema:
      definition.input && typeof definition.input === "object"
        ? ((
            definition.input as {
              schema?: { document?: Record<string, unknown> };
            }
          ).schema?.document ?? null)
        : null,
    outputSchema:
      definition.output && typeof definition.output === "object"
        ? ((
            definition.output as unknown as {
              schema?: { document?: Record<string, unknown> };
            }
          ).schema?.document ?? null)
        : null,
    semanticModel:
      definition.semanticModel && typeof definition.semanticModel === "object"
        ? (definition.semanticModel as unknown as Record<string, unknown>)
        : null,
    sourceCode: detail.source,
    sourceHtml: null,
    sw: {
      functionName: detail.slug,
      definition: {
        call: definition.call,
        with: definition.with,
      },
      taskConfig:
        definition.taskConfig && typeof definition.taskConfig === "object"
          ? (definition.taskConfig as Record<string, unknown>)
          : null,
      warnings:
        Array.isArray(detail.model.diagnostics) &&
        detail.model.diagnostics.length > 0
          ? ["Parser diagnostics present"]
          : [],
    },
    runtime,
    rendered: null,
    raw: definition,
  };
}

async function loadCodeFunctionActions(
  userId?: string | null,
  reader?: ActionCatalogCodeFunctionReader,
): Promise<ActionCatalogDetail[]> {
  if (!userId) return [];
  if (!reader) return [];
  if (hasMissingCodeFunctionsTable) return [];
  try {
    const summaries = await reader.listCodeFunctions(userId);
    const items = await Promise.all(
      summaries.map(async (summary) => {
        const detail = await reader.getCodeFunction(summary.id, userId);
        if (!detail) return null;
        const action = buildCodeFunctionDetail(detail);
        action.sourceHtml = await highlightCode(detail.source, detail.language);
        return action;
      }),
    );
    return items.filter((item): item is ActionCatalogDetail => item !== null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error.cause : null;
    const causeCode =
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : null;
    const missingCodeFunctionsTable =
      causeCode === "42P01" && message.includes("code_functions");
    if (missingCodeFunctionsTable) {
      hasMissingCodeFunctionsTable = true;
      if (!hasWarnedMissingCodeFunctionsTable) {
        console.warn(
          "[action-catalog] code_functions table is unavailable in this environment; omitting saved code functions from the catalog.",
        );
        hasWarnedMissingCodeFunctionsTable = true;
      }
    } else {
      console.error("[action-catalog] Failed to load code functions:", error);
    }
    return [];
  }
}

async function loadRemoteActionCache(
  options: ActionCatalogLoadOptions = {},
): Promise<ActionCatalogDetail[]> {
  const pieceMetadataSource = options.pieceMetadataSource ?? null;
  if (
    cachedRemoteActions &&
    cachedRemoteActions.expiresAt > Date.now() &&
    cachedRemoteActions.pieceMetadataSource === pieceMetadataSource
  ) {
    return cachedRemoteActions.items;
  }

  // AP piece actions come from the piece_metadata DB table (synced by the
  // per-piece piece-runtime images), not from a live service fetch.
  const sources: Array<{
    serviceId: string;
    load: () => Promise<{
      actions: ActionCatalogDetail[];
      service: ActionCatalogServiceSnapshot;
    }>;
  }> = [
    ...REMOTE_SERVICES.map((service) => ({
      serviceId: service.serviceId as string,
      load: () => fetchRemoteService(service),
    })),
    ...(pieceMetadataSource
      ? [
          {
            serviceId: AP_CATALOG_SERVICE_ID,
            load: () => loadPieceMetadataActionSource(pieceMetadataSource),
          },
        ]
      : []),
  ];

  const settled = await Promise.allSettled(
    sources.map((source) => source.load()),
  );

  const actions: ActionCatalogDetail[] = [
    buildDaprAgentPyDetail(),
    buildCliAgentOneShotDetail(),
    ...buildPreviewDevelopmentActionDetails(),
    ...buildBrowserPreviewDetails(),
  ];
  const services: ActionCatalogServiceSnapshot[] = [];
  const partialErrors: { serviceId: string; error: string }[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      actions.push(
        ...result.value.actions.filter(
          (item) => !isRetiredAgentCatalogItem(item),
        ),
      );
      services.push(result.value.service);
    } else {
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      const message = reason || "unknown error";
      const serviceId = sources[index]?.serviceId ?? "unknown-service";
      partialErrors.push({ serviceId, error: message });
    }
  }

  cachedRemoteActions = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    pieceMetadataSource,
    items: actions,
    services,
    partialErrors,
  };

  return actions;
}

function sortActions<T extends ActionCatalogSummary>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.insertable !== right.insertable) return left.insertable ? -1 : 1;
    if (left.group !== right.group)
      return left.group.localeCompare(right.group);
    return left.displayName.localeCompare(right.displayName);
  });
}

export async function listActionCatalog(
  userId?: string | null,
  options: ActionCatalogLoadOptions = {},
): Promise<ActionCatalogSummary[]> {
  const [remote, code] = await Promise.all([
    loadRemoteActionCache(options),
    loadCodeFunctionActions(userId, options.codeFunctions),
  ]);
  return sortActions([...code, ...remote]).map((item) => ({
    id: item.id,
    slug: item.slug,
    name: item.name,
    displayName: item.displayName,
    description: item.description,
    providerId: item.providerId ?? null,
    providerLabel: item.providerLabel ?? null,
    providerIconUrl: item.providerIconUrl ?? null,
    category: item.category ?? null,
    serviceId: item.serviceId,
    kind: item.kind,
    visibility: item.visibility,
    compatibility: item.compatibility,
    group: item.group,
    version: item.version,
    language: item.language,
    entrypoint: item.entrypoint,
    sourceKind: item.sourceKind,
    insertable: item.insertable,
    tags: item.tags,
    runtime: item.runtime,
    inputSchema: item.inputSchema ?? null,
  }));
}

export async function getActionCatalogDetail(
  actionId: string,
  userId?: string | null,
  options: ActionCatalogLoadOptions = {},
): Promise<ActionCatalogDetail | null> {
  async function attachRendered(
    detail: ActionCatalogDetail,
  ): Promise<ActionCatalogDetail> {
    detail.rendered = {
      inputSchemaHtml: await highlightJson(detail.inputSchema),
      outputSchemaHtml: await highlightJson(detail.outputSchema),
      definitionHtml: await highlightJson(
        detail.sw.definition ?? detail.sw.taskConfig,
      ),
      rawHtml: await highlightJson(detail.raw ?? detail),
    };
    return detail;
  }

  if (actionId.startsWith("code-function.")) {
    const id = actionId.slice("code-function.".length);
    const detail =
      userId && options.codeFunctions
        ? await options.codeFunctions.getCodeFunction(id, userId)
        : null;
    if (!detail) return null;
    const action = buildCodeFunctionDetail(detail);
    action.sourceHtml = await highlightCode(detail.source, detail.language);
    return attachRendered(action);
  }

  const remote = await loadRemoteActionCache(options);
  const match = remote.find((item) => item.id === actionId);
  if (!match) return null;
  if (match.sourceCode && !match.sourceHtml) {
    match.sourceHtml = await highlightCode(match.sourceCode, match.language);
  }
  return attachRendered(match);
}

export async function loadActionCatalogSnapshot(
  userId?: string | null,
  options: ActionCatalogLoadOptions = {},
): Promise<ActionCatalogSnapshot> {
  const [code, remoteLoaded] = await Promise.all([
    loadCodeFunctionActions(userId, options.codeFunctions),
    loadRemoteActionCache(options),
  ]);
  const remote = cachedRemoteActions;
  const items = sortActions([...code, ...remoteLoaded]).map((item) => ({
    id: item.id,
    name: item.name,
    version: item.version,
    displayName: item.displayName,
    description: item.description,
    insertable: item.insertable,
    providerId: item.providerId ?? null,
    providerLabel: item.providerLabel ?? null,
    providerIconUrl: item.providerIconUrl ?? null,
    category: item.category ?? null,
    auth: item.auth ?? null,
    fields: item.fields ?? null,
    pieceName:
      item.kind === "code-function"
        ? "code-functions"
        : item.providerId || item.group,
    actionName: item.entrypoint || item.slug,
    service: item.serviceId,
    runtime:
      item.serviceId === "code-functions"
        ? `code-${item.language || "runtime"}`
        : "dapr",
    kind:
      item.kind === "dapr-workflow"
        ? "dapr-workflow"
        : item.kind === "dapr-activity"
          ? "dapr-activity"
          : "sw-function",
    visibility: item.visibility,
    sourceKind:
      item.kind === "code-function" || item.kind === "catalog-function"
        ? "catalog"
        : "runtime",
    language: item.language ?? null,
    entrypoint: item.entrypoint ?? null,
    registered: item.runtime.registered,
    ready: item.runtime.ready,
    features: item.runtime.features,
    sourceCode: item.sourceCode ?? null,
    sourceHtml: item.sourceHtml ?? null,
    doc: item.doc ?? null,
    inputSchema: item.inputSchema ?? null,
    outputSchema: item.outputSchema ?? null,
    taskConfig: item.sw.taskConfig ?? null,
    functionRef: item.sw.functionName
      ? {
          name: item.sw.functionName,
          version: item.version,
        }
      : null,
    warnings: item.sw.warnings,
  }));

  const codeService: ActionCatalogServiceSnapshot | null =
    code.length > 0
      ? {
          service: "code-functions",
          version: "local",
          runtime: "code-runtime",
          ready: true,
          features: ["parser-backed", "sw-compatible"],
          registeredWorkflows: [],
          registeredActivities: code.map((item) => ({
            id: item.id,
            name: item.name,
            displayName: item.displayName,
            description: item.description,
            doc: item.doc ?? null,
            sourceCode: item.sourceCode ?? null,
            sourceHtml: item.sourceHtml ?? null,
          })),
          additional: {},
        }
      : null;

  return {
    timestamp: new Date().toISOString(),
    sourceMode: "unified",
    services: codeService
      ? [...(remote?.services ?? []), codeService]
      : (remote?.services ?? []),
    items,
    partialErrors: remote?.partialErrors ?? [],
    error: null,
  };
}
