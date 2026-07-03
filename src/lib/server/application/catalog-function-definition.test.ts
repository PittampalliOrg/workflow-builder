import { describe, expect, it, vi } from "vitest";
import {
	ApplicationCatalogFunctionDefinitionService,
	type CatalogFunctionDefinitionReader,
} from "$lib/server/application/catalog-function-definition";

function service(overrides: Partial<CatalogFunctionDefinitionReader> = {}) {
	const reader: CatalogFunctionDefinitionReader = {
		getCodeFunctionDefinition: vi.fn(async () => ({
			sourceKind: "code",
			call: "code/calendar-tools",
		})),
		getPieceFunctionDefinition: vi.fn(async () => ({
			call: "github/create_issue",
		})),
		...overrides,
	};
	return {
		reader,
		sut: new ApplicationCatalogFunctionDefinitionService(reader),
	};
}

describe("ApplicationCatalogFunctionDefinitionService", () => {
	it("returns the user code-function definition before checking the piece catalog", async () => {
		const { sut, reader } = service();

		await expect(
			sut.getDefinition({
				name: "calendar-tools",
				version: "pub-1",
				userId: "user-1",
			}),
		).resolves.toEqual({
			sourceKind: "code",
			call: "code/calendar-tools",
		});

		expect(reader.getCodeFunctionDefinition).toHaveBeenCalledWith({
			name: "calendar-tools",
			version: "pub-1",
			userId: "user-1",
		});
		expect(reader.getPieceFunctionDefinition).not.toHaveBeenCalled();
	});

	it("falls back to piece catalog definitions when no user code function matches", async () => {
		const { sut, reader } = service({
			getCodeFunctionDefinition: vi.fn(async () => null),
		});

		await expect(
			sut.getDefinition({
				name: "github/create_issue",
				version: "1.0.0",
				userId: "user-1",
			}),
		).resolves.toEqual({
			call: "github/create_issue",
		});

		expect(reader.getPieceFunctionDefinition).toHaveBeenCalledWith(
			"github/create_issue",
		);
	});

	it("maps missing piece definitions and piece lookup failures to application errors", async () => {
		const missing = service({
			getCodeFunctionDefinition: vi.fn(async () => null),
			getPieceFunctionDefinition: vi.fn(async () => null),
		}).sut;
		await expect(
			missing.getDefinition({
				name: "missing",
				version: "1.0.0",
				userId: null,
			}),
		).rejects.toMatchObject({
			status: 404,
			message: "Function not found",
		});

		const failing = service({
			getCodeFunctionDefinition: vi.fn(async () => null),
			getPieceFunctionDefinition: vi.fn(async () => {
				throw new Error("metadata unavailable");
			}),
		}).sut;
		await expect(
			failing.getDefinition({
				name: "github/create_issue",
				version: "1.0.0",
				userId: null,
			}),
		).rejects.toMatchObject({
			status: 502,
			message: "Error: metadata unavailable",
		});
	});
});
