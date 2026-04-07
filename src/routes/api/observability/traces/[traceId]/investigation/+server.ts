import { json } from '@sveltejs/kit';
import { buildTraceInvestigation } from '$lib/server/observability/investigation';

export const GET = async ({ params }: { params: { traceId: string } }) => {
	try {
		const payload = await buildTraceInvestigation(params.traceId);
		return json(payload);
	} catch (err) {
		return json(
			{
				error: `Failed to build investigation payload: ${err instanceof Error ? err.message : String(err)}`
			},
			{ status: 500 }
		);
	}
};
