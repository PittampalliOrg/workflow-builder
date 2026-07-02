import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		getWorkflowBrowserBlobPayload: vi.fn(
			async (): Promise<{ payloadBase64: string; contentType: string } | null> => ({
				payloadBase64: "aGVsbG8=",
				contentType: "image/png",
			}),
		),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("workflow browser artifact blob route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getWorkflowBrowserBlobPayload.mockResolvedValue({
			payloadBase64: "aGVsbG8=",
			contentType: "image/png",
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getWorkflowBrowserBlobPayload");
		expect(source).not.toContain("$lib/server/browser-artifacts");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("streams browser artifact blob payloads", async () => {
		const response = (await GET({
			url: new URL("http://test/blob?storageRef=ref-1"),
		} as never)) as Response;

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("hello");
		expect(mocks.workflowData.getWorkflowBrowserBlobPayload).toHaveBeenCalledWith("ref-1");
	});

	it("404s when the blob is missing", async () => {
		mocks.workflowData.getWorkflowBrowserBlobPayload.mockResolvedValueOnce(null);

		await expectHttpStatus(
			Promise.resolve(GET({ url: new URL("http://test/blob?storageRef=ref-1") } as never)),
			404,
		);
	});
});
