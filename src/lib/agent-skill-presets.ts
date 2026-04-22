export type AgentSkillStatus = 'ENABLED' | 'DISABLED' | 'DRAFT';

export type AgentSkillSourceType = 'registry' | 'profile' | 'custom';

export type AgentSkillConfig = {
	name: string;
	description?: string;
	whenToUse?: string;
	allowedTools?: string[];
	sourceType?: AgentSkillSourceType;
	registryId?: string;
	slug?: string;
	version?: string;
	sourceRepo?: string;
	sourceRef?: string;
	skillPath?: string;
	registryUrl?: string;
	installSource?: string;
	skillName?: string;
	installAgent?: string;
	status?: AgentSkillStatus;
};

export type AgentSkillRegistryEntry = AgentSkillConfig & {
	id: string;
	slug: string;
	status: AgentSkillStatus;
	sourceType: 'registry' | 'custom';
	installSource: string;
	skillName: string;
	installAgent: string;
	projectId?: string | null;
	createdByUserId?: string | null;
	prompt?: string;
	/** Bundled-asset count from packageManifest.files (paths only listed in packageFiles). */
	packageFilesCount?: number;
	/** Paths of materialized assets (no content — content is only sent to the sandbox at session-start). */
	packageFiles?: { path: string }[];
	/** Number of current-version agents (in the caller's workspace + globals) that attach this skill. */
	usedByCount?: number;
};

export function profileSkillSnapshot(skill: AgentSkillConfig): AgentSkillConfig {
	return {
		...skill,
		sourceType: 'profile',
		registryId: skill.registryId || ('id' in skill ? String(skill.id) : undefined),
		slug: skill.slug || skill.name,
		installSource: skill.installSource || skill.sourceRepo || '',
		skillName: skill.skillName || skill.name,
		installAgent: skill.installAgent || 'universal'
	};
}
