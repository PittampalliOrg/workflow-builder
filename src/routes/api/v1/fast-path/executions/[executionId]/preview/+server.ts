import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

function sharedPreviewInput(body: Record<string, unknown>) {
	return {
		timeoutSeconds: typeof body.timeoutSeconds === "number" ? body.timeoutSeconds : null,
		waitReadySeconds:
			typeof body.waitReadySeconds === "number" ? body.waitReadySeconds : undefined,
		image: typeof body.image === "string" ? body.image : null,
		executionClass:
			typeof body.executionClass === "string" ? body.executionClass : undefined,
		mode: (body.mode === "preview-native" || body.mode === "host-throwaway"
			? body.mode
			: undefined) as "preview-native" | "host-throwaway" | undefined,
		adopt: typeof body.adopt === "boolean" ? body.adopt : undefined,
		origin: typeof body.origin === "string" ? body.origin : undefined,
	};
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const app = getApplicationAdapters();
	const executionId = params.executionId;
	const environment = await app.workflowData.getDevEnvironmentOrPending({
		executionId,
		projectId: locals.session.projectId,
	});
	if (!environment) return error(404, "Fast path preview not found");
	const groups = await app.workflowData.listDevEnvironmentGroups({
		projectId: locals.session.projectId,
	});
	const services =
		groups.find((group) => group.executionId === executionId)?.services ?? [environment];
	return json({
		executionId,
		environment,
		services: services.map((service) => ({
			...service,
			capabilities: {
				sync: !!service.syncUrl,
				runCommands: app.devPreviewSidecar.allowedCommands(service.service),
			},
		})),
	});
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const app = getApplicationAdapters();
	const executionId = params.executionId;
	const environment = await app.workflowData.getDevEnvironmentOrPending({
		executionId,
		projectId: locals.session.projectId,
	});
	if (!environment) return error(404, "Execution not found");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	if (Object.prototype.hasOwnProperty.call(body, "syncToken")) {
		return json({ error: "syncToken is server-owned" }, { status: 400 });
	}
	const shared = sharedPreviewInput(body);
	const services = Array.isArray(body.services)
		? body.services.filter((service): service is string => typeof service === "string" && !!service)
		: null;
	try {
		if (services && services.length > 0) {
			return json(
				await app.previewEnvironmentProvisioner.provisionMany({
					executionId,
					services,
					...shared,
				}),
			);
		}
		return json(
			await app.previewEnvironmentProvisioner.provision({
				executionId,
				service: typeof body.service === "string" ? body.service : environment.service,
				...shared,
			}),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[fast-path] preview ensure failed:", message);
		return json({ error: message }, { status: 503 });
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const app = getApplicationAdapters();
	const executionId = params.executionId;
	const environment = await app.workflowData.getDevEnvironmentOrPending({
		executionId,
		projectId: locals.session.projectId,
	});
	if (!environment) return error(404, "Fast path preview not found");
	return json(await app.previewEnvironmentProvisioner.teardown({ executionId }));
};
