import { describe, expect, it, vi } from "vitest";
import {
	ApplicationActionOptionsError,
	ApplicationActionOptionsService,
	type ActionOptionsActionCatalogReader,
	type ActionOptionsCodeFunctionPort,
	type ActionOptionsConnectionReader,
	type ActionOptionsPieceClient,
} from "$lib/server/application/action-options";

function service(overrides: {
	actions?: Partial<ActionOptionsActionCatalogReader>;
	codeFunctions?: Partial<ActionOptionsCodeFunctionPort>;
	connections?: Partial<ActionOptionsConnectionReader>;
	pieces?: Partial<ActionOptionsPieceClient>;
} = {}) {
	const actions: ActionOptionsActionCatalogReader = {
		getActionDetail: vi.fn(async () => ({
			id: "github.create_issue",
			slug: "github/create_issue",
			serviceId: "activepieces",
			providerId: "github",
			group: "github",
			actionName: "create_issue",
			entrypoint: null,
			raw: { pieceName: "github", actionName: "create_issue" },
			auth: { required: true },
		})),
		...overrides.actions,
	};
	const codeFunctions: ActionOptionsCodeFunctionPort = {
		getCodeFunction: vi.fn(async () => ({
			id: "fn-1",
			slug: "hello",
			version: "v1",
		})),
		fetchOptions: vi.fn(async () => ({
			status: 202,
			payload: { options: [{ label: "A", value: "a" }] },
		})),
		...overrides.codeFunctions,
	};
	const connections: ActionOptionsConnectionReader = {
		getDecryptedConnection: vi.fn(async () => ({
			pieceName: "github",
			value: { token: "secret" },
		})),
		normalizePieceName: vi.fn((pieceName) => pieceName ?? ""),
		...overrides.connections,
	};
	const pieces: ActionOptionsPieceClient = {
		fetchOptions: vi.fn(async () => ({
			status: 200,
			payload: { options: [{ label: "Issue", value: 1 }] },
		})),
		...overrides.pieces,
	};
	return {
		actions,
		codeFunctions,
		connections,
		pieces,
		sut: new ApplicationActionOptionsService({
			actions,
			codeFunctions,
			connections,
			pieces,
		}),
	};
}

describe("ApplicationActionOptionsService", () => {
	it("delegates code-function options through the code-function port", async () => {
		const { sut, codeFunctions } = service();

		await expect(
			sut.getOptions({
				actionId: "code-function.fn-1",
				userId: "user-1",
				body: { param: "choice", input: { a: 1 }, searchValue: "abc" },
				requestUrl: "http://localhost/api/action-catalog/code-function.fn-1/options",
				cookie: "sid=123",
			}),
		).resolves.toEqual({
			status: 202,
			payload: { options: [{ label: "A", value: "a" }] },
		});
		expect(codeFunctions.getCodeFunction).toHaveBeenCalledWith("fn-1", "user-1");
		expect(codeFunctions.fetchOptions).toHaveBeenCalledWith({
			requestUrl: "http://localhost/api/action-catalog/code-function.fn-1/options",
			cookie: "sid=123",
			functionRef: { id: "fn-1", slug: "hello", version: "v1" },
			param: "choice",
			input: { a: 1 },
			searchValue: "abc",
		});
	});

	it("returns a disabled options response when auth is required before connection selection", async () => {
		const { sut, pieces } = service();

		await expect(
			sut.getOptions({
				actionId: "github.create_issue",
				userId: "user-1",
				body: { field: "repo", input: {} },
				requestUrl: "http://localhost",
				cookie: "",
			}),
		).resolves.toEqual({
			status: 200,
			payload: {
				options: [],
				disabled: true,
				placeholder: "Select a connection first",
			},
		});
		expect(pieces.fetchOptions).not.toHaveBeenCalled();
	});

	it("validates selected connection provider before invoking the piece service", async () => {
		const { sut } = service({
			connections: {
				getDecryptedConnection: vi.fn(async () => ({
					pieceName: "slack",
					value: {},
				})),
			},
		});

		await expect(
			sut.getOptions({
				actionId: "github.create_issue",
				userId: "user-1",
				body: {
					param: "repo",
					connectionExternalId: "conn-1",
					input: { auth: "connections['conn-1']" },
				},
				requestUrl: "http://localhost",
				cookie: "",
			}),
		).rejects.toMatchObject({
			status: 400,
			message: "Selected connection does not match this provider",
		} satisfies Partial<ApplicationActionOptionsError>);
	});

	it("maps unavailable piece runtimes to warming responses", async () => {
		const { sut } = service({
			pieces: {
				fetchOptions: vi.fn(async () => ({
					unavailable: true as const,
					message: "HTTP 503",
				})),
			},
		});

		await expect(
			sut.getOptions({
				actionId: "github.create_issue",
				userId: "user-1",
				body: {
					param: "repo",
					connectionExternalId: "conn-1",
					input: { auth: "connections['conn-1']" },
				},
				requestUrl: "http://localhost",
				cookie: "",
			}),
		).resolves.toEqual({
			status: 503,
			payload: {
				warming: true,
				options: [],
				error:
					'Piece service for "github" is unavailable (possibly cold-starting): HTTP 503',
			},
		});
	});
});
