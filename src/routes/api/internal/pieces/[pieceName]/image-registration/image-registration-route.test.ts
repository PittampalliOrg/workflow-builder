import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireInternal: vi.fn(),
	workflowData: {
		recordAdminPieceRuntimeImageResult: vi.fn(async () => ({
			pieceName: "custom-tool",
			version: "1.0.0",
			status: "ready",
			madeRunnable: true,
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { POST } from "./+server";

function event(body: unknown) {
	return {
		params: { pieceName: "custom-tool" },
		request: new Request(
			"http://localhost/api/internal/pieces/custom-tool/image-registration",
			{
				method: "POST",
				body: JSON.stringify(body),
				headers: { "Content-Type": "application/json" },
			},
		),
	};
}

describe("internal piece image registration route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.recordAdminPieceRuntimeImageResult.mockResolvedValue({
			pieceName: "custom-tool",
			version: "1.0.0",
			status: "ready",
			madeRunnable: true,
		});
	});

	it("keeps image registration behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.recordAdminPieceRuntimeImageResult");
		expect(source).toContain("requireInternal");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/pieces/piece-images");
	});

	it("delegates successful image registration callbacks", async () => {
		const response = (await POST(
			event({
				version: "1.0.0",
				status: "ready",
				image: "ghcr.io/example/ap-piece-custom-tool:1.0.0",
				digest: "sha256:abc",
			}) as never,
		)) as Response;

		expect(mocks.requireInternal).toHaveBeenCalledWith(expect.any(Request));
		expect(mocks.workflowData.recordAdminPieceRuntimeImageResult).toHaveBeenCalledWith({
			pieceName: "custom-tool",
			version: "1.0.0",
			status: "ready",
			image: "ghcr.io/example/ap-piece-custom-tool:1.0.0",
			digest: "sha256:abc",
			errorMessage: undefined,
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			pieceName: "custom-tool",
			version: "1.0.0",
			status: "ready",
			madeRunnable: true,
		});
	});
});
