import { env } from "$env/dynamic/private";
import { daprFetch } from "$lib/server/dapr-client";
import { getSwebenchCoordinatorUrl } from "$lib/server/application/adapters/benchmark-service";
import { getEvaluationCoordinatorUrl } from "$lib/server/application/adapters/evaluation-service";
import type {
	CoordinatorCancelInput,
	CoordinatorCancelPort,
	CoordinatorCancelResult,
} from "$lib/server/application/run-cancellation";

export class DaprCoordinatorCancelAdapter implements CoordinatorCancelPort {
	async cancelRun(
		input: CoordinatorCancelInput,
	): Promise<CoordinatorCancelResult> {
		const token = env.INTERNAL_API_TOKEN;
		if (!token) return { scheduled: false, error: null };

		if (input.mode === "background") {
			void this.notifyCoordinator(input, token).then((result) => {
				if (result.error) {
					console.warn(
						`Coordinator ${input.kind} cancel failed for ${input.runId}: ${result.error}`,
					);
				}
			});
			return { scheduled: true, error: null };
		}

		return this.notifyCoordinator(input, token);
	}

	private async notifyCoordinator(
		input: CoordinatorCancelInput,
		token: string,
	): Promise<CoordinatorCancelResult> {
		try {
			const res = await daprFetch(coordinatorCancelUrl(input), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Internal-Token": token,
				},
				body: JSON.stringify({ reason: input.reason }),
				maxRetries: 0,
				signal: AbortSignal.timeout(120_000),
			});
			if (!res.ok) {
				return {
					scheduled: true,
					error: `${res.status} ${await res.text()}`,
				};
			}
			return { scheduled: true, error: null };
		} catch (err) {
			return {
				scheduled: true,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}
}

function coordinatorCancelUrl(input: CoordinatorCancelInput) {
	if (input.kind === "benchmarkRun") {
		return `${getSwebenchCoordinatorUrl()}/api/v1/benchmark-runs/${input.runId}/cancel`;
	}
	return `${getEvaluationCoordinatorUrl()}/api/v1/evaluation-runs/${input.runId}/cancel`;
}
