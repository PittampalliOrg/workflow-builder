import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { flattenConfigFields } from "@/lib/actions/utils";
import { createWorkflowOperationStreamFromSpec } from "@/lib/ai/workflow-spec-generation";
import { resolveCatalogModelKey } from "@/lib/ai/openai-model-selection";
import { loadInstalledWorkflowSpecCatalog } from "@/lib/workflow-spec/catalog-server";
import { buildRelevantActionListPrompt } from "@/lib/ai/action-list-prompt";
import { getSecretValueAsync } from "@/lib/dapr/config-provider";

export type Operation = {
	op:
		| "setName"
		| "setDescription"
		| "addNode"
		| "addEdge"
		| "removeNode"
		| "removeEdge"
		| "updateNode";
	name?: string;
	description?: string;
	node?: unknown;
	edge?: unknown;
	nodeId?: string;
	edgeId?: string;
	updates?: {
		position?: { x: number; y: number };
		data?: unknown;
	};
};

type ExistingWorkflow = {
	nodes?: Array<{ id: string; data?: { label?: string } }>;
	edges?: Array<{ id: string; source: string; target: string }>;
	name?: string;
};

export type WorkflowMessageContext = {
	role: "user" | "assistant" | "system";
	content: string;
};

type CreateWorkflowOperationStreamInput = {
	prompt: string;
	existingWorkflow?: ExistingWorkflow;
	messageHistory?: WorkflowMessageContext[];
};

type CreateWorkflowOperationStreamOptions = {
	onOperation?: (operation: Operation) => void;
};

function encodeMessage(encoder: TextEncoder, message: object): Uint8Array {
	return encoder.encode(`${JSON.stringify(message)}\n`);
}

function shouldSkipLine(line: string): boolean {
	const trimmed = line.trim();
	return !trimmed || trimmed.startsWith("```");
}

function parseOperationLine(line: string): Operation | null {
	const trimmed = line.trim();

	if (shouldSkipLine(line)) {
		return null;
	}

	try {
		return JSON.parse(trimmed) as Operation;
	} catch {
		console.warn("[AI] Skipping invalid JSON line:", trimmed.substring(0, 80));
		return null;
	}
}

function processBufferLines(
	buffer: string,
	controller: ReadableStreamDefaultController<Uint8Array>,
	encoder: TextEncoder,
	operationCount: number,
	onOperation?: (operation: Operation) => void,
): { remainingBuffer: string; newOperationCount: number } {
	const lines = buffer.split("\n");
	const remainingBuffer = lines.pop() || "";
	let newOperationCount = operationCount;

	for (const line of lines) {
		const operation = parseOperationLine(line);
		if (!operation) {
			continue;
		}

		newOperationCount += 1;
		onOperation?.(operation);
		controller.enqueue(
			encodeMessage(encoder, {
				type: "operation",
				operation,
			}),
		);
	}

	return { remainingBuffer, newOperationCount };
}

async function processOperationStream(
	textStream: AsyncIterable<string>,
	controller: ReadableStreamDefaultController<Uint8Array>,
	encoder: TextEncoder,
	onOperation?: (operation: Operation) => void,
): Promise<void> {
	let buffer = "";
	let operationCount = 0;

	for await (const chunk of textStream) {
		buffer += chunk;
		const result = processBufferLines(
			buffer,
			controller,
			encoder,
			operationCount,
			onOperation,
		);
		buffer = result.remainingBuffer;
		operationCount = result.newOperationCount;
	}

	const finalOperation = parseOperationLine(buffer);
	if (finalOperation) {
		operationCount += 1;
		onOperation?.(finalOperation);
		controller.enqueue(
			encodeMessage(encoder, {
				type: "operation",
				operation: finalOperation,
			}),
		);
	}

	console.log(`[AI] Stream complete. Operations: ${operationCount}`);
	controller.enqueue(encodeMessage(encoder, { type: "complete" }));
}

