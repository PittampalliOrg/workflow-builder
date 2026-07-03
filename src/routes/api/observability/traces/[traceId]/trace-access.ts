import { error } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationObservabilityTraceAccessError } from "$lib/server/application/observability-trace-access";

type CallerSession = {
	userId: string;
	projectId?: string | null;
};

export async function assertTraceInScope(
	traceId: string,
	session: CallerSession | null | undefined,
): Promise<void> {
	try {
		await getApplicationAdapters().observabilityTraceAccess.assertTraceAccess({
			traceId,
			session,
		});
	} catch (err) {
		if (err instanceof ApplicationObservabilityTraceAccessError) {
			throw error(err.status, err.message);
		}
		throw err;
	}
}
