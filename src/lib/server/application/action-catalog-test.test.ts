import { describe, expect, it, vi } from "vitest";
import {
	ApplicationActionCatalogTestService,
	type ActionCatalogHttpTestClient,
	type ActionCatalogTestAction,
	type ActionCatalogTestExecutionIdGenerator,
	type ActionCatalogTestReader,
} from "$lib/server/application/action-catalog-test";
import type {
	CodeFunctionExecutionRepository,
	FunctionRouterExecutionPort,
} from "$lib/server/application/code-function-execution";

const codeFunction = {
	id: "fn-1",
	name: "Hello",
	slug: "hello",
	version: "v3",
	language: "typescript",
	entrypoint: "main",
	path: "src/main.ts",
};

const activePiecesAction: ActionCatalogTestAction = {
	id: "github.create_issue",
	displayName: "Create issue",
	sw: {
		taskConfig: {
			call: "github/create_issue",
			with: {
				body: {
					input: {
						auth: "connections['conn-1']",
						owner: "octo",
					},
				},
			},
		},
		definition: null,
	},
};

function service(
	overrides: {
		actions?: Partial<ActionCatalogTestReader>;
		codeFunctions?: Partial<CodeFunctionExecutionRepository>;
		functionRouter?: Partial<FunctionRouterExecutionPort>;
		http?: Partial<ActionCatalogHttpTestClient>;
		ids?: Partial<ActionCatalogTestExecutionIdGenerator>;
	} = {},
) {
	const actions: ActionCatalogTestReader = {
		getActionDetail: vi.fn(async () => activePiecesAction),
		...overrides.actions,
	};
	const codeFunctions: CodeFunctionExecutionRepository = {
		getCodeFunction: vi.fn(async () => codeFunction),
		...overrides.codeFunctions,
	};
	const functionRouter: FunctionRouterExecutionPort = {
		execute: vi.fn(async () => ({
			ok: true,
			status: 200,
			payload: { success: true, data: { ok: true } },
		})),
		...overrides.functionRouter,
	};
	const http: ActionCatalogHttpTestClient = {
		execute: vi.fn(async () => ({
			ok: true,
			status: 200,
			payload: { message: "ok" },
		})),
		...overrides.http,
	};
	const ids: ActionCatalogTestExecutionIdGenerator = {
		nextExecutionId: vi.fn(() => "action-test-123"),
		...overrides.ids,
	};

	return {
		actions,
		codeFunctions,
		functionRouter,
		http,
		ids,
		sut: new ApplicationActionCatalogTestService({
			actions,
			codeFunctions,
			functionRouter,
			http,
			ids,
		}),
	};
}

describe("ApplicationActionCatalogTestService", () => {
	it("executes code-function actions through function-router ports", async () => {
		const { sut, codeFunctions, functionRouter } = service();

		await expect(
			sut.execute({
				actionId: "code-function.fn-1",
				userId: "user-1",
				body: { input: { name: "Ada" } },
			}),
		).resolves.toEqual({ success: true, data: { ok: true } });

		expect(codeFunctions.getCodeFunction).toHaveBeenCalledWith("fn-1", "user-1");
		expect(functionRouter.execute).toHaveBeenCalledWith({
			functionSlug: "code/hello",
			executionId: "action-test-123",
			workflowId: "action-catalog-test",
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
			connectionExternalId: undefined,
			maxRetries: 1,
		});
	});

	it("routes ActivePieces-style actions through function-router with merged input and connection reference", async () => {
		const { sut, actions, functionRouter } = service();

		await expect(
			sut.execute({
				actionId: "github.create_issue",
				userId: "user-1",
				body: { input: { repo: "workflow-builder" } },
			}),
		).resolves.toEqual({ success: true, data: { ok: true } });

		expect(actions.getActionDetail).toHaveBeenCalledWith(
			"github.create_issue",
			"user-1",
		);
		expect(functionRouter.execute).toHaveBeenCalledWith({
			functionSlug: "github/create_issue",
			executionId: "action-test-123",
			workflowId: "action-catalog-test",
			nodeId: "github.create_issue",
			nodeName: "Create issue",
			input: {
				auth: "connections['conn-1']",
				owner: "octo",
				repo: "workflow-builder",
			},
			connectionExternalId: "conn-1",
			maxRetries: 1,
		});
	});

	it("executes direct HTTP actions through the HTTP test port", async () => {
		const httpAction: ActionCatalogTestAction = {
			id: "http.post",
			displayName: "POST endpoint",
			raw: null,
			sw: {
				taskConfig: {
					call: "http",
					with: {
						endpoint: { uri: "https://example.test/webhook" },
						method: "post",
						headers: {
							Authorization: "Bearer token",
							Ignored: 123,
						},
						body: {
							input: {
								existing: true,
							},
						},
					},
				},
				definition: null,
			},
		};
		const { sut, http, functionRouter } = service({
			actions: { getActionDetail: vi.fn(async () => httpAction) },
		});

		await expect(
			sut.execute({
				actionId: "http.post",
				userId: "user-1",
				body: { input: { name: "Ada" } },
			}),
		).resolves.toEqual({
			success: true,
			data: { message: "ok" },
			duration_ms: 0,
		});

		expect(functionRouter.execute).not.toHaveBeenCalled();
		expect(http.execute).toHaveBeenCalledWith({
			uri: "https://example.test/webhook",
			method: "POST",
			headers: { Authorization: "Bearer token" },
			body: { input: { existing: true, name: "Ada" } },
		});
	});

	it("maps missing actions and unsupported direct calls to application errors", async () => {
		const missing = service({
			actions: { getActionDetail: vi.fn(async () => null) },
		}).sut;
		await expect(
			missing.execute({
				actionId: "missing",
				userId: "user-1",
				body: {},
			}),
		).rejects.toMatchObject({
			status: 404,
			message: "Action not found",
		});

		const unsupported = service({
			actions: {
				getActionDetail: vi.fn(async () => ({
					id: "grpc.call",
					displayName: "gRPC call",
					sw: { taskConfig: { call: "grpc", with: {} }, definition: null },
				})),
			},
		}).sut;
		await expect(
			unsupported.execute({
				actionId: "grpc.call",
				userId: "user-1",
				body: {},
			}),
		).rejects.toMatchObject({
			status: 400,
			message: "Direct test execution for grpc actions is not implemented",
		});
	});
});
