import { describe, it, expect, vi } from "vitest";

// The tools read INTERNAL_API_TOKEN at module load (const at top of
// code-lifecycle-tools.ts) — hoist the stub so handlers reach their fetch
// calls instead of short-circuiting on the token gate.
vi.hoisted(() => {
	process.env.INTERNAL_API_TOKEN = "test-token";
});
import { registerCodeLifecycleTools } from "./code-lifecycle-tools.js";
import type { WorkflowMcpPrincipal } from "./auth-context.js";

const PRINCIPAL: WorkflowMcpPrincipal = {
	authMode: "workspace_api_key",
	userId: "user-1",
	projectId: "project-1",
	scopes: ["workflow:read", "workflow:execute"],
	principalAssertion: "signed-principal-assertion",
	capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" },
};

type CapturedTool = {
	name: string;
	config: { inputSchema?: unknown; description?: string };
	handler: (args: unknown) => Promise<{
		content: { type: "text"; text: string }[];
		isError?: boolean;
	}>;
};

function fakeServer() {
	const captured: CapturedTool[] = [];
	const server = {
		registerTool(name: string, config: any, handler: any) {
			captured.push({ name, config, handler });
		},
	};
	return { server, captured };
}

function jsonResponse(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

function parseResult(res: {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}) {
	return JSON.parse(res.content[0].text);
}

function register(
	fetchImpl: typeof fetch,
	principal: WorkflowMcpPrincipal | undefined = PRINCIPAL,
) {
	const { server, captured } = fakeServer();
	const tools = registerCodeLifecycleTools(server as any, {
		principal,
		fetchImpl,
	});
	const tool = (name: string) => {
		const found = captured.find((t) => t.name === name);
		if (!found) throw new Error(`tool ${name} not registered`);
		return found;
	};
	return { captured, tools, tool };
}

describe("code-lifecycle tools registration", () => {
	it("registers all five tools for an execute+read principal", () => {
		const { captured } = register(vi.fn());
		expect(captured.map((t) => t.name)).toEqual([
			"list_code_checkpoints",
			"get_checkpoint_diff",
			"restore_checkpoint",
			"resume_workflow_execution",
			"promote_run_to_pr",
		]);
	});

	it("registers only the read tools without workflow:execute", () => {
		const { server, captured } = fakeServer();
		registerCodeLifecycleTools(server as any, {
			principal: { ...PRINCIPAL, scopes: ["workflow:read"] },
			fetchImpl: vi.fn(),
		});
		expect(captured.map((t) => t.name)).toEqual([
			"list_code_checkpoints",
			"get_checkpoint_diff",
		]);
	});

	it("registers nothing without a principal", () => {
		const { server, captured } = fakeServer();
		registerCodeLifecycleTools(server as any, {
			principal: undefined,
			fetchImpl: vi.fn(),
		});
		expect(captured).toEqual([]);
	});

	it("labels restore and promote as destructive/real-PR in their descriptions", () => {
		const { captured } = register(vi.fn());
		const restore = captured.find((t) => t.name === "restore_checkpoint");
		const promote = captured.find((t) => t.name === "promote_run_to_pr");
		expect(restore?.config.description).toContain("DESTRUCTIVE");
		expect(promote?.config.description).toContain("REAL GitHub PR");
	});
});

describe("list_code_checkpoints", () => {
	it("compacts rows and marks pushed checkpoints durable", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, {
				checkpoints: [
					{
						id: "cp-1",
						seq: 2,
						toolName: "Edit",
						nodeId: "node-a",
						status: "created",
						remoteStatus: "pushed",
						fileCount: 1,
						changedFiles: [{ path: "src/app.ts", changeType: "modified" }],
						sandboxName: "sbx-1",
						beforeSha: "aaaaaaaaaaaaaaaaaaaa",
						afterSha: "bbbbbbbbbbbbbbbbbbbb",
						createdAt: "2026-07-24T00:00:00.000Z",
					},
					{ id: "cp-2", remoteStatus: "pending", changedFiles: [] },
				],
			}),
		);
		const { tool } = register(fetchImpl as unknown as typeof fetch);
		const res = await tool("list_code_checkpoints").handler({
			executionId: "exec-1",
		});
		const body = parseResult(res);
		const [, url, init] = [null, ...(fetchImpl.mock.calls[0] as any[])];
		expect(String(url)).toContain(
			"/api/internal/executions/exec-1/code-checkpoints",
		);
		expect((init as any).headers["X-Wfb-Principal-Assertion"]).toBe(
			"signed-principal-assertion",
		);
		expect(body.count).toBe(2);
		expect(body.checkpoints[0]).toMatchObject({
			id: "cp-1",
			durable: true,
			files: ["src/app.ts"],
			beforeSha: "aaaaaaaaaaaa",
		});
		expect(body.checkpoints[1].durable).toBe(false);
	});

	it("maps an upstream error", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(404, { error: "nope" }));
		const { tool } = register(fetchImpl as unknown as typeof fetch);
		const res = await tool("list_code_checkpoints").handler({
			executionId: "exec-x",
		});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("HTTP 404");
	});
});

