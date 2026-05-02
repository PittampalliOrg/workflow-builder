import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { publicMlflowTraceRedirectUrl } from '$lib/server/observability/mlflow';

export const GET: RequestHandler = async ({ params }) => {
	const traceId = params.traceId?.trim();
	if (!traceId) return error(400, 'Trace id is required');

	const href = await publicMlflowTraceRedirectUrl({ traceId });
	if (!href) return error(503, 'MLflow trace UI is not configured');
	return redirect(302, href);
};
