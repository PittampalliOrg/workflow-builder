import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dispatchAgentTrigger: vi.fn(async () => ({
		status: "ack" as const,
		outcome: "started" as const,
	})),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		sessionCommands: {
			dispatchAgentTrigger: mocks.dispatchAgentTrigger,
		},
	}),
}));

import { POST } from "./+server";

function event(data: Record<string, unknown> | string) {
	return {
		request: new Request("http://localhost/api/internal/dapr/agent-trigger", {
			method: "POST",
			body: typeof data === "string" ? data : JSON.stringify(data),
			headers: { "Content-Type": "application/json" },
		}),
	};
}

async function expectSuccess(response: Response) {
	expect(response.status).toBe(200);
	await expect(response.json()).resolves.toEqual({ status: "SUCCESS" });
}

describe("internal Dapr agent-trigger route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps agent-trigger business flow behind the session command service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("sessionCommands.dispatchAgentTrigger");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/sessions/events");
		expect(source).not.toContain("$lib/server/sessions/spawn");
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).not.toContain("createHash");
		expect(source).not.toContain("getWorkspaceProjectMembershipDetail");
	});

	it("acks malformed JSON without dispatching the command", async () => {
		await expectSuccess((await POST(event("{") as never)) as Response);

		expect(mocks.dispatchAgentTrigger).not.toHaveBeenCalled();
	});

	it("delegates parsed request bodies to the session command service", async () => {
		const body = {
			id: "ce-1",
			data: {
				agentSlug: "writer",
				projectId: "project-1",
				userId: "user-1",
				objective: "Draft the update",
				dedupKey: "source:event:1",
			},
		};

		await expectSuccess((await POST(event(body) as never)) as Response);

		expect(mocks.dispatchAgentTrigger).toHaveBeenCalledWith({ body });
	});

	it("still acks when the command throws", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.dispatchAgentTrigger.mockRejectedValueOnce(new Error("boom"));

		await expectSuccess((await POST(event({ id: "ce-1", data: {} }) as never)) as Response);
		error.mockRestore();
	});
});