async function generateAIPieceActionPrompts(): Promise<string> {
	const catalog = await loadInstalledWorkflowSpecCatalog();
	const actions = Array.from(catalog.actionsById.values()).sort((a, b) =>
		a.id.localeCompare(b.id),
	);

	const lines: string[] = [];

	for (const action of actions) {
		const fullId = action.id;
		const exampleConfig: Record<string, string | number> = {
			actionType: fullId,
		};

		for (const field of flattenConfigFields(action.configFields)) {
			if (field.showWhen) {
				continue;
			}
			if (field.example !== undefined) {
				exampleConfig[field.key] = field.example;
			} else if (field.defaultValue !== undefined) {
				exampleConfig[field.key] = field.defaultValue;
			} else if (field.type === "number") {
				exampleConfig[field.key] = 10;
			} else if (field.type === "select" && field.options?.[0]) {
				exampleConfig[field.key] = field.options[0].value;
			} else if (field.type === "dynamic-select") {
				exampleConfig[field.key] = "";
			} else if (field.type === "dynamic-multi-select") {
				exampleConfig[field.key] = "[]";
			} else {
				exampleConfig[field.key] = `Your ${field.label.toLowerCase()}`;
			}
		}

		lines.push(
			`- ${action.label} (${fullId}): ${JSON.stringify(exampleConfig)}`,
		);
	}

	return lines.join("\n");
}

function getSystemPrompt(pluginActionPrompts: string): string {
	return `You are a workflow automation expert. Generate a workflow based on the user's description.

CRITICAL: Output your workflow as INDIVIDUAL OPERATIONS, one per line in JSONL format.
Each line must be a complete, separate JSON object.

Operations you can output:
1. {"op": "setName", "name": "Workflow Name"}
2. {"op": "setDescription", "description": "Brief description"}
3. {"op": "addNode", "node": {COMPLETE_NODE_OBJECT}}
4. {"op": "addEdge", "edge": {COMPLETE_EDGE_OBJECT}}
5. {"op": "removeNode", "nodeId": "node-id-to-remove"}
6. {"op": "removeEdge", "edgeId": "edge-id-to-remove"}
7. {"op": "updateNode", "nodeId": "node-id", "updates": {"position": {"x": 100, "y": 200}}}

IMPORTANT RULES:
- Every workflow must have EXACTLY ONE trigger node
- Output ONE operation per line
- Each line must be complete, valid JSON
- Start with setName and setDescription
- Then add nodes one at a time
- Finally add edges one at a time to CONNECT ALL NODES
- CRITICAL: Every node (except the last) MUST be connected to at least one other node
- To update node positions or properties, use updateNode operation
- NEVER output explanatory text - ONLY JSON operations
- Do NOT wrap in markdown code blocks
- Do NOT add explanatory text

Node structure:
{
  "id": "unique-id",
  "type": "trigger" | "action" | "loop-until" | "if-else" | "set-state" | "transform" | "note",
  "position": {"x": number, "y": number},
  "data": {
    "label": "Node Label",
    "description": "Node description",
    "type": "trigger" | "action" | "loop-until" | "if-else" | "set-state" | "transform" | "note",
    "config": {...},
    "status": "idle"
  }
}

NODE POSITIONING RULES:
- Nodes are squares, so use equal spacing in both directions
- Horizontal spacing between sequential nodes: 250px (e.g., x: 100, then x: 350, then x: 600)
- Vertical spacing for parallel branches: 250px (e.g., y: 75, y: 325, y: 575)
- Start trigger node at position {"x": 100, "y": 200}
- For linear workflows: increment x by 250 for each subsequent node, keep y constant
- For branching workflows: keep x the same for parallel branches, space y by 250px per branch
- When adding nodes to existing workflows, position new nodes 250px away from existing nodes

Trigger types:
- Manual: {"triggerType": "Manual"}
- Webhook: {"triggerType": "Webhook", "webhookPath": "/webhooks/name", ...}
- Schedule: {"triggerType": "Schedule", "scheduleCron": "0 9 * * *", ...}

Loop Until node type:
- Node type is "loop-until" (NOT an actionType)
- Used to repeat a section of the workflow without creating graph cycles
- Config example:
  {
    "loopStartNodeId": "node-id-to-jump-back-to",
    "maxIterations": 10,
    "delaySeconds": 0,
    "onMaxIterations": "fail" or "continue",
    "operator": "EXISTS" | "TEXT_CONTAINS" | "TEXT_EXACTLY_MATCHES" | "NUMBER_IS_GREATER_THAN" | "NUMBER_IS_LESS_THAN" | "NUMBER_IS_EQUAL_TO" | "BOOLEAN_IS_TRUE" | "BOOLEAN_IS_FALSE",
    "left": "{{@nodeId:Label.field}}",
    "right": "expected value (optional)"
  }

If / Else node type:
- Node type is "if-else" (NOT an actionType)
- Creates a true/false branch based on an AP-style operator comparison
- Config example:
  {
    "operator": "EXISTS" | "DOES_NOT_EXIST" | "TEXT_CONTAINS" | "TEXT_EXACTLY_MATCHES" | "NUMBER_IS_GREATER_THAN" | "NUMBER_IS_LESS_THAN" | "NUMBER_IS_EQUAL_TO" | "BOOLEAN_IS_TRUE" | "BOOLEAN_IS_FALSE",
    "left": "{{@nodeId:Label.field}}",
    "right": "expected value (optional)"
  }
- When connecting edges out of an if-else node:
  - Use "sourceHandle": "true" for the true branch
  - Use "sourceHandle": "false" for the false branch

Set State node type:
- Node type is "set-state"
- Sets a workflow-scoped variable accessible via {{state.key}} later
- Config examples:
  { "key": "customerId", "value": "{{@nodeId:Label.id}}" }
  {
    "entries": [
      { "key": "customerId", "value": "{{@nodeId:Label.id}}" },
      { "key": "customerEmail", "value": "{{@nodeId:Label.email}}" }
    ]
  }

Transform node type:
- Node type is "transform"
- Builds structured output from a JSON template (must be valid JSON after templates resolve)
- Config example:
  { "templateJson": "{\\n  \\"id\\": \\"{{@nodeId:Label.id}}\\"\\n}" }

Note node type:
- Node type is "note"
- Notes do not execute and should NOT be used for control flow
- Config example:
  { "text": "Explain why this workflow exists" }

System action types (built-in):
- Database Query: {"actionType": "system/database-query", "dbQuery": "SELECT * FROM table"}
- HTTP Request: {"actionType": "system/http-request", "httpMethod": "POST", "endpoint": "https://api.example.com", "httpHeaders": "{}", "httpBody": "{}"}

Plugin action types (from integrations):
${pluginActionPrompts}

CRITICAL ABOUT IF/ELSE NODES:
- Use exactly one if-else node per branching decision
- Always connect both branches when possible (true and false)
- Use edge.sourceHandle = "true" or "false" (no other values)

Edge structure:
{
  "id": "edge-id",
  "source": "source-node-id",
  "target": "target-node-id",
  "sourceHandle": "true" | "false" (optional),
  "targetHandle": string (optional),
  "type": "default"
}

WORKFLOW FLOW:
- Trigger connects to first action
- Actions connect in sequence or to multiple branches
- ALWAYS create edges to connect the workflow flow
- For linear workflows: trigger -> action1 -> action2 -> etc
- For branching (conditions): one source can connect to multiple targets

REMEMBER: After adding all nodes, you MUST add edges to connect them! Every node should be reachable from the trigger.`;
}

