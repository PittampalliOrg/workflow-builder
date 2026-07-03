import { describe, expect, it, vi } from "vitest";
import {
	ApplicationCodeFunctionManagementService,
	type CodeFunctionDetail,
	type CodeFunctionManagementRepository,
} from "$lib/server/application/code-function-management";

const detail: CodeFunctionDetail = {
	id: "fn-1",
	name: "Hello",
	slug: "hello",
	description: null,
	version: "0.1.0",
	language: "typescript",
	entrypoint: "main",
	path: null,
	updatedAt: "2026-01-01T00:00:00.000Z",
	createdAt: "2026-01-01T00:00:00.000Z",
	isEnabled: true,
	hasDiagnostics: false,
	latestPublishedVersion: null,
	lastPublishedAt: null,
	source: "export function main() {}",
	supportingFiles: {},
	sourceHash: "abc",
	model: { language: "typescript" },
	revisions: [],
};

describe("ApplicationCodeFunctionManagementService", () => {
	it("delegates list and get through the repository port", async () => {
		const repository = createRepository({
			list: vi.fn(async () => [detail]),
			get: vi.fn(async () => detail),
		});
		const service = new ApplicationCodeFunctionManagementService(repository);

		await expect(service.list({ userId: "user-1" })).resolves.toEqual([
			detail,
		]);
		await expect(
			service.get({ id: "fn-1", userId: "user-1" }),
		).resolves.toEqual(detail);
		expect(repository.list).toHaveBeenCalledWith("user-1");
		expect(repository.get).toHaveBeenCalledWith("fn-1", "user-1");
	});

	it("normalizes create and update request bodies before calling the port", async () => {
		const repository = createRepository({
			create: vi.fn(async () => detail),
			update: vi.fn(async () => detail),
		});
		const service = new ApplicationCodeFunctionManagementService(repository);
		const body = {
			name: "Hello",
			description: 123,
			language: "typescript",
			entrypoint: "main",
			path: undefined,
			source: "export function main() {}",
			supportingFiles: { "dep.ts": "export const dep = 1;", ignored: 42 },
		};

		await service.create({ userId: "user-1", body });
		await service.update({ id: "fn-1", userId: "user-1", body });

		const expectedCommand = {
			name: "Hello",
			description: null,
			language: "typescript",
			entrypoint: "main",
			path: null,
			source: "export function main() {}",
			supportingFiles: { "dep.ts": "export const dep = 1;" },
		};
		expect(repository.create).toHaveBeenCalledWith(expectedCommand, "user-1");
		expect(repository.update).toHaveBeenCalledWith(
			"fn-1",
			expectedCommand,
			"user-1",
		);
	});

	it("returns success for deletes and maps missing items to 404", async () => {
		const repository = createRepository({
			delete: vi.fn(async () => true),
			publish: vi.fn(async () => null),
		});
		const service = new ApplicationCodeFunctionManagementService(repository);

		await expect(
			service.delete({ id: "fn-1", userId: "user-1" }),
		).resolves.toEqual({ success: true });
		await expect(
			service.publish({ id: "missing", userId: "user-1" }),
		).rejects.toMatchObject({
			status: 404,
			message: "Code function not found",
		});
	});

	it("validates save bodies and maps repository infrastructure failures", async () => {
		const service = new ApplicationCodeFunctionManagementService(
			createRepository({
				list: vi.fn(async () => {
					throw new Error("Database not configured");
				}),
			}),
		);

		await expect(
			service.create({
				userId: "user-1",
				body: { name: "", language: "typescript", source: "" },
			}),
		).rejects.toMatchObject({
			status: 400,
			message: "name and source must not be empty",
		});
		await expect(service.list({ userId: "user-1" })).rejects.toMatchObject({
			status: 503,
			message: "Database not configured",
		});
	});
});

function createRepository(
	overrides: Partial<CodeFunctionManagementRepository> = {},
): CodeFunctionManagementRepository {
	return {
		list: vi.fn(async () => []),
		get: vi.fn(async () => null),
		create: vi.fn(async () => detail),
		update: vi.fn(async () => null),
		delete: vi.fn(async () => false),
		publish: vi.fn(async () => null),
		...overrides,
	};
}
