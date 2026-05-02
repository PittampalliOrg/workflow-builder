import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { publicMlflowTraceRedirectUrl } from '$lib/server/observability/mlflow';

export const GET: RequestHandler = async ({ params }) => {
	const sessionId = params.sessionId?.trim();
	if (!sessionId) return error(400, 'Session id is required');

	const href = await publicMlflowTraceRedirectUrl({ sessionId });
	if (!href) return error(503, 'MLflow trace UI is not configured');
	return redirect(302, href);
};
