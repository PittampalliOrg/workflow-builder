import { describe, it, expect, vi } from "vitest";
import {
	registerScriptTools,
	runWorkflowScriptSchema,
	shouldSuppressScriptTools,
	type ScriptToolsContext,
} from "./script-tools.js";

// ── Fake McpServer capturing registerTool(...) ───────────────
type CapturedTool = {
	name: string;
	config: { inputSchema?: unknown; description?: string };
	handler: (args: unknown, extra?: unknown) => Promise<{
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

function getHandler(ctx?: ScriptToolsContext) {
	const { server, captured } = fakeServer();
	const tools = registerScriptTools(server as any, ctx);
	const tool = captured.find((t) => t.name === "run_workflow_script")!;
	return { tool, tools, captured };
}

// ── zod refine: exactly one of workflowName|script ───────────
describe("runWorkflowScriptSchema refine", () => {
	it("rejects when NEITHER workflowName nor script is provided", () => {
		const r = runWorkflowScriptSchema.safeParse({});
		expect(r.success).toBe(false);
	});

	it("rejects when BOTH workflowName and script are provided", () => {
		const r = runWorkflowScriptSchema.safeParse({
			workflowName: "demo",
			script: "agent('hi')",
		});
		expect(r.success).toBe(false);
	});

	it("accepts workflowName only", () => {
		const r = runWorkflowScriptSchema.safeParse({ workflowName: "demo" });
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.wait).toBe(false); // default applied
	});

	it("accepts script only", () => {
		const r = runWorkflowScriptSchema.safeParse({ script: "agent('hi')" });
		expect(r.success).toBe(true);
	});
});

// ── Recursion-guard suppression by header ────────────────────
describe("shouldSuppressScriptTools", () => {
	it("suppresses when X-Wfb-Script-Depth is present", () => {
		expect(shouldSuppressScriptTools({ "x-wfb-script-depth": "1" })).toBe(true);
	});

	it("suppresses even when the header value is empty string", () => {
		expect(shouldSuppressScriptTools({ "x-wfb-script-depth": "" })).toBe(true);
	});

	it("does NOT suppress when the header is absent", () => {
		expect(shouldSuppressScriptTools({ "x-user-id": "u1" })).toBe(false);
	});
});

// ── run_workflow_script handler behaviour ─────────────────────
describe("script tools registration", () => {
	it("registers run + validate + spec tools", () => {
		const { tools } = getHandler();
		expect(tools.map((t) => t.name)).toEqual([
			"run_workflow_script",
			"validate_workflow_script",
			"get_workflow_script_spec",
		]);
	});

	it("handler validation rejects neither/both via the tool surface", async () => {
		const { tool } = getHandler({ fetchImpl: vi.fn() as any });
		const both = await tool.handler({ workflowName: "d", script: "x" });
		expect(both.isError).toBe(true);
		const neither = await tool.handler({});
		expect(neither.isError).toBe(true);
	});
});

// ── validate_workflow_script + get_workflow_script_spec ───────
describe("validate_workflow_script tool", () => {
	function getTool(name: string, ctx?: ScriptToolsContext) {
		const { server, captured } = fakeServer();
		registerScriptTools(server as any, ctx);
		return captured.find((t) => t.name === name)!;
	}

	it("rejects an empty script without calling the BFF", async () => {
		const fetchImpl = vi.fn();
		const tool = getTool("validate_workflow_script", { fetchImpl: fetchImpl as any });
		const res = await tool.handler({ script: "   " });
		expect(res.isError).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("forwards the script to the validate route and returns the result", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(200, { ok: true, meta: { name: "x" }, estimatedAgentCalls: 3 }),
			);
		const tool = getTool("validate_workflow_script", { fetchImpl: fetchImpl as any });
		const res = await tool.handler({ script: "export const meta = { name: 'x' }\nawait agent('hi')" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(String(url)).toContain("/api/internal/agent/workflows/validate-script");
		expect(JSON.parse((init as any).body).script).toContain("export const meta");
		expect(parseResult(res)).toEqual({ ok: true, meta: { name: "x" }, estimatedAgentCalls: 3 });
	});

	it("surfaces a validation failure body (ok:false) as a normal result", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { ok: false, error: "Date.now() is banned" }));
		const tool = getTool("validate_workflow_script", { fetchImpl: fetchImpl as any });
		const res = await tool.handler({ script: "Date.now()" });
		expect(res.isError).toBeUndefined();
		expect(parseResult(res)).toEqual({ ok: false, error: "Date.now() is banned" });
	});
});

