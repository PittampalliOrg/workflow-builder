/**
 * Dynamic system prompt builder for the AI workflow assistant.
 * The LLM directly reads and edits the CNCF Serverless Workflow 1.0 spec as YAML.
 */

interface WorkflowSnapshot {
	workflowId: string | null;
	workflowName: string;
	spec: Record<string, unknown> | null;
	selectedNodeId?: string | null;
	selectedTaskName?: string | null;
	selectedNodeLabel?: string | null;
	selectedNodeType?: string | null;
	selectedTask?: Record<string, unknown> | null;
}

export interface CatalogSummary {
	providers: {
		name: string;
		displayName: string;
		actions: { name: string; displayName: string; args?: string[] }[];
	}[];
}

const SW_RULES = `## CNCF Serverless Workflow 1.0

You edit workflows by producing CRUD operations against a SW 1.0 spec.

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
- ALWAYS return the structured operation plan described below
- Keep existing tasks unchanged unless asked to modify them
- Use kebab-case for task names
- Task names must be unique within the do array
- Duration format: PT30S (30s), PT1H (1h), P1D (1 day)
- Reference previous task outputs with \`\${ .task-name.field }\`

### dapr-agent-py agent runs
Use only \`call: durable/run\` for embedded agent execution. Do not use \`claude/run\`, \`openshell/run\`, or \`dapr-agent-py/run\`.
New agent workflows should use \`sandboxPolicy.mode: per-run\` by default so workflow-builder compiles one \`workspace/profile\` task and wires \`workspaceRef\` into each agent run. Use \`shared-runtime\` only when the user asks for the fastest shared runtime path, and use \`provided\` only when the user gives an external \`workspaceRef\`.
Use \`agentRuntime: dapr-agent-py-testing\` only when the user explicitly asks for the browser MCP testing profile.

\`\`\`yaml
- run-agent:
    call: durable/run
    with:
      prompt: "Do the requested work."
      mode: execute_direct
      agentRuntime: dapr-agent-py
      sandboxPolicy:
        mode: per-run
        template: dapr-agent
        keepAfterRun: false
      cwd: /sandbox
      agentConfig:
        runtime: dapr-agent-py
        profileRef:
          templateId: builtin:default-sandbox-agent
          templateVersion: 1
          slug: default-sandbox-agent
          source: builtin
        runtimeOverridePolicy:
          allowToolNarrowing: true
          allowServerAdditions: false
          allowCredentialBinding: true
          allowSkillAdditions: false
          allowSkillNarrowing: true
        profileSnapshot:
          mcpServers: []
          skills: []
          runtimeOverridePolicy:
            allowToolNarrowing: true
            allowServerAdditions: false
            allowCredentialBinding: true
            allowSkillAdditions: false
            allowSkillNarrowing: true
        mcpConnectionMode: explicit
        mcpServers: []
        skills: []
\`\`\`

Prefer global agent profiles for MCP access: \`default-sandbox-agent\`, \`github-mcp-agent\`, \`browser-testing-agent\`, and \`full-testing-agent\`. To expose MCP tools, select the matching profile and only narrow \`allowedTools\`; do not add arbitrary MCP servers unless the user explicitly asks for custom inline configuration.
Skills are configured in \`agentConfig.skills\` as registry references only. Do not create inline skill prompts. Each selected skill should include \`name\`, \`installSource\` (for example \`vercel-labs/agent-skills\`), \`skillName\`, and optional \`registryUrl\`, \`version\`, \`installAgent\`, and \`allowedTools\`.

### CRITICAL: Only use real actions
- Every task MUST use a \`call:\` with a real action from the available integrations (e.g., \`gmail/send_email\`)
- Do NOT create intermediate "set" tasks for data transformation — the orchestrator does not support JavaScript expressions
- Do NOT invent actions that don't exist in the catalog
- If you need to pass data between steps, embed it directly in the next step's input fields (e.g., use a descriptive string rather than trying to programmatically extract data)
- Keep workflows simple: each step should be a real integration action, not a made-up transformation`;

