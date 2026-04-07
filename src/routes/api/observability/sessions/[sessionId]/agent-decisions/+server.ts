import { json } from '@sveltejs/kit';
import { buildSessionInvestigation } from '$lib/server/observability/investigation';

export const GET = async ({ params }: { params: { sessionId: string } }) => {
	try {
		const payload = await buildSessionInvestigation(params.sessionId);
		return json({
			summary: payload.agentDecisionSummary,
			turns: payload.agentDecisions
		});
	} catch (err) {
		return json(
			{
				error: `Failed to build agent decisions payload: ${err instanceof Error ? err.message : String(err)}`
			},
			{ status: 500 }
		);
	}
};
