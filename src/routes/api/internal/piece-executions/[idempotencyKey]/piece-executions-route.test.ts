import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const pieceExecution = {
		idempotencyKey: "wf:exec:task",
		status: "completed",
		result: { ok: true },
		error: null,
		pieceName: "@activepieces/piece-github",
		actionName: "create_issue",
		completedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
	const workflowData = {
		getPieceExecutionByIdempotencyKey: vi.fn(
			async (): Promise<typeof pieceExecution | null> => pieceExecution,
		),
	};
	const requireInternal = vi.fn(() => undefined);
	return { pieceExecution, requireInternal, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { GET } from "./+server";

function event(idempotencyKey = "wf:exec:task") {
	return {
		params: { idempotencyKey },
		request: new Request(
			`http://localhost/api/internal/piece-executions/${encodeURIComponent(idempotencyKey)}`,
		),
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

describe("internal piece execution route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getPieceExecutionByIdempotencyKey.mockResolvedValue(
			mocks.pieceExecution,
		);
	});

	it("keeps piece execution reads behind workflow-data services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.getPieceExecutionByIdempotencyKey");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("pieceExecution");
	});

	it("returns the persisted piece execution read model", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			status: "completed",
			result: { ok: true },
			error: null,
			pieceName: "@activepieces/piece-github",
			actionName: "create_issue",
			completedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(mocks.requireInternal).toHaveBeenCalled();
		expect(mocks.workflowData.getPieceExecutionByIdempotencyKey).toHaveBeenCalledWith(
			"wf:exec:task",
		);
	});

	it("returns 404 when the idempotency key has no row", async () => {
		mocks.workflowData.getPieceExecutionByIdempotencyKey.mockResolvedValueOnce(null);

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});

	it("returns 503 when the repository is unavailable", async () => {
		mocks.workflowData.getPieceExecutionByIdempotencyKey.mockRejectedValueOnce(
			new Error("Database not configured"),
		);

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 503);
	});
});
