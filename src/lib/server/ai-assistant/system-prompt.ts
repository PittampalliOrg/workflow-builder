/**
 * Dynamic system prompt builder for the AI workflow assistant.
 * The LLM directly reads and edits the CNCF Serverless Workflow 1.0 spec as YAML.
 */

interface WorkflowSnapshot {
	workflowId: string | null;
	workflowName: string;
	spec: Record<string, unknown> | null;
}

export interface CatalogSummary {
	providers: { name: string; displayName: string; actions: { name: string; displayName: string; args?: string[] }[] }[];
}

const SW_RULES = `## CNCF Serverless Workflow 1.0

You edit workflows by returning a complete SW 1.0 spec in a \`\`\`yaml block.

### Spec structure
\`\`\`yaml
document:
  dsl: "1.0.0"
  namespace: workflow-builder
  name: workflow-name
  version: "1.0.0"
  title: Human Readable Name
do:
  - task-name:
      call: http
      with:
        method: GET
        endpoint:
          uri: https://api.example.com
  - another-task:
      set:
        result: "\${ .task-name }"
\`\`\`

### Task types
- **call**: Invoke a function/API — \`call: http\` or \`call: provider/action\`
- **agent**: Run dapr-agent-py — \`call: durable/run\`
- **set**: Set variables — \`set: { key: value }\`
- **switch**: Conditional — \`switch: [{ case: { when: "expr", then: "task" } }]\`
- **wait**: Delay — \`wait: PT30S\` (ISO 8601 duration)
- **emit**: Publish event — \`emit: { event: { with: { type: "..." } } }\`
- **listen**: Wait for event — \`listen: { to: { one: { with: { type: "..." } } } }\`
- **for**: Loop — \`for: { each: item, in: ".items" }\` with nested \`do:\`
- **try**: Error handling — \`try: [...]\` with \`catch: { do: [...] }\`
- **fork**: Parallel — \`fork: { branches: [...] }\`
- **raise**: Error — \`raise: { error: { type: "...", title: "..." } }\`
- **run**: Execute — \`run: { shell: { command: "..." } }\`

### Integration actions (ActivePieces)
For provider integrations (Gmail, Slack, Discord, etc.), use this format:
\`\`\`yaml
- send-email:
    call: gmail/send_email
    with:
      body:
        input:
          receiver: ["user@example.com"]
          subject: Hello
          body: Message content
          body_type: plain_text
          from: sender@gmail.com
        metadata:
          pieceName: gmail
          actionName: send_email
\`\`\`

### Rules
- ALWAYS return the COMPLETE spec in a \`\`\`yaml block
- Keep existing tasks unchanged unless asked to modify them
- Use kebab-case for task names
- Task names must be unique within the do array
- Duration format: PT30S (30s), PT1H (1h), P1D (1 day)
- Reference previous task outputs with \`\${ .task-name.field }\`

### dapr-agent-py agent runs
Use only \`call: durable/run\` for embedded agent execution. Do not use \`claude/run\`, \`openshell/run\`, or \`dapr-agent-py/run\`.

\`\`\`yaml
- run-agent:
    call: durable/run
    with:
      prompt: "Do the requested work."
      mode: execute_direct
      agentRuntime: dapr-agent-py
      workspaceRef: "\${ .workspaceProfile.workspaceRef }"
      sandboxName: "\${ .workspaceProfile.sandboxName }"
      cwd: /sandbox
      agentConfig:
        runtime: dapr-agent-py
        mcpConnectionMode: explicit
        mcpServers: []
\`\`\`

To expose MCP tools to the agent, add entries under \`with.agentConfig.mcpServers\`. Each server uses \`server_name\`, \`displayName\`, \`transport\`, and either \`url\` for HTTP/SSE/WebSocket transports or \`command\`/\`args\` for stdio. \`allowedTools\` is optional; omit it or use an empty array to expose every tool from that server.

### CRITICAL: Only use real actions
- Every task MUST use a \`call:\` with a real action from the available integrations (e.g., \`gmail/send_email\`)
- Do NOT create intermediate "set" tasks for data transformation — the orchestrator does not support JavaScript expressions
- Do NOT invent actions that don't exist in the catalog
- If you need to pass data between steps, embed it directly in the next step's input fields (e.g., use a descriptive string rather than trying to programmatically extract data)
- Keep workflows simple: each step should be a real integration action, not a made-up transformation`;

