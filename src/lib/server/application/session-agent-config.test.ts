import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSessionAgentConfigService } from "$lib/server/application/session-agent-config";
import type { WorkflowDataService } from "$lib/server/application/ports";

describe("ApplicationSessionAgentConfigService", () => {
	let patches: Pick<WorkflowDataService, "raiseSessionAgentConfigPatch">;
	let service: ApplicationSessionAgentConfigService;

	beforeEach(() => {
		patches = {
			raiseSessionAgentConfigPatch: vi.fn(async (input) => ({
				ok: true,
				status: 200,
				patch: input.patch as never,
			})),
		};
		service = new ApplicationSessionAgentConfigService({ patches });
	});

	it("canonicalizes valid model changes before raising the patch", async () => {
		const result = await service.setModel({
			...commandInput(),
			body: { modelSpec: " gpt-5.5 " },
		});

		expect(result).toEqual({
			status: "ok",
			body: { modelSpec: "openai/gpt-5.5" },
		});
		expect(patches.raiseSessionAgentConfigPatch).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
			userId: "user-1",
			patch: { modelSpec: "openai/gpt-5.5" },
		});
	});

	it("rejects missing and unsupported model changes before raising patches", async () => {
		await expect(
			service.setModel({ ...commandInput(), body: {} }),
		).resolves.toMatchObject({
			status: "error",
			httpStatus: 400,
			message: "modelSpec is required",
		});
		await expect(
			service.setModel({
				...commandInput(),
				body: { modelSpec: "unknown/model" },
			}),
		).resolves.toMatchObject({
			status: "error",
			httpStatus: 400,
		});
		expect(patches.raiseSessionAgentConfigPatch).not.toHaveBeenCalled();
	});

	it("validates permission mode changes before raising the patch", async () => {
		const result = await service.setPermissionMode({
			...commandInput(),
			body: { mode: "bypass" },
		});

		expect(result).toEqual({
			status: "ok",
			body: { mode: "bypass" },
		});
		expect(patches.raiseSessionAgentConfigPatch).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
			userId: "user-1",
			patch: { permissionMode: "bypass" },
		});
	});

	it("rejects unsupported permission modes before raising patches", async () => {
		const result = await service.setPermissionMode({
			...commandInput(),
			body: { mode: "admin" },
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 400,
			message: "mode must be 'bypass' or 'default'",
		});
		expect(patches.raiseSessionAgentConfigPatch).not.toHaveBeenCalled();
	});

	it("returns normalized patch payloads for generic config updates", async () => {
		vi.mocked(patches.raiseSessionAgentConfigPatch).mockResolvedValue({
			ok: true,
			status: 200,
			patch: { modelSpec: "openai/gpt-5.5" },
		});

		const result = await service.updateAgentConfig({
			...commandInput(),
			body: { modelSpec: "openai/gpt-5.5", ignored: true },
		});

		expect(result).toEqual({
			status: "ok",
			body: {
				patch: { modelSpec: "openai/gpt-5.5" },
				applies: "next_turn",
			},
		});
	});

	it("maps patch command failures to route-safe errors", async () => {
		vi.mocked(patches.raiseSessionAgentConfigPatch).mockResolvedValue({
			ok: false,
			status: 404,
			error: "Session not found",
		});

		const result = await service.updateAgentConfig({
			...commandInput(),
			body: { modelSpec: "openai/gpt-5.5" },
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			message: "Session not found",
		});
	});
});

function commandInput() {
	return {
		sessionId: "session-1",
		userId: "user-1",
		projectId: "project-1",
	};
}
