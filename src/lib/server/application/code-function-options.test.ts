import { describe, expect, it, vi } from "vitest";
import {
	ApplicationCodeFunctionOptionsService,
	type CodeFunctionOptionsDetail,
	type CodeFunctionOptionsRepository,
	type CodeFunctionOptionsRuntimeClient,
} from "$lib/server/application/code-function-options";

const detail: CodeFunctionOptionsDetail = {
	id: "fn-1",
	slug: "calendar-tools",
	version: "draft",
	latestPublishedVersion: "pub-latest",
	language: "typescript",
	source: "export async function listCalendars() {}",
	path: "src/index.ts",
	supportingFiles: { "src/support.ts": "export const x = 1;" },
	model: {
		language: "typescript",
		imports: [
			{ kind: "external", specifier: "npm:@microsoft/microsoft-graph-client" },
			{ kind: "external", specifier: "lodash/fp" },
			{ kind: "external", specifier: "node:fs" },
			{ kind: "relative", specifier: "./support" },
		],
		dynamic_inputs: [{ name: "calendar", handler: "listCalendars" }],
	},
};

function service(overrides: {
	codeFunctions?: Partial<CodeFunctionOptionsRepository>;
	runtime?: Partial<CodeFunctionOptionsRuntimeClient>;
} = {}) {
	const codeFunctions: CodeFunctionOptionsRepository = {
		getById: vi.fn(async () => detail),
		getBySlug: vi.fn(async () => detail),
		...overrides.codeFunctions,
	};
	const runtime: CodeFunctionOptionsRuntimeClient = {
		fetchOptions: vi.fn(async () => ({
			ok: true,
			status: 200,
			payload: {
				options: [
					{ label: "Primary", value: "primary" },
					{ name: "By name", id: "named" },
					"literal",
				],
				disabled: true,
				placeholder: "Pick one",
			},
		})),
		...overrides.runtime,
	};

	return {
		codeFunctions,
		runtime,
		sut: new ApplicationCodeFunctionOptionsService({
			codeFunctions,
			runtime,
		}),
	};
}

describe("ApplicationCodeFunctionOptionsService", () => {
	it("resolves dynamic options by slug and invokes the code runtime through ports", async () => {
		const { sut, codeFunctions, runtime } = service();

		await expect(
			sut.getOptions({
				userId: "user-1",
				body: {
					functionRef: {
						slug: "calendar-tools",
						version: "pub-latest",
					},
					param: "calendar",
					input: { auth: "conn-1" },
					search_value: "work",
				},
			}),
		).resolves.toEqual({
			options: [
				{ label: "Primary", value: "primary" },
				{ label: "By name", value: "named" },
				{ label: "literal", value: "literal" },
			],
			disabled: true,
			placeholder: "Pick one",
		});

		expect(codeFunctions.getBySlug).toHaveBeenCalledWith(
			"calendar-tools",
			"pub-latest",
			"user-1",
		);
		expect(runtime.fetchOptions).toHaveBeenCalledWith({
			language: "typescript",
			source: "export async function listCalendars() {}",
			handler: "listCalendars",
			path: "src/index.ts",
			supportingFiles: { "src/support.ts": "export const x = 1;" },
			input: { auth: "conn-1" },
			dependencies: ["@microsoft/microsoft-graph-client", "lodash"],
			searchValue: "work",
		});
	});

	it("falls back from id lookup to the requested version when it differs from the draft and latest published version", async () => {
		const { sut, codeFunctions } = service({
			codeFunctions: {
				getById: vi.fn(async () => detail),
				getBySlug: vi.fn(async () => ({
					...detail,
					version: "pub-old",
				})),
			},
		});

		await sut.getOptions({
			userId: "user-1",
			body: {
				functionRef: {
					id: "fn-1",
					version: "pub-old",
				},
				param: "calendar",
				input: {},
			},
		});

		expect(codeFunctions.getById).toHaveBeenCalledWith("fn-1", "user-1");
		expect(codeFunctions.getBySlug).toHaveBeenCalledWith(
			"calendar-tools",
			"pub-old",
			"user-1",
		);
	});

	it("normalizes raw array runtime responses", async () => {
		const { sut } = service({
			runtime: {
				fetchOptions: vi.fn(async () => ({
					ok: true,
					status: 200,
					payload: ["one", "two"],
				})),
			},
		});

		await expect(
			sut.getOptions({
				userId: "user-1",
				body: {
					functionRef: { id: "fn-1" },
					param: "calendar",
				},
			}),
		).resolves.toEqual({
			options: [
				{ label: "one", value: "one" },
				{ label: "two", value: "two" },
			],
		});
	});

	it("maps missing handlers and runtime failures to application errors", async () => {
		const missingHandler = service({
			codeFunctions: {
				getById: vi.fn(async () => ({
					...detail,
					model: { ...detail.model, dynamic_inputs: [] },
				})),
			},
		}).sut;
		await expect(
			missingHandler.getOptions({
				userId: "user-1",
				body: { functionRef: { id: "fn-1" }, param: "calendar" },
			}),
		).rejects.toMatchObject({
			status: 404,
			message: 'No dynamic options handler configured for "calendar"',
		});

		const failingRuntime = service({
			runtime: {
				fetchOptions: vi.fn(async () => ({
					ok: false,
					status: 502,
					payload: { error: "runtime unavailable" },
				})),
			},
		}).sut;
		await expect(
			failingRuntime.getOptions({
				userId: "user-1",
				body: { functionRef: { id: "fn-1" }, param: "calendar" },
			}),
		).rejects.toMatchObject({
			status: 502,
			message: "runtime unavailable",
		});
	});
});