/**
 * Build the system prompt.
 */
export function buildSystemPrompt(
	workflow?: WorkflowSnapshot | null,
	catalog?: CatalogSummary | null,
): string {
	const parts: string[] = [];

	parts.push(
		'You are a workflow design assistant for a CNCF Serverless Workflow 1.0 visual builder. ' +
		'You help users create and modify workflows by editing the SW 1.0 spec directly. ' +
		'Be concise — return the updated spec with a brief explanation.',
	);

	parts.push(`## Tools — ALWAYS use before generating a spec

You have tools to discover available actions and verify your work:
- **searchActions(query)** — find actions matching a keyword. Returns action names, schemas, required fields.
- **getActionDetail(callValue)** — get full schema for a specific action (e.g., "gmail/send_email"). Includes a ready-to-use spec example.
- **listConnections(pieceName?)** — list available OAuth/API connections. You MUST use an active connection for actions requiring auth.
- **validateSpec(yaml)** — validate your spec before presenting it.

**CRITICAL**: NEVER guess action names or field formats. ALWAYS call searchActions first to find the exact action, then getActionDetail to get the schema. Then call listConnections to find the right connectionExternalId.`);

	parts.push(SW_RULES);

	if (workflow?.spec) {
		// Show the current spec as YAML
		const specYaml = jsonToYaml(workflow.spec);
		parts.push(`## Current Workflow Spec

\`\`\`yaml
${specYaml}
\`\`\`

Edit this spec to fulfill the user's request. Return the COMPLETE updated spec in a \`\`\`yaml block.`);
	} else if (workflow) {
		parts.push(`## New Workflow: "${workflow.workflowName}"

No spec yet. Create one from scratch with the standard document header and a \`do:\` array.`);
	} else {
		parts.push(`## No Workflow Open

Answer questions about workflow design. When asked to create a workflow, tell the user to open one first.`);
	}

	// Catalog is no longer dumped here — LLM discovers actions via tools (searchActions, getActionDetail)

	return parts.join('\n\n');
}

/**
 * Simple JSON-to-YAML conversion for the spec.
 * Produces readable YAML without requiring js-yaml on the server.
 */
function jsonToYaml(obj: unknown, indent: number = 0): string {
	const pad = '  '.repeat(indent);

	if (obj === null || obj === undefined) return 'null';
	if (typeof obj === 'string') {
		if (obj.includes('\n') || obj.includes('"') || obj.includes("'") || obj.startsWith('$')) {
			return JSON.stringify(obj);
		}
		return /^[a-zA-Z0-9_.@\/-]+$/.test(obj) ? obj : JSON.stringify(obj);
	}
	if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);

	if (Array.isArray(obj)) {
		if (obj.length === 0) return '[]';
		// Check if it's an array of simple values
		if (obj.every((v) => typeof v !== 'object' || v === null)) {
			return '[' + obj.map((v) => typeof v === 'string' ? JSON.stringify(v) : String(v)).join(', ') + ']';
		}
		return obj
			.map((item) => {
				const itemYaml = jsonToYaml(item, indent + 1);
				if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
					// Object items in array: first key on same line as dash
					const lines = itemYaml.split('\n');
					return `${pad}- ${lines[0].trimStart()}\n${lines.slice(1).map(l => `${pad}  ${l.trimStart() ? l : ''}`).filter(Boolean).join('\n')}`;
				}
				return `${pad}- ${itemYaml}`;
			})
			.join('\n');
	}

	if (typeof obj === 'object') {
		const entries = Object.entries(obj as Record<string, unknown>);
		if (entries.length === 0) return '{}';
		return entries
			.map(([key, value]) => {
				if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
					return `${pad}${key}:\n${jsonToYaml(value, indent + 1)}`;
				}
				if (Array.isArray(value) && value.length > 0 && value.some(v => typeof v === 'object' && v !== null)) {
					return `${pad}${key}:\n${jsonToYaml(value, indent + 1)}`;
				}
				return `${pad}${key}: ${jsonToYaml(value, indent)}`;
			})
			.join('\n');
	}

	return String(obj);
}

// Re-export catalog summary builder (unchanged)
export { buildCatalogSummary } from './system-prompt-catalog';
