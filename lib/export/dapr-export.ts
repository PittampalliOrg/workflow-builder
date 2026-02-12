import "@/plugins";
import { getAllEnvVars } from "@/plugins";
import { resolveActionCode } from "@/lib/export/action-code-resolver";
import { generateWorkflowDefinition } from "@/lib/workflow-definition";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

export type DaprExportBundle = {
	files: Record<string, string>;
};

type BuildDaprExportBundleOptions = {
	workflowId: string;
	workflowName: string;
	workflowDescription?: string | null;
	author?: string;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
};

type ActionManifestEntry = {
	nodeId: string;
	nodeName: string;
	actionType: string;
	source: string;
	file: string;
};

const CONFIG_EXCLUDED_KEYS = new Set(["actionType", "integrationId", "auth"]);

function sanitizePathSegment(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return sanitized || "workflow";
}

function toTypeScriptLiteral(value: unknown): string {
	if (value === null) {
		return "null";
	}

	if (value === undefined) {
		return "undefined";
	}

	if (typeof value === "string") {
		return JSON.stringify(value);
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map((entry) => toTypeScriptLiteral(entry)).join(", ")}]`;
	}

	if (typeof value === "object") {
		const entries = Object.entries(value).map(([key, entry]) => {
			return `${JSON.stringify(key)}: ${toTypeScriptLiteral(entry)}`;
		});
		return `{ ${entries.join(", ")} }`;
	}

	return "undefined";
}

function extractNodeInput(config: Record<string, unknown> | undefined): string {
	if (!config) {
		return "{}";
	}

	const input: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (!CONFIG_EXCLUDED_KEYS.has(key)) {
			input[key] = value;
		}
	}
	return toTypeScriptLiteral(input);
}

function generateEnvExample(): string {
	const envVars = getAllEnvVars();
	const unique = new Map<string, string>();

	for (const envVar of envVars) {
		unique.set(envVar.name, envVar.description);
	}

	const lines = [
		"# Dapr orchestrator endpoint",
		"WORKFLOW_ORCHESTRATOR_URL=http://workflow-orchestrator:8080",
		"",
		"# Optional: function router endpoint used by generated wrappers",
		"FUNCTION_ROUTER_URL=http://function-router:8080/execute",
		"",
		"# Optional: auth token for orchestrator endpoints",
		"WORKFLOW_EXPORT_TOKEN=",
	];

	if (unique.size > 0) {
		lines.push("");
		lines.push("# Plugin and integration environment variables");
		for (const [name] of unique) {
			lines.push(`${name}=`);
		}
	}

	return lines.join("\n") + "\n";
}

function generateReadme(workflowName: string, workflowId: string): string {
	return `# ${workflowName} (Dapr Export)

This bundle was generated from Workflow Builder.

## Included Files

- \`workflow/definition.json\`: Serialized workflow definition consumed by the orchestrator
- \`workflow/actions/*.ts\`: Action-level code representations for each action node
- \`workflow/actions/manifest.json\`: Node-to-action code map
- \`runner/execute.ts\`: Starts the workflow via Dapr orchestrator API
- \`runner/status.ts\`: Checks workflow execution status
- \`runner/events.ts\`: Raises workflow external events (approval gates, etc.)

## Quick Start

1. Install dependencies:

\`\`\`bash
pnpm install
\`\`\`

2. Configure environment variables:

\`\`\`bash
cp .env.example .env
\`\`\`

3. Start a workflow run:

\`\`\`bash
pnpm run run:workflow
\`\`\`

## Notes

- Default workflow ID in this bundle: \`${workflowId}\`
- Generated action files are for visibility and customization; runtime execution still flows through your function-router and Dapr services.
`;
}

function generateRunnerExecute(defaultInputLiteral: string): string {
	return `import { readFile } from "node:fs/promises";
import { join } from "node:path";

type StartWorkflowResponse = {
  instanceId: string;
  workflowId: string;
  status: string;
};

const ORCHESTRATOR_URL =
  process.env.WORKFLOW_ORCHESTRATOR_URL || "http://workflow-orchestrator:8080";

const DEFAULT_TRIGGER_DATA = ${defaultInputLiteral};

async function main() {
  const definitionPath = join(process.cwd(), "workflow", "definition.json");
  const definitionRaw = await readFile(definitionPath, "utf-8");
  const definition = JSON.parse(definitionRaw);

  const response = await fetch(\`\${ORCHESTRATOR_URL}/api/v2/workflows\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.WORKFLOW_EXPORT_TOKEN
        ? { Authorization: \`Bearer \${process.env.WORKFLOW_EXPORT_TOKEN}\` }
        : {}),
    },
    body: JSON.stringify({
      definition,
      triggerData: DEFAULT_TRIGGER_DATA,
      integrations: {},
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(\`Failed to start workflow (\${response.status}): \${errorBody}\`);
  }

  const result = (await response.json()) as StartWorkflowResponse;
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
`;
}