describe("get_workflow_script_spec tool", () => {
	it("returns the dialect guide text with the platform deltas", async () => {
		const { server, captured } = fakeServer();
		registerScriptTools(server as any);
		const tool = captured.find((t) => t.name === "get_workflow_script_spec")!;
		const res = await tool.handler({});
		const text = res.content[0].text;
		expect(text).toContain("PLATFORM DELTAS");
		expect(text).toContain("agentType");
		expect(text).toContain("isolation");
	});
});

describe("run_workflow_script request body shape", () => {
	it("saved mode POSTs workflowName/triggerData/budgetTotal to the execute endpoint", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, {
				success: true,
				executionId: "exec-1",
				instanceId: "dsw-1",
				workflowId: "wf-1",
				workflowName: "demo",
				status: "running",
			}),
		);
		const { tool } = getHandler({ fetchImpl: fetchImpl as any });
		const res = await tool.handler({
			workflowName: "demo",
			args: { topic: "x" },
			budgetTotal: 500,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toMatch(/\/api\/internal\/agent\/workflows\/execute$/);
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>)["X-Internal-Token"]).toBe(
			"test-token",
		);
		expect(JSON.parse(init.body as string)).toEqual({
			workflowName: "demo",
			triggerData: { topic: "x" },
			budgetTotal: 500,
		});

		const out = parseResult(res);
		expect(out).toEqual({
			executionId: "exec-1",
			instanceId: "dsw-1",
			workflowId: "wf-1",
			status: "started",
		});
	});

	it("inline mode POSTs script/args/budgetTotal to the execute-script endpoint", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, {
				executionId: "exec-2",
				instanceId: "dsw-2",
				workflowId: "wf-2",
			}),
		);
		const { tool } = getHandler({ fetchImpl: fetchImpl as any });
		const res = await tool.handler({ script: "agent('hi')", args: {} });

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toMatch(/\/api\/internal\/agent\/workflows\/execute-script$/);
		// budgetTotal omitted → JSON.stringify drops the undefined key.
		expect(JSON.parse(init.body as string)).toEqual({
			script: "agent('hi')",
			args: {},
		});

		const out = parseResult(res);
		expect(out.status).toBe("started");
		expect(out.executionId).toBe("exec-2");
	});

	it("returns isError when the execute endpoint fails", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(400, { error: "bad" }));
		const { tool } = getHandler({ fetchImpl: fetchImpl as any });
		const res = await tool.handler({ workflowName: "demo" });
		expect(res.isError).toBe(true);
	});
});

describe("run_workflow_script wait mode", () => {
	it("polls the internal status route until terminal and returns status/output", async () => {
		const fetchImpl = vi
			.fn()
			// 1) start
			.mockResolvedValueOnce(
				jsonResponse(200, {
					executionId: "exec-9",
					instanceId: "dsw-9",
					workflowId: "wf-9",
					status: "running",
				}),
			)
			// 2) status: still running
			.mockResolvedValueOnce(
				jsonResponse(200, {
					status: "running",
					execution: { status: "running" },
				}),
			)
			// 3) status: terminal
			.mockResolvedValueOnce(
				jsonResponse(200, {
					status: "success",
					execution: { status: "success", output: { answer: 42 } },
				}),
			);

		const { tool } = getHandler({ fetchImpl: fetchImpl as any });
		const res = await tool.handler({ workflowName: "demo", wait: true });

		expect(fetchImpl).toHaveBeenCalledTimes(3);
		// The status polls hit the executions status route with the internal token.
		const [statusUrl, statusInit] = fetchImpl.mock.calls[1] as unknown as [
			string,
			RequestInit,
		];
		expect(statusUrl).toMatch(
			/\/api\/internal\/agent\/workflows\/executions\/exec-9\/status$/,
		);
		expect(
			(statusInit.headers as Record<string, string>)["X-Internal-Token"],
		).toBe("test-token");

		const out = parseResult(res);
		expect(out.status).toBe("success");
		expect(out.output).toEqual({ answer: 42 });
		expect(out.executionId).toBe("exec-9");
	});
});
