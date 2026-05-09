import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";

import {
	browserAgentSandboxWarmPoolName,
	getSandboxWarmPool,
} from "$lib/server/kube/client";
import { requireInternal } from "$lib/server/internal-auth";

/**
 * Internal read-through of the per-agent SandboxWarmPool status.
 *
 * Browser/Playwright agents have a SandboxWarmPool emitted by registry-sync
 * on publish; the response shape is normalized for UI consumption (phase,
 * replicas, readyReplicas). Non-browser agents have no per-agent K8s state
 * (their dispatch goes through per-session Sandboxes from sandbox-execution-
 * api), so the endpoint returns `exists: false` for them.
 *
 * After Arc 3, the legacy AgentRuntime CR + its Kopf controller are gone;
 * the PUT/DELETE handlers that used to mediate publish/archive went with
 * them — registry-sync writes the new resources directly via kubeClient.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const slug = params.slug!;
	const name = browserAgentSandboxWarmPoolName(slug);
	const pool = await getSandboxWarmPool(name);
	if (!pool) {
		return json(
			{ name, phase: "Unknown", replicas: 0, readyReplicas: 0, exists: false },
			{ status: 200 },
		);
	}
	const desired = pool.spec?.replicas ?? 0;
	const replicas = pool.status?.replicas ?? 0;
	const ready = pool.status?.readyReplicas ?? 0;
	const phase =
		desired === 0 && replicas === 0
			? "Sleeping"
			: desired > 0 && ready >= desired
				? "Active"
				: desired > 0
					? "Starting"
					: "Unknown";
	return json({
		name: pool.metadata.name,
		namespace: pool.metadata.namespace,
		exists: true,
		phase,
		desiredReplicas: desired,
		replicas,
		readyReplicas: ready,
		sandboxTemplateRef: pool.spec.sandboxTemplateRef.name,
		annotations: pool.metadata.annotations ?? {},
	});
};
