import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentRuntimeControl: {
		listRuntimes: vi.fn(),
		getRuntimeDetail: vi.fn(),
		wakeRuntime: vi.fn(),
		sleepRuntime: vi.fn(),
		reapIdle: vi.fn(),
	},
	requireInternal: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		agentRuntimeControl: mocks.agentRuntimeControl,
	}),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { GET as LIST } from "./+server";
import { GET as DETAIL } from "./[slug]/+server";
import { POST as SLEEP } from "./[slug]/sleep/+server";
import { POST as WAKE } from "./[slug]/wake/+server";
import { POST as REAP_IDLE } from "../../internal/agent-runtimes/reap-idle/+server";

function locals(projectId: string | null = "project-1") {
	return {
		session: {
			userId: "user-1",
			projectId,
		},
	};
}

describe("agent runtime routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.agentRuntimeControl.listRuntimes.mockResolvedValue({ runtimes: [] });
		mocks.agentRuntimeControl.getRuntimeDetail.mockResolvedValue({
			status: "ok",
			body: {
				name: "agent-runtime-browser",
				exists: true,
				phase: "Active",
				replicas: 1,
				readyReplicas: 1,
				browserSidecarEnabled: true,
				browserMcpAvailable: true,
				pod: null,
			},
		});
		mocks.agentRuntimeControl.wakeRuntime.mockResolvedValue({
			phase: "Active",
			replicas: 1,
			readyReplicas: 1,
			source: "sandbox-warm-pool",
		});
		mocks.agentRuntimeControl.sleepRuntime.mockResolvedValue({ status: "ok" });
		mocks.agentRuntimeControl.reapIdle.mockResolvedValue({
			namespace: "workflow-builder",
			ttlSeconds: 1800,
			reaped: [],
			skipped: [],
		});
	});

	it("keeps agent-runtime routes free of direct DB and Kubernetes imports", () => {
		const baseDir = dirname(fileURLToPath(import.meta.url));
		const routeSources = [
			"+server.ts",
			"[slug]/+server.ts",
			"[slug]/wake/+server.ts",
			"[slug]/sleep/+server.ts",
			"../../internal/agent-runtimes/reap-idle/+server.ts",
		].map((path) => readFileSync(join(baseDir, path), "utf8"));

		for (const source of routeSources) {
			expect(source).toContain("getApplicationAdapters");
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("$lib/server/db/schema");
			expect(source).not.toContain("drizzle-orm");
			expect(source).not.toContain("$lib/server/kube/client");
		}
	});

	it("routes list/detail/wake/sleep calls through the application service", async () => {
		const listResponse = (await LIST({ locals: locals() } as never)) as Response;
		expect(listResponse.status).toBe(200);
		expect(mocks.agentRuntimeControl.listRuntimes).toHaveBeenCalledWith({
			projectId: "project-1",
		});

		const detailResponse = (await DETAIL({
			params: { slug: "browser" },
			locals: locals(),
		} as never)) as Response;
		expect(detailResponse.status).toBe(200);
		expect(mocks.agentRuntimeControl.getRuntimeDetail).toHaveBeenCalledWith({
			slug: "browser",
			projectId: "project-1",
		});

		const wakeResponse = (await WAKE({
			params: { slug: "browser" },
			url: new URL("http://localhost/api/v1/agent-runtimes/browser/wake?timeoutMs=9000"),
			locals: locals(),
		} as never)) as Response;
		expect(wakeResponse.status).toBe(200);
		expect(mocks.agentRuntimeControl.wakeRuntime).toHaveBeenCalledWith({
			slug: "browser",
			projectId: "project-1",
			timeoutMs: 9000,
		});

		const sleepResponse = (await SLEEP({
			params: { slug: "browser" },
			locals: locals(),
		} as never)) as Response;
		expect(sleepResponse.status).toBe(200);
		expect(mocks.agentRuntimeControl.sleepRuntime).toHaveBeenCalledWith({
			slug: "browser",
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("routes the internal idle reaper through the application service", async () => {
		const response = (await REAP_IDLE({
			request: new Request("http://localhost/api/internal/agent-runtimes/reap-idle", {
				method: "POST",
			}),
		} as never)) as Response;

		expect(response.status).toBe(200);
		expect(mocks.requireInternal).toHaveBeenCalled();
		expect(mocks.agentRuntimeControl.reapIdle).toHaveBeenCalledWith({
			namespace: "workflow-builder",
			ttlSeconds: 1800,
		});
	});
});
