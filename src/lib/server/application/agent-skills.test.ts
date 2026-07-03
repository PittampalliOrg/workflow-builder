import { describe, expect, it, vi } from "vitest";
import type { AgentSkillRegistryEntry } from "$lib/agent-skill-presets";
import {
	AgentSkillServiceError,
	ApplicationAgentSkillService,
	type AgentSkillRepository,
} from "$lib/server/application/agent-skills";

describe("ApplicationAgentSkillService", () => {
	it("lists visible skills with the caller's management capability", async () => {
		const repository = fakeRepository();
		const service = new ApplicationAgentSkillService(repository);

		const result = await service.list({
			includeDisabled: true,
			userId: "user-1",
			projectId: "project-1",
		});

		expect(result).toEqual({ skills: [sampleSkill()], canManage: true });
		expect(repository.listAgentSkills).toHaveBeenCalledWith({
			includeDisabled: true,
			projectId: "project-1",
		});
		expect(repository.canManageAgentSkills).toHaveBeenCalledWith(
			"user-1",
			"project-1",
		);
	});

	it("normalizes custom skill create commands", async () => {
		const repository = fakeRepository();
		const service = new ApplicationAgentSkillService(repository);

		await service.createCustom({
			body: {
				name: "Skill",
				prompt: "Do the thing",
				allowedTools: ["shell", 42, "read"],
				description: "Useful",
			},
			userId: "user-1",
			projectId: "project-1",
		});

		expect(repository.createCustomSkill).toHaveBeenCalledWith({
			name: "Skill",
			slug: undefined,
			description: "Useful",
			whenToUse: null,
			prompt: "Do the thing",
			allowedTools: ["shell", "read"],
			argumentHint: null,
			model: null,
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("rejects custom skill commands without a workspace or required fields", async () => {
		const service = new ApplicationAgentSkillService(fakeRepository());

		await expect(
			service.createCustom({
				body: { name: "Skill", prompt: "Use it" },
				userId: "user-1",
				projectId: null,
			}),
		).rejects.toMatchObject({ status: 400, message: "No active workspace" });

		await expect(
			service.createCustom({
				body: { name: "", prompt: "Use it" },
				userId: "user-1",
				projectId: "project-1",
			}),
		).rejects.toMatchObject({ status: 400, message: "name is required" });
	});

	it("checks management capability before imports and status changes", async () => {
		const repository = fakeRepository();
		const service = new ApplicationAgentSkillService(repository);

		await service.importRegistrySkill({
			body: { installSource: "owner/repo", skillName: "skill" },
			userId: "user-1",
			projectId: "project-1",
		});
		await service.setStatus({
			id: "skill-1",
			status: "DISABLED",
			userId: "user-1",
			projectId: "project-1",
		});

		expect(repository.canManageAgentSkills).toHaveBeenCalledTimes(2);
		expect(repository.upsertAgentSkillMetadata).toHaveBeenCalledWith(
			{ installSource: "owner/repo", skillName: "skill" },
			"user-1",
		);
		expect(repository.setAgentSkillStatus).toHaveBeenCalledWith(
			"skill-1",
			"DISABLED",
		);
	});

	it("raises a typed forbidden error when the caller cannot manage skills", async () => {
		const repository = fakeRepository({ canManage: false });
		const service = new ApplicationAgentSkillService(repository);

		await expect(
			service.setStatus({
				id: "skill-1",
				status: "ENABLED",
				userId: "user-1",
				projectId: "project-1",
			}),
		).rejects.toBeInstanceOf(AgentSkillServiceError);
	});

	it("does not call the search port for blank queries", async () => {
		const repository = fakeRepository();
		const service = new ApplicationAgentSkillService(repository);

		await expect(service.search({ query: "  " })).resolves.toEqual([]);
		expect(repository.searchSkills).not.toHaveBeenCalled();
	});
});

function sampleSkill(): AgentSkillRegistryEntry {
	return {
		id: "skill-1",
		registryId: "skill-1",
		slug: "skill",
		name: "Skill",
		allowedTools: [],
		sourceType: "custom",
		sourceRepo: "custom",
		registryUrl: "https://skills.sh/custom/skill",
		installSource: "custom",
		skillName: "Skill",
		installAgent: "universal",
		version: "1",
		status: "ENABLED",
		projectId: "project-1",
		usedByCount: 0,
	};
}

function fakeRepository(options: { canManage?: boolean } = {}): AgentSkillRepository {
	const skill = sampleSkill();
	return {
		listAgentSkills: vi.fn(async () => [skill]),
		createCustomSkill: vi.fn(async () => skill),
		updateCustomSkill: vi.fn(async () => skill),
		deleteCustomSkill: vi.fn(async () => true),
		upsertAgentSkillMetadata: vi.fn(async () => skill),
		upsertCustomSkillFromZip: vi.fn(async () => skill),
		setAgentSkillStatus: vi.fn(async () => skill),
		searchSkills: vi.fn(async () => [skill]),
		canManageAgentSkills: vi.fn(async () => options.canManage ?? true),
	};
}
