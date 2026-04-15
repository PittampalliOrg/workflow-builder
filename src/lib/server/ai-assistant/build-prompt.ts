/**
 * Rich system prompt for the /build-workflow autonomous agent.
 * Uses progressive disclosure: compact index + detail lookup instructions.
 * Includes available connections, correct action naming, and iteration protocol.
 */

import yaml from 'js-yaml';

interface ActionForPrompt {
	name: string;
	displayName: string;
	description: string;
	providerId: string | null;
	providerLabel: string | null;
	pieceName: string;
	actionName: string;
	inputSchema: Record<string, unknown> | null;
	auth: { required: boolean; authType?: string } | null;
}

interface ConnectionForPrompt {
	pieceName: string;
	externalId: string;
	status: string;
}

/**
 * Strip the provider prefix from an action name.
 * e.g., "gmail-send_email" → "send_email"
 */
function cleanActionName(actionName: string, pieceName: string): string {
	if (actionName.startsWith(pieceName + '-')) {
		return actionName.slice(pieceName.length + 1);
	}
	return actionName;
}

/**
 * Build the system prompt for the autonomous workflow builder agent.
 */
export function buildBuildPrompt(
	currentSpec: Record<string, unknown> | null,
	actions: ActionForPrompt[],
	connections: ConnectionForPrompt[],
): string {
	const parts: string[] = [];

	parts.push(`You are an autonomous workflow builder agent. You generate CNCF Serverless Workflow 1.0 specs and I execute them automatically, returning results for you to iterate on.

## Iteration Protocol
1. Generate a COMPLETE spec in a \`\`\`yaml block
2. I validate, save, and execute it automatically
3. I return per-step results (success/error with details)
4. If any step fails, fix the spec and return a corrected version
5. We repeat until success or max attempts

## CRITICAL: Action Name Format
When using ActivePieces integrations, the call format is:
  call: PIECE_NAME/ACTION_NAME

Examples:
  call: gmail/send_email          ← CORRECT (piece=gmail, action=send_email)
  call: gmail/gmail-send_email    ← WRONG (duplicated prefix)
  call: gmail-send_email          ← WRONG (missing slash separator)
  call: discord/sendMessageWithBot ← CORRECT
  call: slack/send_channel_message ← CORRECT

The ACTION_NAME must NOT include the piece name as a prefix.`);

	parts.push(`## Agent Runtime
The exposed agents are dapr-agent-py and dapr-agent-py-testing. Use \`call: durable/run\` for agent work. Do not generate \`claude/run\`, \`openshell/run\`, or \`dapr-agent-py/run\`.
New agent workflows should use \`sandboxPolicy.mode: per-run\` by default so workflow-builder compiles one \`workspace/profile\` task and wires \`workspaceRef\` into agent runs. Use \`shared-runtime\` only when the user asks for the fastest shared runtime path, and use \`provided\` only when the user gives an external \`workspaceRef\`.
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

For MCP-enabled agent runs, prefer global profiles: \`github-mcp-agent\` for GitHub, \`browser-testing-agent\` for browser automation, and \`full-testing-agent\` for app demo/validation workflows. Only narrow \`allowedTools\`; avoid arbitrary inline MCP servers unless explicitly requested.
Skills live in \`agentConfig.skills\` as registry metadata references. Do not create inline skill prompts. Each skill should include \`name\`, \`installSource\`, \`skillName\`, and optional \`registryUrl\`, \`version\`, \`installAgent\`, and \`allowedTools\`.`);

	// SW 1.0 format with working example
	parts.push(`## SW 1.0 Spec Format

\`\`\`yaml
document:
  dsl: "1.0.0"
  namespace: workflow-builder
  name: my-workflow
  version: "1.0.0"
  title: My Workflow
do:
  - send-email:
      call: gmail/send_email
      with:
        connectionExternalId: conn_xxx
        body:
          input:
            receiver:
              - user@example.com
            subject: Hello
            body: Message content
            body_type: plain_text
          metadata:
            pieceName: gmail
            actionName: send_email
\`\`\`

### Key rules:
- \`connectionExternalId\` goes in the \`with\` block (NOT in \`body\`)
- \`body.input\` contains the action's input fields
- \`body.metadata\` must have \`pieceName\` and \`actionName\`
- Array fields like \`receiver\` must be YAML arrays
- \`body_type\` must be either "plain_text" or "html"

### Other task types:
- set: \`set: { key: value }\`
- switch: \`switch: [{ case: { when: "expr", then: "task" } }]\`
- wait: \`wait: PT30S\` (ISO 8601)
- for/try/fork/emit/listen/raise/run: standard SW 1.0`);

	// Available connections — IMPORTANT for execution
	if (connections.length > 0) {
		const connList = connections
			.map((c) => {
				const shortPiece = c.pieceName.replace('@activepieces/piece-', '').replace(/^@.*\//, '');
				return `- **${shortPiece}**: \`${c.externalId}\` (${c.status})`;
			})
			.join('\n');
		parts.push(`## Available Connections
IMPORTANT: For actions requiring auth, you MUST include \`connectionExternalId\` in the \`with\` block.

${connList}`);
	} else {
		parts.push(`## No Active Connections
WARNING: No OAuth/API connections are configured. Actions requiring auth will fail.`);
	}

	// Action catalog — only show actions with matching connections first, then others
	if (actions.length > 0) {
		const connectedPieces = new Set(
			connections.map((c) => c.pieceName.replace('@activepieces/piece-', '').replace(/^@.*\//, '')),
		);

		// Split into connected (can execute) vs unconnected
		const connected = actions.filter((a) => connectedPieces.has(a.pieceName));
		const unconnected = actions.filter((a) => !connectedPieces.has(a.pieceName));

		const actionLines: string[] = [];

		// Connected actions — full detail with schemas
		if (connected.length > 0) {
			actionLines.push('\n## Connected Integrations (ready to use)\n');
			const byProvider = groupByProvider(connected);
			for (const [provider, provActions] of byProvider) {
				actionLines.push(`### ${provider}`);
				for (const action of provActions.slice(0, 10)) {
					const clean = cleanActionName(action.actionName, action.pieceName);
					actionLines.push(`**${action.displayName}** — \`${action.pieceName}/${clean}\``);
					if (action.description) actionLines.push(`  ${action.description.slice(0, 100)}`);

					// Full input schema for connected actions
					if (action.inputSchema) {
						const props = (action.inputSchema as Record<string, unknown>).properties as
							| Record<string, Record<string, unknown>>
							| undefined;
						const required = (action.inputSchema as Record<string, unknown>).required as string[] | undefined;
						if (props) {
							const fields = Object.entries(props).map(([name, schema]) => {
								const req = required?.includes(name) ? ' **(required)**' : '';
								const def = schema.default !== undefined ? ` [default: ${JSON.stringify(schema.default)}]` : '';
								return `  - \`${name}\`: ${schema.type || 'any'}${req}${def} — ${schema.title || schema.description || name}`;
							});
							actionLines.push(fields.join('\n'));
						}
					}
					actionLines.push('');
				}
			}
		}

		// Unconnected actions — compact list (names only)
		if (unconnected.length > 0) {
			actionLines.push('\n## Other Available Integrations (need connection setup)\n');
			const byProvider = groupByProvider(unconnected);
			for (const [provider, provActions] of Array.from(byProvider).slice(0, 30)) {
				const names = provActions
					.slice(0, 5)
					.map((a) => cleanActionName(a.actionName, a.pieceName))
					.join(', ');
				const more = provActions.length > 5 ? ` (+${provActions.length - 5})` : '';
				actionLines.push(`- **${provider}**: ${names}${more}`);
			}
		}

		parts.push(actionLines.join('\n'));
	}

	// Current workflow state
	if (currentSpec) {
		try {
			const specYaml = yaml.dump(currentSpec, { lineWidth: 120, noRefs: true });
			parts.push(`## Current Workflow Spec\n\`\`\`yaml\n${specYaml}\`\`\``);
		} catch {
			parts.push(`## Current Workflow: New (start from scratch)`);
		}
	} else {
		parts.push(`## Current Workflow: New (start from scratch)`);
	}

	// Common errors and fixes
	parts.push(`## Common Errors & Fixes
- **"Action X not found in piece Y"** → The action name has wrong format. Use \`piece/action\` not \`piece/piece-action\`.
- **"Missing credentials"** → Add \`connectionExternalId: conn_xxx\` to the \`with\` block.
- **"Buffer.from received undefined"** → A required field (like \`subject\`) is missing from \`body.input\`.
- **"receiver must be array"** → Use YAML array format: \`receiver: ["email@example.com"]\`
- **"body_type is required"** → Add \`body_type: plain_text\` to \`body.input\`.`);

	return parts.join('\n\n');
}

function groupByProvider(actions: ActionForPrompt[]): Map<string, ActionForPrompt[]> {
	const map = new Map<string, ActionForPrompt[]>();
	for (const action of actions) {
		const prov = action.providerLabel || action.providerId || 'Other';
		if (!map.has(prov)) map.set(prov, []);
		map.get(prov)!.push(action);
	}
	return new Map(Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length));
}

/**
 * Build a feedback prompt for the LLM after a failed execution.
 */
export function buildFixPrompt(
	attempt: number,
	maxAttempts: number,
	stepResults: Array<{
		name: string;
		status: string;
		error?: string | null;
		input?: unknown;
		output?: unknown;
		durationMs?: number;
	}>,
	action?: ActionForPrompt,
): string {
	const lines: string[] = [`## Execution Failed (Attempt ${attempt}/${maxAttempts})\n`];

	lines.push('### Step Results:');
	for (const step of stepResults) {
		const icon = step.status === 'success' ? '✅' : step.status === 'error' ? '❌' : '⏳';
		const dur = step.durationMs ? ` (${step.durationMs}ms)` : '';
		lines.push(`${icon} **${step.name}**: ${step.status}${dur}`);
		if (step.error) lines.push(`   Error: \`${step.error}\``);
		if (step.input) lines.push(`   Input: \`${JSON.stringify(step.input).slice(0, 200)}\``);
		if (step.output && step.status === 'success')
			lines.push(`   Output: \`${JSON.stringify(step.output).slice(0, 200)}\``);
	}

	if (action?.inputSchema) {
		const props = (action.inputSchema as Record<string, unknown>).properties as
			| Record<string, Record<string, unknown>>
			| undefined;
		const required = (action.inputSchema as Record<string, unknown>).required as string[] | undefined;
		if (props) {
			lines.push('\n### Required Fields:');
			for (const [name, schema] of Object.entries(props)) {
				const req = required?.includes(name) ? ' **(required)**' : '';
				lines.push(`- \`${name}\`: ${schema.type || 'any'}${req} — ${schema.title || ''}`);
			}
		}
	}

	lines.push(
		'\n**Remember**: action name format is `piece/action` (e.g., `gmail/send_email`), NOT `piece/piece-action`.',
	);
	lines.push('Fix the spec and return the COMPLETE corrected version in a ```yaml block.');

	return lines.join('\n');
}
