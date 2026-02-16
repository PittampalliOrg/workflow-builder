import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockDbSelect = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-helpers", () => ({
	getSession: mockGetSession,
}));

vi.mock("@/lib/db", () => ({
	db: {
		select: mockDbSelect,
	},
}));

import { GET } from "./route";

function mockWorkflowRows(rows: Array<{ id: string; name: string }>) {
	const limit = vi.fn().mockResolvedValue(rows);
	const orderBy = vi.fn().mockReturnValue({ limit });
	const where = vi.fn().mockReturnValue({ orderBy });
	const from = vi.fn().mockReturnValue({ where });
	mockDbSelect.mockReturnValue({ from });
	return { from, where, orderBy, limit };
}

describe("GET /api/observability/entities", () => {
	beforeEach(() => {
		mockGetSession.mockReset();
		mockDbSelect.mockReset();
	});

	it("returns 401 when session is missing", async () => {
		mockGetSession.mockResolvedValueOnce(null);

		const response = await GET(
			new Request("http://localhost/api/observability/entities"),
		);
		const json = await response.json();

		expect(response.status).toBe(401);
		expect(json).toEqual({ error: "Unauthorized" });
		expect(mockDbSelect).not.toHaveBeenCalled();
	});

	it("returns mapped workflow entities for authenticated users", async () => {
		mockGetSession.mockResolvedValueOnce({
			user: { id: "user-1", projectId: "project-1" },
		});
		mockWorkflowRows([
			{ id: "wf-1", name: "Alpha" },
			{ id: "wf-2", name: "Beta" },
		]);

		const response = await GET(
			new Request("http://localhost/api/observability/entities"),
		);
		const json = await response.json();

		expect(response.status).toBe(200);
		expect(json).toEqual({
			entities: [
				{ id: "wf-1", name: "Alpha", type: "workflow" },
				{ id: "wf-2", name: "Beta", type: "workflow" },
			],
		});
	});

	it("returns 500 when DB lookup fails", async () => {
		mockGetSession.mockResolvedValueOnce({
			user: { id: "user-1", projectId: "project-1" },
		});
		const chain = mockWorkflowRows([]);
		chain.limit.mockRejectedValueOnce(new Error("db failure"));

		const response = await GET(
			new Request("http://localhost/api/observability/entities"),
		);
		const json = await response.json();

		expect(response.status).toBe(500);
		expect(json).toEqual({ error: "Failed to list observability entities" });
	});
});
