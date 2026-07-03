import { describe, expect, it, vi } from "vitest";
import {
	ApplicationCodeFunctionExecutionService,
	type CodeFunctionExecutionRepository,
	type FunctionRouterExecutionPort,
} from "$lib/server/application/code-function-execution";

const detail = {
	id: "fn-1",
	name: "Hello",
	slug: "hello",
	version: "v3",
	language: "typescript",
	entrypoint: "main",
	path: "src/main.ts",
};

describe("ApplicationCodeFunctionExecutionService", () => {
	it("builds the function-router preview payload through ports", async () => {
		const codeFunctions: CodeFunctionExecutionRepository = {
			getCodeFunction: vi.fn(async () => detail),
		};
		const functionRouter: FunctionRouterExecutionPort = {
			execute: vi.fn(async () => ({
				ok: true,
				status: 200,
				payload: { success: true, data: { ok: true } },
			})),
		};
		const service = new ApplicationCodeFunctionExecutionService({
			codeFunctions,
			functionRouter,
			ids: { nextExecutionId: vi.fn(() => "code-preview-fn-1-123") },
		});

		await expect(
			service.execute({
				id: "fn-1",
				userId: "user-1",
				body: { input: { name: "Ada" } },
			}),
		).resolves.toEqual({ success: true, data: { ok: true } });
		expect(codeFunctions.getCodeFunction).toHaveBeenCalledWith("fn-1", "user-1");
		expect(functionRouter.execute).toHaveBeenCalledWith({
			functionSlug: "code/hello",
			executionId: "code-preview-fn-1-123",
			workflowId: "code-function-preview",
			nodeId: "code-function-fn-1",
			nodeName: "Hello",
			input: {
				functionRef: {
					id: "fn-1",
					slug: "hello",
					version: "v3",
				},
				body: {
					input: { name: "Ada" },
					metadata: {
						sourceKind: "code",
						codeFunctionId: "fn-1",
						slug: "hello",
						version: "v3",
						language: "typescript",
						entrypoint: "main",
						path: "src/main.ts",
					},
				},
			},
		});
	});

	it("maps missing code functions and router failures to application errors", async () => {
		const missing = new ApplicationCodeFunctionExecutionService({
			codeFunctions: { getCodeFunction: vi.fn(async () => null) },
			functionRouter: {
				execute: vi.fn(async () => ({ ok: true, status: 200, payload: {} })),
			},
			ids: { nextExecutionId: vi.fn(() => "unused") },
		});
		await expect(
			missing.execute({ id: "missing", userId: "user-1", body: {} }),
		).rejects.toMatchObject({
			status: 404,
			message: "Code function not found",
		});

		const failing = new ApplicationCodeFunctionExecutionService({
			codeFunctions: { getCodeFunction: vi.fn(async () => detail) },
			functionRouter: {
				execute: vi.fn(async () => ({
					ok: false,
					status: 502,
					payload: { error: "router unavailable" },
				})),
			},
			ids: { nextExecutionId: vi.fn(() => "code-preview-fn-1-123") },
		});
		await expect(
			failing.execute({ id: "fn-1", userId: "user-1", body: {} }),
		).rejects.toMatchObject({
			status: 502,
			message: "router unavailable",
		});
	});
});
