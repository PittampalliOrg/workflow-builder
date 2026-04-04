import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { saveBrowserArtifact, type WorkflowBrowserCaptureStep } from '$lib/server/browser-artifacts';

type ArtifactBody = {
	workflowExecutionId?: string;
	workflowId?: string;
	nodeId?: string;
	workspaceRef?: string;
	baseUrl?: string;
	status?: 'pending' | 'completed' | 'partial' | 'failed';
	metadata?: Record<string, unknown> | null;
	steps?: WorkflowBrowserCaptureStep[];
	screenshots?: Array<{
		payloadBase64: string;
		contentType?: string;
		stepId?: string;
		label?: string;
		storageRef?: string;
	}>;
	assets?: Array<{
		kind: 'trace' | 'video' | 'screenshot';
		payloadBase64: string;
		contentType?: string;
		fileName?: string;
		label?: string;
		stepId?: string;
		storageRef?: string;
	}>;
};

export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let body: ArtifactBody;
	try {
		body = (await request.json()) as ArtifactBody;
	} catch (error) {
		const detail = error instanceof Error ? error.message : 'Invalid JSON payload';
		const payloadTooLarge =
			detail.includes('Payload Too Large') ||
			detail.includes('exceeds limit') ||
			detail.includes('request body size exceeded');
		return json(
			{
				error: payloadTooLarge
					? 'Browser artifact payload too large'
					: 'Invalid JSON payload',
				detail
			},
			{ status: payloadTooLarge ? 413 : 400 }
		);
	}

	if (!body.workflowExecutionId || !body.workflowId || !body.nodeId) {
		return json(
			{ error: 'workflowExecutionId, workflowId, and nodeId are required' },
			{ status: 400 }
		);
	}

	try {
		const artifact = await saveBrowserArtifact({
			workflowExecutionId: body.workflowExecutionId,
			workflowId: body.workflowId,
			nodeId: body.nodeId,
			workspaceRef: body.workspaceRef,
			baseUrl: body.baseUrl ?? '',
			status: body.status ?? 'completed',
			metadata: body.metadata ?? null,
			steps: Array.isArray(body.steps) ? body.steps : [],
			screenshots: (body.screenshots ?? []).map((entry, index) => ({
				kind: 'screenshot',
				label: entry.label ?? `Screenshot ${index + 1}`,
				payloadBase64: entry.payloadBase64,
				contentType: entry.contentType,
				stepId: entry.stepId,
				storageRef: entry.storageRef
			})),
			assets: (body.assets ?? []).map((entry, index) => ({
				kind: entry.kind,
				label: entry.label ?? `Asset ${index + 1}`,
				payloadBase64: entry.payloadBase64,
				contentType: entry.contentType,
				fileName: entry.fileName,
				stepId: entry.stepId,
				storageRef: entry.storageRef
			}))
		});
		return json({ success: true, artifact });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to save browser artifact' },
			{ status: 500 }
		);
	}
};
