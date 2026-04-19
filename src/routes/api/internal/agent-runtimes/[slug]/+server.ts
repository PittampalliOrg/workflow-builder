import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";

import {
	getAgentRuntime,
	upsertAgentRuntime,
	deleteAgentRuntime,
	agentRuntimeName,
	type AgentRuntimeSpec,
} from "$lib/server/kube/client";
import { requireInternal } from "$lib/server/internal-auth";

/**
 * Internal read-through of an AgentRuntime CR status for the UI + other
 * BFF callers. 404 when the CR does not exist (agent never published).
 */
export const GET: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const slug = params.slug!;
	const cr = await getAgentRuntime(slug);
	if (!cr) {
		return json(
			{
				name: agentRuntimeName(slug),
				phase: "Unknown",
				replicas: 0,
				exists: false,
			},
			{ status: 200 },
		);
	}
	return json({
		name: cr.metadata.name,
		namespace: cr.metadata.namespace,
		exists: true,
		spec: cr.spec,
		status: cr.status ?? {},
		annotations: cr.metadata.annotations ?? {},
	});
};

/**
 * Create or update the CR. Body is the full AgentRuntimeSpec.
 * Called by registry-sync on publish.
 */
export const PUT: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const slug = params.slug!;
	const spec = (await request.json()) as AgentRuntimeSpec;
	if (spec.agentSlug !== slug) {
		return json(
			{ error: `slug mismatch: path=${slug} body=${spec.agentSlug}` },
			{ status: 400 },
		);
	}
	const cr = await upsertAgentRuntime(spec);
	return json({ name: cr.metadata.name, spec: cr.spec, status: cr.status ?? {} });
};

/**
 * Delete the CR. Called by registry-sync on archive.
 */
export const DELETE: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	await deleteAgentRuntime(params.slug!);
	return new Response(null, { status: 204 });
};
