import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

// ---------------------------------------------------------------------------
// POST /api/workflows/[workflowId]/author-session
//
// Start (or return) an interactive GLM-5.2 authoring session bound to a
// dynamic-script workflow. The session runs the platform's dapr-agent-py
// runtime with the workflow-authoring MCP tools (get_workflow_script_spec,
// validate_workflow_script, save_workflow_script, run_workflow_script), so the
// user can describe a workflow in natural language and the agent authors +
// saves it — the save (by workflow name, same project) updates THIS row, and
// the canvas refetches the new script structure.
//
// A per-project author agent (slug `workflow-author-dynamic`) is created once
// and reused. Returns { sessionId, agentId }.
// ---------------------------------------------------------------------------

const WORKFLOW_MCP_URL =
	process.env.WORKFLOW_MCP_SERVER_URL ??
	'http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp';

/** Selectable author runtimes. The default is the platform-metered GLM 5.2
 * dapr-agent-py loop (near-instant session start); the CLI runtimes bring the
 * user's own subscription auth + a stronger coding model at the cost of a
 * per-session pod cold start. All four get the SAME system prompt and the
 * SAME workflow-authoring MCP tools — the capability compiler translates
 * `mcpServers` (streamable_http) for every CLI target. */
const AUTHOR_RUNTIMES = {
	'dapr-agent-py': {
		slug: 'workflow-author-dynamic',
		name: 'Workflow Author (GLM 5.2)',
		description:
			'Authors dynamic-script workflows from natural language, embedded in the canvas AI panel.'
	},
	'claude-code-cli': {
		slug: 'workflow-author-claude',
		name: 'Workflow Author (Claude Code)',
		description:
			'Claude Code CLI authoring dynamic-script workflows via the workflow-authoring MCP tools.'
	},
	'codex-cli': {
		slug: 'workflow-author-codex',
		name: 'Workflow Author (Codex)',
		description:
			'Codex CLI authoring dynamic-script workflows via the workflow-authoring MCP tools.'
	},
	'agy-cli': {
		slug: 'workflow-author-agy',
		name: 'Workflow Author (Agy)',
		description:
			'Antigravity CLI authoring dynamic-script workflows via the workflow-authoring MCP tools.'
	}
} as const;
type AuthorRuntime = keyof typeof AUTHOR_RUNTIMES;

function isAuthorRuntime(value: unknown): value is AuthorRuntime {
	return typeof value === 'string' && value in AUTHOR_RUNTIMES;
}

function authorSystemPrompt(workflowName: string): string {
	return [
		'You are the workflow authoring assistant embedded in the workflow-builder canvas.',
		`You are editing the DYNAMIC-SCRIPT workflow named "${workflowName}".`,
		'',
		'The user describes what they want in natural language. You author a workflow',
		'script in the dynamic-script dialect (your Workflow tool + get_workflow_script_spec',
		'describe it: meta block, agent()/parallel()/pipeline()/phase()/log()/workflow(),',
		'args, budget). EVERY hook returns a Promise — always await it.',
		'',
		'Your loop:',
		'1. Read get_workflow_script_spec if unsure of the dialect.',
		'2. Author the script, then validate_workflow_script; fix any error it reports.',
		`3. Save with save_workflow_script using name "${workflowName}" (so it updates THIS`,
		'   workflow, not a new one). The canvas will render the new structure.',
		'4. Only run it (your Workflow tool) if the user asks to try it; then digest the result.',
		'',
		'Keep scripts small and well-phased. After saving, briefly tell the user what the',
		'workflow does and which phases/agents it has. Do not paste the whole script unless asked.'
	].join('\n');
}

const AUTHOR_MCP_SERVERS = [
	{
		url: WORKFLOW_MCP_URL,
		name: 'workflow-authoring',
		transport: 'streamable_http'
	}
];

function authorConfig(workflowName: string, runtime: AuthorRuntime) {
	if (runtime === 'dapr-agent-py') {
		return {
			model: 'zai/glm-5.2',
			modelSpec: 'zai/glm-5.2',
			runtime,
			maxTurns: 60,
			timeoutMinutes: 60,
			tools: [],
			skills: [],
			systemPrompt: authorSystemPrompt(workflowName),
			mcpServers: AUTHOR_MCP_SERVERS
		};
	}
	// CLI runtimes: NO model/modelSpec (native subscription auth — API keys must
	// never reach the pod) and the role prompt rides `instructions` (the agent's
	// resolved config is the instruction source for CLI agents).
	return {
		runtime,
		maxTurns: 40,
		timeoutMinutes: 45,
		tools: [],
		skills: [],
		instructions: authorSystemPrompt(workflowName),
		mcpServers: AUTHOR_MCP_SERVERS
	};
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const userId = locals.session.userId;
	const projectId = locals.session.projectId ?? null;
	if (!projectId) return error(400, 'No active project');

	const body = (await request.json().catch(() => ({}))) as { runtime?: unknown };
	const runtime: AuthorRuntime = isAuthorRuntime(body.runtime) ? body.runtime : 'dapr-agent-py';
	const author = AUTHOR_RUNTIMES[runtime];

	const app = getApplicationAdapters();
	const workflow = (await app.workflowData.getWorkflowByRef({
		workflowId: params.workflowId,
		lookup: 'id'
	})) as { id: string; name: string; engineType?: string | null } | null;
	if (!workflow) return error(404, 'Workflow not found');

	// Ensure the per-project author agent for the CHOSEN runtime exists
	// (idempotent by project+slug; one agent row per runtime).
	let agentId: string | null = null;
	try {
		const existing = (
			await app.agentCatalog.listAgents({
				query: { projectId, q: author.slug },
				currentProjectId: projectId
			})
		).find((agent) => agent.slug === author.slug);
		agentId = existing?.id ?? null;
	} catch (err) {
		console.error('[author-session] agent lookup failed:', err);
	}

	if (!agentId) {
		const created = await app.agentCatalog.createAgent({
			userId,
			currentProjectId: projectId,
			body: {
				name: author.name,
				slug: author.slug,
				description: author.description,
				runtime,
				tags: ['workflow-author'],
				projectId,
				config: authorConfig(workflow.name, runtime)
			}
		});
		if (created.status === 'invalid') return error(400, created.message);
		agentId = created.agent.id;
	}

	// Create the interactive session. The inline agentConfig override injects
	// THIS workflow's name into the persona (an experiment agent is minted per
	// distinct config); the first user message primes the agent with context.
	const result = await app.sessionCommands.createInteractiveSession({
		userId,
		projectId,
		body: {
			agentId,
			agentConfig: authorConfig(workflow.name, runtime),
			title: `Author · ${workflow.name}`,
			initialMessage: `I want to author the dynamic-script workflow "${workflow.name}". I'll describe what it should do in my next message.`
		}
	});

	switch (result.status) {
		case 'created':
			return json({ sessionId: result.session.id, agentId, runtime }, { status: 201 });
		case 'precondition_failed':
			return json(
				{ code: result.code, message: result.message, session: result.session },
				{ status: 412 }
			);
		case 'not_found':
			return error(404, result.message);
		case 'conflict':
			return error(409, result.message);
		case 'invalid':
			return error(400, result.message);
	}
};
