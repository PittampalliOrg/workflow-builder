import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { db } from '$lib/server/db';
import { agents } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';

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

const AUTHOR_SLUG = 'workflow-author-dynamic';
const WORKFLOW_MCP_URL =
	process.env.WORKFLOW_MCP_SERVER_URL ??
	'http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp';

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

function authorConfig(workflowName: string) {
	return {
		model: 'zai/glm-5.2',
		modelSpec: 'zai/glm-5.2',
		runtime: 'dapr-agent-py',
		maxTurns: 60,
		timeoutMinutes: 60,
		tools: [],
		skills: [],
		systemPrompt: authorSystemPrompt(workflowName),
		mcpServers: [
			{
				url: WORKFLOW_MCP_URL,
				name: 'workflow-authoring',
				transport: 'streamable_http'
			}
		]
	};
}

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const userId = locals.session.userId;
	const projectId = locals.session.projectId ?? null;
	if (!projectId) return error(400, 'No active project');

	const app = getApplicationAdapters();
	const workflow = (await app.workflowData.getWorkflowByRef({
		workflowId: params.workflowId,
		lookup: 'id'
	})) as { id: string; name: string; engineType?: string | null } | null;
	if (!workflow) return error(404, 'Workflow not found');

	// Ensure the per-project author agent exists (idempotent by project+slug).
	let agentId: string | null = null;
	try {
		const [existing] = await db
			.select({ id: agents.id })
			.from(agents)
			.where(and(eq(agents.projectId, projectId), eq(agents.slug, AUTHOR_SLUG)))
			.limit(1);
		agentId = existing?.id ?? null;
	} catch (err) {
		console.error('[author-session] agent lookup failed:', err);
	}

	if (!agentId) {
		const created = await app.agentCatalog.createAgent({
			userId,
			currentProjectId: projectId,
			body: {
				name: 'Workflow Author (GLM 5.2)',
				slug: AUTHOR_SLUG,
				description:
					'Authors dynamic-script workflows from natural language, embedded in the canvas AI panel.',
				runtime: 'dapr-agent-py',
				tags: ['workflow-author'],
				projectId,
				config: authorConfig(workflow.name)
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
			agentConfig: authorConfig(workflow.name),
			title: `Author · ${workflow.name}`,
			initialMessage: `I want to author the dynamic-script workflow "${workflow.name}". I'll describe what it should do in my next message.`
		}
	});

	switch (result.status) {
		case 'created':
			return json({ sessionId: result.session.id, agentId }, { status: 201 });
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
