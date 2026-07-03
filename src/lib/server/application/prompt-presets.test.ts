import { describe, expect, it, vi } from "vitest";
import type { PromptPresetSummary } from "$lib/types/prompt-presets";
import {
	ApplicationPromptPresetService,
	ApplicationPromptStackCompilerService,
	type PromptPresetRepository,
	type PromptStackPresetReadPort,
} from "$lib/server/application/prompt-presets";

const preset: PromptPresetSummary = {
	id: "preset-1",
	name: "Review",
	title: "Review",
	description: null,
	version: 1,
	isEnabled: true,
	metadata: null,
	userId: "user-1",
	projectId: "project-1",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	latestVersion: null,
};

describe("ApplicationPromptPresetService", () => {
	it("routes prompt preset list/create/update/archive through a repository port", async () => {
		const repository: PromptPresetRepository = {
			list: vi.fn(async () => [preset]),
			create: vi.fn(async () => preset),
			update: vi.fn(async () => ({ ...preset, name: "Updated" })),
			archive: vi.fn(async () => true),
		};
		const service = new ApplicationPromptPresetService(repository);

		await expect(
			service.list({ projectId: "project-1", includeDisabled: true }),
		).resolves.toEqual({ presets: [preset] });
		await expect(
			service.create({
				projectId: "project-1",
				userId: "user-1",
				body: { name: "Review" },
			}),
		).resolves.toEqual({ preset });
		await expect(
			service.update({
				id: "preset-1",
				projectId: "project-1",
				userId: "user-1",
				body: { name: "Updated" },
			}),
		).resolves.toEqual({ preset: { ...preset, name: "Updated" } });
		await expect(
			service.archive({ id: "preset-1", projectId: "project-1" }),
		).resolves.toEqual({ archived: true });

		expect(repository.list).toHaveBeenCalledWith({
			projectId: "project-1",
			includeDisabled: true,
		});
		expect(repository.create).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			body: { name: "Review" },
		});
		expect(repository.update).toHaveBeenCalledWith({
			id: "preset-1",
			projectId: "project-1",
			userId: "user-1",
			body: { name: "Updated" },
		});
		expect(repository.archive).toHaveBeenCalledWith({
			id: "preset-1",
			projectId: "project-1",
		});
	});

	it("maps missing update/archive results to null response models", async () => {
		const repository: PromptPresetRepository = {
			list: vi.fn(async () => []),
			create: vi.fn(async () => preset),
			update: vi.fn(async () => null),
			archive: vi.fn(async () => false),
		};
		const service = new ApplicationPromptPresetService(repository);

		await expect(
			service.update({
				id: "missing",
				projectId: "project-1",
				userId: "user-1",
				body: {},
			}),
		).resolves.toBeNull();
		await expect(
			service.archive({ id: "missing", projectId: "project-1" }),
		).resolves.toBeNull();
	});
});

describe("ApplicationPromptStackCompilerService", () => {
	it("returns an empty stack without hitting the read port when no refs are configured", async () => {
		const readPort: PromptStackPresetReadPort = {
			listPromptStackPresetRows: vi.fn(async () => []),
		};
		const service = new ApplicationPromptStackCompilerService(readPort);

		await expect(
			service.compilePromptStack(
				{ modelSpec: "openai/gpt-5.5" },
				{ projectId: "project-1" },
			),
		).resolves.toEqual({
			static: [],
			dynamic: [],
			staticManifest: [],
			dynamicManifest: [],
		});

		expect(readPort.listPromptStackPresetRows).not.toHaveBeenCalled();
	});

	it("fetches unique prompt ids through the read port and resolves ordered static/dynamic stacks", async () => {
		const readPort: PromptStackPresetReadPort = {
			listPromptStackPresetRows: vi.fn(async () => [
				{
					promptId: "preset-b",
					version: 2,
					messages: [{ role: "system", content: "Static B" }],
					promptVersionId: "version-b2",
					mlflowUri: "models:/preset-b/2",
				},
				{
					promptId: "preset-a",
					version: 1,
					messages: [{ role: "system", content: "Static A" }],
					promptVersionId: "version-a1",
					mlflowUri: null,
				},
			]),
		};
		const service = new ApplicationPromptStackCompilerService(readPort);

		const stack = await service.compilePromptStack(
			{
				staticPromptPresetRefs: [
					{ id: "preset-a", version: 1 },
					{ id: "preset-b", version: 2 },
				],
				dynamicPromptPresetRefs: [{ id: "preset-a", version: 1 }],
			},
			{ projectId: "project-1" },
		);

		expect(readPort.listPromptStackPresetRows).toHaveBeenCalledWith({
			projectId: "project-1",
			promptIds: ["preset-a", "preset-b"],
		});
		expect(stack).toEqual({
			static: ["Static A", "Static B"],
			dynamic: ["Static A"],
			staticManifest: [
				{
					promptId: "preset-a",
					version: 1,
					promptVersionId: "version-a1",
					mlflowUri: null,
				},
				{
					promptId: "preset-b",
					version: 2,
					promptVersionId: "version-b2",
					mlflowUri: "models:/preset-b/2",
				},
			],
			dynamicManifest: [
				{
					promptId: "preset-a",
					version: 1,
					promptVersionId: "version-a1",
					mlflowUri: null,
				},
			],
		});
	});
});