function formatMessageHistory(messages: WorkflowMessageContext[]): string {
	if (messages.length === 0) {
		return "";
	}

	const lines = messages
		.slice(-20)
		.map(
			(message) => `${message.role.toUpperCase()}: ${message.content.trim()}`,
		);

	return `Previous conversation context (most recent last):
${lines.join("\n")}

`;
}

function buildUserPrompt({
	prompt,
	existingWorkflow,
	messageHistory = [],
}: CreateWorkflowOperationStreamInput): string {
	const historyBlock = formatMessageHistory(messageHistory);
	const contextualPrompt = `${historyBlock}Current request: ${prompt}`;

	if (!existingWorkflow) {
		return contextualPrompt;
	}

	const nodesList = (existingWorkflow.nodes || [])
		.map((node) => `- ${node.id} (${node.data?.label || "Unlabeled"})`)
		.join("\n");

	const edgesList = (existingWorkflow.edges || [])
		.map((edge) => `- ${edge.id}: ${edge.source} -> ${edge.target}`)
		.join("\n");

	return `I have an existing workflow. I want you to make ONLY the changes I request.

Current workflow nodes:
${nodesList}

Current workflow edges:
${edgesList}

Full workflow data (DO NOT recreate these, they already exist):
${JSON.stringify(existingWorkflow, null, 2)}

${contextualPrompt}

IMPORTANT: Output ONLY the operations needed to make the requested changes.
- If adding new nodes: output "addNode" operations for NEW nodes only, then IMMEDIATELY output "addEdge" operations to connect them to the workflow
- If adding new edges: output "addEdge" operations for NEW edges only
- If removing nodes: output "removeNode" operations with the nodeId to remove
- If removing edges: output "removeEdge" operations with the edgeId to remove
- If changing name/description: output "setName"/"setDescription" only if changed
- CRITICAL: New nodes MUST be connected with edges - always add edges after adding nodes
- When connecting nodes, look at the node IDs in the current workflow list above
- DO NOT output operations for existing nodes/edges unless specifically modifying them
- Keep the existing workflow structure and only add/modify/remove what was requested
- POSITIONING: When adding new nodes, look at existing node positions and place new nodes 250px away (horizontally or vertically) from existing nodes. Never overlap nodes.`;
}