describe("get_checkpoint_diff", () => {
	it("forwards the path filter and truncates a large diff", async () => {
		const bigDiff = "x".repeat(70_000);
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, { diff: bigDiff, source: "sandbox", exitCode: 0 }),
		);
		const { tool } = register(fetchImpl as unknown as typeof fetch);
		const res = await tool("get_checkpoint_diff").handler({
			executionId: "exec-1",
			checkpointId: "cp-1",
			path: "src/app.ts",
		});
		const url = String((fetchImpl.mock.calls[0] as any[])[0]);
		expect(url).toContain(
			"/api/internal/executions/exec-1/code-checkpoints/cp-1/diff",
		);
		expect(url).toContain("path=src%2Fapp.ts");
		const body = parseResult(res);
		expect(body.truncated).toBe(true);
		expect(body.diff.length).toBe(60_000);
	});
});

describe("restore_checkpoint", () => {
	it("posts the target sandbox name", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, { ok: true, restored: true }),
		);
		const { tool } = register(fetchImpl as unknown as typeof fetch);
		const res = await tool("restore_checkpoint").handler({
			executionId: "exec-1",
			checkpointId: "cp-1",
			sandboxName: "sbx-9",
		});
		const [url, init] = fetchImpl.mock.calls[0] as any[];
		expect(String(url)).toContain(
			"/api/internal/executions/exec-1/code-checkpoints/cp-1/restore",
		);
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body)).toEqual({ sandboxName: "sbx-9" });
		expect(parseResult(res)).toMatchObject({ ok: true });
	});

	it("maps a 409 non-durable error", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(409, { error: "Checkpoint is not durably pushed" }),
		);
		const { tool } = register(fetchImpl as unknown as typeof fetch);
		const res = await tool("restore_checkpoint").handler({
			executionId: "exec-1",
			checkpointId: "cp-1",
			sandboxName: "sbx-9",
		});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("not durably pushed");
	});
});

describe("resume_workflow_execution", () => {
	it("forwards fromNodeId and returns the new run identifiers", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, {
				ok: true,
				executionId: "exec-2",
				sourceExecutionId: "exec-1",
				newInstanceId: "inst-2",
				fromNodeId: "node-b",
				seededFromSnapshot: true,
			}),
		);
		const { tool } = register(fetchImpl as unknown as typeof fetch);
		const res = await tool("resume_workflow_execution").handler({
			executionId: "exec-1",
			fromNodeId: "node-b",
		});
		const [url, init] = fetchImpl.mock.calls[0] as any[];
		expect(String(url)).toContain("/api/internal/executions/exec-1/resume");
		expect(JSON.parse(init.body)).toEqual({ fromNodeId: "node-b" });
		expect(parseResult(res)).toMatchObject({
			executionId: "exec-2",
			seededFromSnapshot: true,
		});
	});
});

describe("promote_run_to_pr", () => {
	it("auto-promotes the single unpromoted version when no artifactId is given", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(200, {
					versions: [
						{ artifactId: "art-1", promotion: { prUrl: "https://x/1" } },
						{ artifactId: "art-2", promotion: null },
					],
					unpromotedCount: 1,
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse(200, { ok: true, prUrl: "https://github.com/o/r/pull/9" }),
			);
		const { tool } = register(fetchImpl as unknown as typeof fetch);
		const res = await tool("promote_run_to_pr").handler({
			executionId: "exec-1",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const promoteUrl = String((fetchImpl.mock.calls[1] as any[])[0]);
		expect(promoteUrl).toContain(
			"/api/internal/executions/exec-1/versions/art-2/promote",
		);
		expect(parseResult(res)).toMatchObject({
			artifactId: "art-2",
			ok: true,
			prUrl: "https://github.com/o/r/pull/9",
		});
	});

	it("returns the version list when multiple are unpromoted", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, {
				versions: [
					{ artifactId: "art-1", title: "v1", promotion: null },
					{ artifactId: "art-2", title: "v2", promotion: null },
				],
				unpromotedCount: 2,
			}),
		);
		const { tool } = register(fetchImpl as unknown as typeof fetch);
		const res = await tool("promote_run_to_pr").handler({
			executionId: "exec-1",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const body = parseResult(res);
		expect(body.needsArtifactId).toBe(true);
		expect(body.unpromotedCount).toBe(2);
		expect(body.versions).toHaveLength(2);
		expect(body.versions[0]).toMatchObject({ artifactId: "art-1", promoted: false });
	});

	it("promotes the given artifactId directly with mode/repo", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, { ok: true, branch: "wfb/promote" }),
		);
		const { tool } = register(fetchImpl as unknown as typeof fetch);
		const res = await tool("promote_run_to_pr").handler({
			executionId: "exec-1",
			artifactId: "art-7",
			mode: "branch",
			repo: "o/r",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as any[];
		expect(String(url)).toContain(
			"/api/internal/executions/exec-1/versions/art-7/promote",
		);
		expect(JSON.parse(init.body)).toEqual({ mode: "branch", repo: "o/r" });
		expect(parseResult(res)).toMatchObject({ artifactId: "art-7", ok: true });
	});
});
