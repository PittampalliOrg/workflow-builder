import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	type ContextUsageResult = {
		sessionId: string;
		usage: { input_tokens: number; output_tokens: number };
		activeContext: { context_used_percentage: number };
		lastProviderContext: { model: string };
		events: {
			total: number;
			totalBytes: number;
			llmTurns: number;
		};
	} | null;
	const workflowData = {
		getSessionContextUsage: vi.fn<() => Promise<ContextUsageResult>>(async () => ({
			sessionId: "session-1",
			usage: { input_tokens: 100, output_tokens: 25 },
			activeContext: { context_used_percentage: 12 },
			lastProviderContext: { model: "openai/gpt-5.5" },
			events: {
				total: 7,
				totalBytes: 4096,
				llmTurns: 2,
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

describe("session context usage route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getSessionContextUsage.mockResolvedValue({
			sessionId: "session-1",
			usage: { input_tokens: 100, output_tokens: 25 },
			activeContext: { context_used_percentage: 12 },
			lastProviderContext: { model: "openai/gpt-5.5" },
			events: {
				total: 7,
				totalBytes: 4096,
				llmTurns: 2,
			},
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionContextUsage");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("assertSessionInScope");
		expect(source).not.toContain("$lib/server/sessions/registry");
	});

	it("returns usage through workflowData", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			sessionId: "session-1",
			usage: { input_tokens: 100, output_tokens: 25 },
			activeContext: { context_used_percentage: 12 },
			lastProviderContext: { model: "openai/gpt-5.5" },
			events: {
				total: 7,
				totalBytes: 4096,
				llmTurns: 2,
			},
		});
		expect(mocks.workflowData.getSessionContextUsage).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});
	});

	it("hides sessions outside workflowData scope", async () => {
		mocks.workflowData.getSessionContextUsage.mockResolvedValueOnce(null);

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});

	it("requires authentication", async () => {
		await expectHttpStatus(
			Promise.resolve(GET(event({ locals: { session: null } }) as never)),
			401,
		);
		expect(mocks.workflowData.getSessionContextUsage).not.toHaveBeenCalled();
	});
});
