import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflows } from '$lib/server/db/schema';
import { assertInScope } from '$lib/server/workflows/project-scope';
import { emitWorkflow, type EmitterLanguage } from '$lib/server/workflows/code-emitter';
import { createCodeFunction } from '$lib/server/code-functions';

function parseLanguage(value: string | null): EmitterLanguage {
	if (value === 'py' || value === 'python') return 'python';
	return 'typescript';
}

function parseInlineFlag(value: string | null): boolean {
	if (value === null) return true;
	return value !== 'false' && value !== '0' && value !== 'no';
}

async function loadWorkflow(workflowId: string, session: App.Locals['session']) {
	if (!db) throw error(503, 'Database not configured');
	if (!session?.userId) throw error(401, 'Authentication required');

	const [workflow] = await db
		.select()
		.from(workflows)
		.where(eq(workflows.id, workflowId))
		.limit(1);

	if (!workflow) throw error(404, 'Workflow not found');
	assertInScope(
		{ projectId: workflow.projectId ?? null, userId: workflow.userId },
		session,
		'Workflow not found',
	);

	const spec = (workflow as Record<string, unknown>).spec as Record<string, unknown> | null;
	if (!spec || typeof spec !== 'object') {
		throw error(
			400,
			'Workflow has no SW 1.0 spec. Save the workflow first before exporting.',
		);
	}
	return { workflow, spec };
}

export const GET: RequestHandler = async ({ params, url, locals }) => {
	const { workflowId } = params;
	const language = parseLanguage(url.searchParams.get('language'));
	const inlineFunctions = parseInlineFlag(url.searchParams.get('inlineFunctions'));
	const download = url.searchParams.get('download') === 'true';

	const { spec } = await loadWorkflow(workflowId!, locals.session);
	const result = await emitWorkflow(spec, {
		language,
		userId: locals.session?.userId ?? null,
		inlineFunctions,
	});

	if (url.searchParams.get('format') === 'json') {
		return json({
			source: result.source,
			supportingFiles: result.supportingFiles,
			warnings: result.warnings,
			compositionGraph: result.compositionGraph,
			workflowName: result.workflowName,
			filename: result.filename,
			language,
		});
	}

	const headers: Record<string, string> = {
		'content-type': language === 'typescript' ? 'text/typescript' : 'text/x-python',
	};
	if (download) {
		headers['content-disposition'] = `attachment; filename="${result.filename}"`;
	}
	return new Response(result.source, { status: 200, headers });
};

export const POST: RequestHandler = async ({ params, url, request, locals }) => {
	const { workflowId } = params;
	if (!locals.session?.userId) throw error(401, 'Authentication required');

	const language = parseLanguage(url.searchParams.get('language'));
	const inlineFunctions = parseInlineFlag(url.searchParams.get('inlineFunctions'));

	let body: { name?: string; description?: string | null } = {};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		// empty body is fine
	}

	const { workflow, spec } = await loadWorkflow(workflowId!, locals.session);
	const result = await emitWorkflow(spec, {
		language,
		userId: locals.session.userId,
		inlineFunctions,
	});

	const saved = await createCodeFunction(
		{
			name: (body.name?.trim() || `${workflow.name ?? result.workflowName} (workflow)`).slice(0, 120),
			description:
				body.description?.trim() ||
				`Emitted from workflow "${workflow.name ?? result.workflowName}" on ${new Date().toISOString()}. Warnings: ${result.warnings.length}.`,
			language,
			entrypoint: 'main',
			source: result.source,
			supportingFiles: result.supportingFiles,
			role: 'workflow',
			compositionGraph: result.compositionGraph,
		},
		locals.session.userId,
	);

	return json({
		codeFunctionId: saved.id,
		slug: saved.slug,
		name: saved.name,
		warnings: result.warnings,
		compositionGraph: result.compositionGraph,
		language,
	});
};
