import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	type ProvisioningResult =
		| {
				status: "ok";
				data: {
					phase: "starting";
					label: string;
					detail: null;
					podName: string;
					podPhase: string;
					source: "observer";
				};
		  }
		| { status: "not_found" };
	const workflowData = {
		getSessionProvisioningReadModel: vi.fn<() => Promise<ProvisioningResult>>(async () => ({
			status: "ok" as const,
			data: {
				phase: "starting" as const,
				label: "Starting containers",
				detail: null,
				podName: "agent-host-session-1",
				podPhase: "Running",
				source: "observer" as const,
			},
		})),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { id: "session-1" },
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	};
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("session provisioning route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getSessionProvisioningReadModel.mockResolvedValue({
			status: "ok",
			data: {
				phase: "starting",
				label: "Starting containers",
				detail: null,
				podName: "agent-host-session-1",
				podPhase: "Running",
				source: "observer",
			},
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionProvisioningReadModel");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("getSessionProvisioningPreferObserver");
	});

	it("returns provisioning through workflowData", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			phase: "starting",
			label: "Starting containers",
			podName: "agent-host-session-1",
		});
		expect(mocks.workflowData.getSessionProvisioningReadModel).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});
	});

	it("hides sessions outside workflowData scope", async () => {
		mocks.workflowData.getSessionProvisioningReadModel.mockResolvedValueOnce({
			status: "not_found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});

	it("requires authentication", async () => {
		await expectHttpStatus(
			Promise.resolve(GET(event({ locals: { session: null } }) as never)),
			401,
		);
		expect(mocks.workflowData.getSessionProvisioningReadModel).not.toHaveBeenCalled();
	});
});
