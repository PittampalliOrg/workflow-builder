import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("event: test\n\n"));
			controller.close();
		},
	});
	const workflowExecutionStream = {
		createEventStream: vi.fn(() => stream),
	};
	return { workflowExecutionStream, stream };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowExecutionStream: mocks.workflowExecutionStream,
	}),
}));

import { GET } from "./+server";

describe("workflow execution event stream route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowExecutionStream.createEventStream.mockReturnValue(mocks.stream);
	});

	it("delegates stream creation to the application service", async () => {
		const response = (await GET(event())) as Response;

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(response.headers.get("x-accel-buffering")).toBe("no");
		expect(mocks.workflowExecutionStream.createEventStream).toHaveBeenCalledWith({
			executionId: "exec-1",
		});
	});

	it("keeps execution stream internals out of the route", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionStream.createEventStream");
		expect(source).not.toContain("workflowData.");
		expect(source).not.toContain("$lib/server/execution-read-model");
		expect(source).not.toContain("loadExecutionReadModel");
		expect(source).not.toContain("serializeExecutionReadModel");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("sql.listen");
	});
});

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
		request: new Request(
			"http://localhost/api/workflows/executions/exec-1/nats-stream",
			{ headers: { "last-event-id": "1" } },
		),
		...overrides,
	} as never;
}
