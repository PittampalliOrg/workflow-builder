export type AgentSkillStatus = 'ENABLED' | 'DISABLED' | 'DRAFT';

export type AgentSkillSourceType = 'registry' | 'profile';

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
	sourceType: 'registry';
	installSource: string;
	skillName: string;
	installAgent: string;
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