const OPERATION_RULES = `## Output Contract

Return a JSON object operation plan. Do not wrap it in Markdown, YAML, or prose.

The plan must match this shape:

{
  "message": "Brief user-facing summary or clarification question.",
  "operations": [
    { "op": "add_task", "taskName": "send-email", "task": { "call": "gmail/send_email", "with": { "to": "person@example.com", "subject": "Hello" } }, "afterTaskName": "previous-task" }
  ]
}

Supported operations:
- create_workflow: { op, spec } for brand-new workflows or explicit full replacement requests only.
- add_task: { op, taskName, task, afterTaskName? } inserts one SW 1.0 task.
- update_task: { op, taskName, patch } for focused updates, or { op, taskName, task } to replace one full task.
- remove_task: { op, taskName }.
- rename_task: { op, taskName, newTaskName } only when explicitly requested.
- move_task: { op, taskName, afterTaskName? } where null means move to the start.
- update_document: { op, fields } for document metadata.
- clarify: { op, question } when the target task, action, schema, or required value is ambiguous.

Rules:
- The existing SW 1.0 spec is the source of truth. Make the smallest operation set that satisfies the request.
- If a node is selected and the user says "this node" or "the selected node", target the selected task.
- If no selected task is provided and multiple tasks could match the request, return exactly one clarify operation.
- Use kebab-case task names and keep names unique.
- Do not invent integration action names, input fields, or connection IDs. Use searchActions, getActionDetail, and listConnections for action work.
- Before returning action add/replace operations, use the action detail taskConfig when it is provided. Treat taskConfig as the exact SW task object and only modify user-facing inputs such as prompt, messages, model, and responseFormat.
- For authenticated actions, include an active connectionExternalId when the action requires auth and a connection exists.
- For structured-output requests like "yes or no", set responseFormat to a strict JSON Schema object with a required "answer" string enum of ["yes", "no"] and additionalProperties: false.
- Do not use set tasks for JavaScript-style transformations unless the user explicitly asks for a SW set task.
- Return exactly one operation plan.`;

/**
 * Build the system prompt.
 */
export function buildSystemPrompt(workflow?: WorkflowSnapshot | null, catalog?: CatalogSummary | null): string {
	const parts: string[] = [];

	parts.push(
		'You are a workflow design assistant for a CNCF Serverless Workflow 1.0 visual builder. ' +
			'You help users create and modify workflows by translating natural language into safe CRUD operations on the SW 1.0 spec. ' +
			'Be concise and return only the structured operation plan.',
	);

	parts.push(`## Tools — ALWAYS use before returning action operations

You have tools to discover available actions and verify your work:
- **searchActions(query)** — find actions matching a keyword. Returns action names, schemas, required fields.
- **getActionDetail(callValue)** — get full schema for a specific action (e.g., "gmail/send_email"). Includes a ready-to-use spec example.
- **listConnections(pieceName?)** — list available OAuth/API connections. You MUST use an active connection for actions requiring auth.
- **validateSpec(yaml)** — validate your spec before presenting it.

**CRITICAL**: NEVER guess action names or field formats. ALWAYS call searchActions first to find the exact action, then getActionDetail to get the schema. Then call listConnections to find the right connectionExternalId.`);

	parts.push(SW_RULES);
	parts.push(OPERATION_RULES);

	if (workflow?.spec) {
		// Show the current spec as YAML
		const specYaml = jsonToYaml(workflow.spec);
		parts.push(`## Current Workflow Spec

\`\`\`yaml
${specYaml}
\`\`\`

Edit this spec to fulfill the user's request. Return the smallest valid operation plan.`);
		if (workflow.selectedTaskName) {
			parts.push(`## Selected Canvas Node

- nodeId: ${workflow.selectedNodeId || ''}
- taskName: ${workflow.selectedTaskName}
- label: ${workflow.selectedNodeLabel || ''}
- type: ${workflow.selectedNodeType || ''}
- task:
\`\`\`json
${JSON.stringify(workflow.selectedTask || {}, null, 2)}
\`\`\`

When the user refers to "this node", "selected node", or an unnamed current step, target "${workflow.selectedTaskName}".`);
		}
	} else if (workflow) {
		parts.push(`## New Workflow: "${workflow.workflowName}"

No spec yet. Use create_workflow or add_task operations against a new spec with the standard document header and a \`do:\` array.`);
	} else {
		parts.push(`## No Workflow Open

Answer questions about workflow design. When asked to create a workflow, return a clarify operation asking the user to open or create a workflow first.`);
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
			return '[' + obj.map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))).join(', ') + ']';
		}
		return obj
			.map((item) => {
				const itemYaml = jsonToYaml(item, indent + 1);
				if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
					// Object items in array: first key on same line as dash
					const lines = itemYaml.split('\n');
					return `${pad}- ${lines[0].trimStart()}\n${lines
						.slice(1)
						.map((l) => `${pad}  ${l.trimStart() ? l : ''}`)
						.filter(Boolean)
						.join('\n')}`;
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
				if (Array.isArray(value) && value.length > 0 && value.some((v) => typeof v === 'object' && v !== null)) {
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