async function getAiModel() {
	// Prefer Anthropic if configured (Azure Key Vault secret mapping exists).
	const anthropicKey = await getSecretValueAsync("ANTHROPIC_API_KEY");
	if (anthropicKey) {
		const provider = createAnthropic({ apiKey: anthropicKey });
		const configuredModelId =
			process.env.ANTHROPIC_MODEL ||
			(process.env.AI_MODEL?.startsWith("claude-") ? process.env.AI_MODEL : "");
		const modelKey = await resolveCatalogModelKey({
			providerId: "anthropic",
			configuredModelId: configuredModelId || undefined,
			fallbackModelKey: "claude-opus-4-6",
		});
		return provider.chat(modelKey);
	}

	const gatewayBaseURL = process.env.AI_GATEWAY_BASE_URL;

	const openaiKey = await getSecretValueAsync("OPENAI_API_KEY");
	const gatewayKey = await getSecretValueAsync("AI_GATEWAY_API_KEY");

	// If a gateway base URL is provided, prefer the gateway key. Otherwise, prefer
	// a plain OpenAI key (common in Kubernetes deployments).
	const apiKey = gatewayBaseURL
		? gatewayKey || openaiKey
		: openaiKey || gatewayKey;
	if (!apiKey) {
		throw new Error(
			"Missing AI API key (set ANTHROPIC_API_KEY or OPENAI_API_KEY or AI_GATEWAY_API_KEY).",
		);
	}

	const configuredModelId =
		process.env.OPENAI_MODEL ||
		(!process.env.AI_MODEL?.startsWith("claude-") ? process.env.AI_MODEL : "");

	const modelKey = await resolveCatalogModelKey({
		providerId: "openai",
		configuredModelId: configuredModelId || undefined,
		fallbackModelKey: "gpt-4o",
	});
	const modelId = gatewayBaseURL ? `openai/${modelKey}` : modelKey;

	const provider = createOpenAI({
		apiKey,
		...(gatewayBaseURL ? { baseURL: gatewayBaseURL } : {}),
	});

	return provider.chat(modelId);
}

export async function createWorkflowOperationStream(
	input: CreateWorkflowOperationStreamInput,
	options: CreateWorkflowOperationStreamOptions = {},
): Promise<ReadableStream<Uint8Array>> {
	const existingNodes = input.existingWorkflow?.nodes || [];
	const existingEdges = input.existingWorkflow?.edges || [];
	const nonAddNodes = existingNodes.filter(
		(n) => (n as { type?: string } | null | undefined)?.type !== "add",
	);
	const nonTriggerNodes = nonAddNodes.filter(
		(n) =>
			(n as { data?: { type?: string } } | null | undefined)?.data?.type !==
			"trigger",
	);

	// Treat "trigger only + no edges" as a blank workflow so we use WorkflowSpec
	// structured output + deterministic compile/lint/repair for creation.
	const isBlank =
		existingEdges.length === 0 &&
		nonAddNodes.length === 1 &&
		nonTriggerNodes.length === 0;

	const hasExisting = nonTriggerNodes.length > 0 || existingEdges.length > 0;
	if (!hasExisting || isBlank) {
		// New workflow creation: use structured output (WorkflowSpec) + deterministic compiler.
		const catalog = await loadInstalledWorkflowSpecCatalog();
		const actionListPrompt = buildRelevantActionListPrompt({
			catalog,
			prompt: input.prompt,
			limit: 80,
		});
		return createWorkflowOperationStreamFromSpec({
			prompt: input.prompt,
			actionListPrompt,
		});
	}

	const pieceActionPrompts = await generateAIPieceActionPrompts();
	const userPrompt = buildUserPrompt(input);

	const result = streamText({
		model: await getAiModel(),
		system: getSystemPrompt(pieceActionPrompts),
		prompt: userPrompt,
	});

	const encoder = new TextEncoder();
	return new ReadableStream({
		async start(controller) {
			try {
				await processOperationStream(
					result.textStream,
					controller,
					encoder,
					options.onOperation,
				);
			} catch (error) {
				controller.enqueue(
					encodeMessage(encoder, {
						type: "error",
						error:
							error instanceof Error
								? error.message
								: "Failed to generate workflow",
					}),
				);
			} finally {
				controller.close();
			}
		},
	});
}
