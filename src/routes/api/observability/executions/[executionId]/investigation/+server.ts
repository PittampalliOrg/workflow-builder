import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { redactDiagnosticEvidence } from '$lib/server/application/diagnostic-redaction';
import { buildExecutionInvestigationFromEvidence } from '$lib/server/observability/investigation';
import {
	encodePageCursor,
	pageCursorScope
} from '$lib/server/application/diagnostic-pagination';

const CONTINUATION_PAGE_SIZE = 100;

function spanCursorScope(executionId: string): string {
	return pageCursorScope('public-execution-spans', {
		executionId,
		query: '',
		errorsOnly: false,
		limit: CONTINUATION_PAGE_SIZE
	});
}

/**
 * GET /api/observability/executions/[executionId]/investigation
 *
 * Full investigation payload for a single workflow run. This is execution-scoped
 * like the service graph and digest routes, so dynamic-script runs do not depend
 * on a session.id scan to find their workflow trace.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const application = getApplicationAdapters();
	const context = await application.workflowData.getObservabilityServiceGraphContext({
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		executionId: params.executionId
	});
	if (!context?.execution) return error(404, 'Execution not found');

	try {
		const evidence = await application.workflowDiagnostics.getInvestigationEvidence({
			execution: context.execution,
			request: {
				limits: { spans: 200, logs: 100, llmSpans: 20, toolSpans: 50 }
			}
		});
		const payload = await buildExecutionInvestigationFromEvidence(params.executionId, evidence, {
			workflowReader: application.observabilityInvestigationWorkflowReader
		});
		payload.evidenceCoverage = {
			spans: {
				loaded: evidence.traceSpans.length,
				rowTruncated: evidence.rowTruncated.spans,
				contentTruncated: evidence.contentTruncated.spans,
				nextCursor: evidence.rowTruncated.spans
					? encodePageCursor(evidence.traceSpans.length, spanCursorScope(params.executionId))
					: null
			},
			warnings: evidence.warnings
		};
		return json(redactDiagnosticEvidence(payload), {
			headers: { 'cache-control': 'no-store' }
		});
	} catch (err) {
		console.error('[observability] Failed to build execution investigation', {
			executionId: params.executionId,
			error: err instanceof Error ? { name: err.name, message: err.message } : String(err)
		});
		return error(502, 'Failed to build investigation payload');
	}
};
