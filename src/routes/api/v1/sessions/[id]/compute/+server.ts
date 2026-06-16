import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	getSessionRuntimePod,
	kubeApiFetch,
} from "$lib/server/kube/client";
import { resolveSessionRuntimeDebugTarget } from "$lib/server/sessions/runtime-target";
import {
	getPodResourceUsage,
	parseCpuToMillicores,
	parseMemoryToMiB,
} from "$lib/server/metrics/resources";

/**
 * GET /api/v1/sessions/[id]/compute — live ACTUAL CPU/memory consumed by the
 * session's runtime (sandbox) pod, alongside its scheduled requests. Powers the
 * session-detail "Compute" Pulse tile (the per-session counterpart to the
 * token/cost telemetry). Polled by the UI; reads the single pod's Metrics-API
 * sample + its request spec — no namespace-wide list. Usage is `null` until
 * metrics-server has a sample (pod just booted) or once the pod is gone.
 *
 * See docs/session-resource-metrics-and-kueue-admission.md.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const sessionId = params.id!;
	const target = await resolveSessionRuntimeDebugTarget(
		sessionId,
		locals.session.projectId,
	);
	if (!target) return error(404, "Session not found in workspace");

	const pod = await getSessionRuntimePod({
		runtimeAppId: target.appId,
		agentSlug: target.agentSlug,
	});
	if (!pod?.name) {
		// No live pod (idle-reaped / not yet admitted).
		return json({ podName: null, usage: null, requests: null });
	}

	const usage = await getPodResourceUsage(pod.name, pod.namespace);

	// Scheduled requests from the pod spec (sum across containers) — the
	// reservation the actual usage should be compared against.
	let requests: { cpuMillicores: number; memoryMiB: number } | null = null;
	try {
		const res = await kubeApiFetch(
			`/api/v1/namespaces/${encodeURIComponent(pod.namespace)}/pods/${encodeURIComponent(pod.name)}`,
		);
		if (res.ok) {
			const body = (await res.json()) as {
				spec?: {
					containers?: Array<{
						resources?: { requests?: { cpu?: string; memory?: string } };
					}>;
				};
			};
			let cpu = 0;
			let mem = 0;
			for (const c of body.spec?.containers ?? []) {
				cpu += parseCpuToMillicores(c.resources?.requests?.cpu);
				mem += parseMemoryToMiB(c.resources?.requests?.memory);
			}
			requests = { cpuMillicores: Math.round(cpu), memoryMiB: Math.round(mem) };
		}
	} catch {
		// requests are advisory context; absence is non-fatal.
	}

	return json({ podName: pod.name, usage, requests });
};