function generateRunnerStatus(): string {
	return `type WorkflowStatusResponse = {
  instanceId: string;
  workflowId: string;
  runtimeStatus: string;
  phase?: string;
  progress?: number;
  message?: string;
  outputs?: Record<string, unknown>;
  error?: string;
};

const ORCHESTRATOR_URL =
  process.env.WORKFLOW_ORCHESTRATOR_URL || "http://workflow-orchestrator:8080";

async function main() {
  const instanceId = process.argv[2];
  if (!instanceId) {
    throw new Error("Usage: pnpm run workflow:status <instanceId>");
  }

  const response = await fetch(
    \`\${ORCHESTRATOR_URL}/api/v2/workflows/\${encodeURIComponent(instanceId)}/status\`
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(\`Failed to fetch status (\${response.status}): \${body}\`);
  }

  const status = (await response.json()) as WorkflowStatusResponse;
  console.log(JSON.stringify(status, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
`;
}

function generateRunnerEvents(): string {
	return `const ORCHESTRATOR_URL =
  process.env.WORKFLOW_ORCHESTRATOR_URL || "http://workflow-orchestrator:8080";

async function main() {
  const instanceId = process.argv[2];
  const eventName = process.argv[3];
  const eventDataRaw = process.argv[4] || "{}";

  if (!instanceId || !eventName) {
    throw new Error(
      "Usage: pnpm run workflow:event <instanceId> <eventName> '{\\"approved\\":true}'"
    );
  }

  let eventData: unknown;
  try {
    eventData = JSON.parse(eventDataRaw);
  } catch {
    throw new Error("eventData must be valid JSON.");
  }

  const response = await fetch(
    \`\${ORCHESTRATOR_URL}/api/v2/workflows/\${encodeURIComponent(instanceId)}/events\`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ eventName, eventData }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(\`Failed to raise event (\${response.status}): \${body}\`);
  }

  console.log(await response.text());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
`;
}

function buildActionFiles(nodes: WorkflowNode[]): {
	files: Record<string, string>;
	manifest: ActionManifestEntry[];
} {
	const files: Record<string, string> = {};
	const manifest: ActionManifestEntry[] = [];

	const actionNodes = nodes.filter((node) => node.data.type === "action");

	for (const node of actionNodes) {
		const config = node.data.config || {};
		const actionType = String(config.actionType || "");

		if (!actionType) {
			continue;
		}

		const resolved = resolveActionCode({
			actionType,
			config,
			nodeId: node.id,
			nodeName: node.data.label || node.id,
		});

		const fileStem = sanitizePathSegment(
			`${node.data.label || actionType}-${node.id}`,
		);
		const filePath = `workflow/actions/${fileStem}.ts`;
		files[filePath] = resolved.content;

		manifest.push({
			nodeId: node.id,
			nodeName: node.data.label || node.id,
			actionType,
			source: resolved.source,
			file: filePath,
		});
	}

	return { files, manifest };
}

function buildDefaultTriggerData(nodes: WorkflowNode[]): string {
	const triggerNode = nodes.find((node) => node.data.type === "trigger");
	return extractNodeInput(triggerNode?.data.config || {});
}

export function buildDaprExportBundle(
	options: BuildDaprExportBundleOptions,
): DaprExportBundle {
	const workflowName = options.workflowName || "Workflow";
	const workflowSlug = sanitizePathSegment(workflowName);
	const definition = generateWorkflowDefinition(
		options.nodes,
		options.edges,
		options.workflowId,
		workflowName,
		{
			description: options.workflowDescription || undefined,
			author: options.author,
		},
	);

	const { files: actionFiles, manifest } = buildActionFiles(options.nodes);
	const defaultTriggerData = buildDefaultTriggerData(options.nodes);

	const files: Record<string, string> = {
		"workflow/definition.json": `${JSON.stringify(definition, null, 2)}\n`,
		"workflow/actions/manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
		"runner/execute.ts": generateRunnerExecute(defaultTriggerData),
		"runner/status.ts": generateRunnerStatus(),
		"runner/events.ts": generateRunnerEvents(),
		".env.example": generateEnvExample(),
		"README.md": generateReadme(workflowName, options.workflowId),
		"package.json": `${JSON.stringify(
			{
				name: `${workflowSlug}-dapr-export`,
				private: true,
				type: "module",
				scripts: {
					"run:workflow": "tsx runner/execute.ts",
					"workflow:status": "tsx runner/status.ts",
					"workflow:event": "tsx runner/events.ts",
				},
				devDependencies: {
					"@types/node": "^24.0.0",
					tsx: "^4.19.0",
					typescript: "^5.0.0",
				},
			},
			null,
			2,
		)}\n`,
		"tsconfig.json": `${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "ESNext",
					moduleResolution: "Bundler",
					strict: true,
					esModuleInterop: true,
					skipLibCheck: true,
					resolveJsonModule: true,
				},
			},
			null,
			2,
		)}\n`,
	};

	for (const [path, content] of Object.entries(actionFiles)) {
		files[path] = content;
	}

	return { files };
}
