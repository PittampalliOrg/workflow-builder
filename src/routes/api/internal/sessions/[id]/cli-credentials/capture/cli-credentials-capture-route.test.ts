import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const owner = {
		id: "session-1",
		userId: "user-1",
		projectId: "project-1" as string | null,
	};
	const workflowData = {
		getSessionFileOwner: vi.fn(async (): Promise<typeof owner | null> => owner),
	};
	const validateInternalToken = vi.fn(() => true);
	const upsertUserCliCredential = vi.fn(async () => ({ provider: "agy" }));
	const releaseCliBootLease = vi.fn(async () => undefined);
	return {
		owner,
		releaseCliBootLease,
		upsertUserCliCredential,
		validateInternalToken,
		workflowData,
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("$lib/server/users/cli-credentials", () => ({
	upsertUserCliCredential: mocks.upsertUserCliCredential,
	releaseCliBootLease: mocks.releaseCliBootLease,
}));

import { POST } from "./+server";

function event(body: unknown) {
	return {
		params: { id: "session-1" },
		request: new Request(
			"http://localhost/api/internal/sessions/session-1/cli-credentials/capture",
			{
				method: "POST",
				body: typeof body === "string" ? body : JSON.stringify(body),
				headers: { "Content-Type": "application/json" },
			},
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

describe("internal CLI credential capture route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalToken.mockReturnValue(true);
		mocks.workflowData.getSessionFileOwner.mockResolvedValue(mocks.owner);
		mocks.upsertUserCliCredential.mockResolvedValue({ provider: "agy" });
	});

	it("keeps session-owner lookup behind workflow-data services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.getSessionFileOwner");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("sessions.userId");
	});

	it("requires an internal token", async () => {
		mocks.validateInternalToken.mockReturnValueOnce(false);

		await expectHttpStatus(
			Promise.resolve(POST(event({ provider: "agy", bundle: "bundle" }) as never)),
			401,
		);
		expect(mocks.workflowData.getSessionFileOwner).not.toHaveBeenCalled();
	});

	it("validates JSON and required fields before resolving the session", async () => {
		await expectHttpStatus(Promise.resolve(POST(event("{") as never)), 400);
		await expectHttpStatus(
			Promise.resolve(POST(event({ provider: "agy" }) as never)),
			400,
		);
		expect(mocks.workflowData.getSessionFileOwner).not.toHaveBeenCalled();
	});

	it("returns 404 when the session owner is missing", async () => {
		mocks.workflowData.getSessionFileOwner.mockResolvedValueOnce(null);

		await expectHttpStatus(
			Promise.resolve(POST(event({ provider: "agy", bundle: "bundle" }) as never)),
			404,
		);
		expect(mocks.upsertUserCliCredential).not.toHaveBeenCalled();
	});

	it("stores the bundle for the session owner and releases the boot lease", async () => {
		const response = (await POST(
			event({ provider: "agy", bundle: "bundle-data" }) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ stored: true, provider: "agy" });
		expect(mocks.workflowData.getSessionFileOwner).toHaveBeenCalledWith("session-1");
		expect(mocks.upsertUserCliCredential).toHaveBeenCalledWith(
			"user-1",
			"agy",
			"bundle-data",
		);
		expect(mocks.releaseCliBootLease).toHaveBeenCalledWith(
			"user-1",
			"agy",
			"session-1",
		);
	});

	it("returns 400 for invalid credential bundles", async () => {
		mocks.upsertUserCliCredential.mockRejectedValueOnce(new Error("bad bundle"));

		await expectHttpStatus(
			Promise.resolve(POST(event({ provider: "agy", bundle: "bad" }) as never)),
			400,
		);
		expect(mocks.releaseCliBootLease).not.toHaveBeenCalled();
	});
});
