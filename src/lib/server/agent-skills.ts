import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type {
	AgentSkillRegistryEntry,
	AgentSkillStatus
} from '$lib/agent-skill-presets';
import { db } from '$lib/server/db';
import { agentSkillRegistry, projectMembers, users } from '$lib/server/db/schema';

const execFileAsync = promisify(execFile);
const SKILLS_CLI_PACKAGE = 'skills@1.5.0';
const DEFAULT_INSTALL_AGENT = 'universal';
const SKILLS_CLI_HOME = `${tmpdir()}/workflow-builder-skills`;

export type SkillMetadataInput = {
	name?: string;
	description?: string;
	source?: string;
	sourceRepo?: string;
	installSource?: string;
	skillName?: string;
	slug?: string;
	registryUrl?: string;
	sourceRef?: string;
	version?: string;
	status?: AgentSkillStatus;
	installAgent?: string;
};

function slugify(value: unknown): string {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

function stripAnsi(value: string): string {
	return value
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
		.replace(/\u001b\?[0-9;]*[a-zA-Z]/g, '');
}

function skillStatus(value: unknown): AgentSkillStatus {
	return value === 'ENABLED' || value === 'DISABLED' || value === 'DRAFT' ? value : 'ENABLED';
}

function defaultSkillSlug(installSource: string, skillName: string): string {
	return slugify(`${installSource}-${skillName}`);
}

function normalizeInstallSource(value: unknown): string {
	return String(value || '')
		.trim()
		.replace(/^https:\/\/github\.com\//, '')
		.replace(/^https:\/\/skills\.sh\//, '')
		.replace(/\/+$/, '');
}

function registryUrl(source: string, skillName: string, explicit?: string): string {
	if (explicit && explicit.trim()) return explicit.trim();
	return `https://skills.sh/${source}/${encodeURIComponent(skillName)}`;
}

function rowToSkill(row: typeof agentSkillRegistry.$inferSelect): AgentSkillRegistryEntry {
	const installSource = normalizeInstallSource(row.installSource || row.sourceRepo);
	const skillName = String(row.skillName || row.name || row.slug).trim();
	const isCustom = row.sourceType === 'custom';
	return {
		id: row.id,
		registryId: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description || undefined,
		whenToUse: row.whenToUse || row.description || undefined,
		allowedTools: Array.isArray(row.allowedTools) ? row.allowedTools : [],
		sourceType: isCustom ? 'custom' : 'registry',
		sourceRepo: installSource,
		sourceRef: row.sourceRef || undefined,
		skillPath: row.skillPath || undefined,
		version: row.version,
		registryUrl: registryUrl(installSource || 'custom', skillName, row.registryUrl || undefined),
		installSource: installSource || 'custom',
		skillName,
		installAgent: row.installAgent || DEFAULT_INSTALL_AGENT,
		status: row.status,
		projectId: row.projectId ?? null,
		createdByUserId: row.createdByUserId ?? null,
		prompt: row.prompt ?? undefined
	};
}

export async function listAgentSkills(options: {
	includeDisabled?: boolean;
	projectId?: string | null;
} = {}) {
	if (!db) return [];
	// Global curated rows (project_id IS NULL) are visible to everyone; custom
	// rows are only visible inside their owning workspace.
	const scopeFilter = options.projectId
		? or(
				isNull(agentSkillRegistry.projectId),
				eq(agentSkillRegistry.projectId, options.projectId),
			)
		: isNull(agentSkillRegistry.projectId);

	const rows = await db
		.select()
		.from(agentSkillRegistry)
		.where(scopeFilter)
		.orderBy(asc(agentSkillRegistry.name));
	return rows
		.map(rowToSkill)
		.filter((skill) => options.includeDisabled || skill.status === 'ENABLED');
}

export type CustomSkillCreateInput = {
	name: string;
	slug?: string;
	description?: string | null;
	whenToUse?: string | null;
	prompt: string;
	allowedTools?: string[];
	argumentHint?: string | null;
	model?: string | null;
	projectId: string;
	userId: string;
};

export async function createCustomSkill(input: CustomSkillCreateInput) {
	if (!db) throw new Error('Database is not configured');
	const name = input.name.trim();
	if (!name) throw new Error('name is required');
	const prompt = input.prompt.trim();
	if (!prompt) throw new Error('prompt is required');

	const slug = slugify(input.slug || name);
	if (!slug) throw new Error('name must produce a valid slug');

	const allowedTools = Array.isArray(input.allowedTools)
		? input.allowedTools.filter((t) => typeof t === 'string' && t.trim().length > 0)
		: [];

	const contentHash = `custom:${slug}:${Date.now()}`;

	const [row] = await db
		.insert(agentSkillRegistry)
		.values({
			slug,
			name,
			description: input.description?.trim() || null,
			whenToUse: input.whenToUse?.trim() || null,
			prompt,
			allowedTools,
			arguments: [],
			argumentHint: input.argumentHint?.trim() || null,
			model: input.model?.trim() || null,
			userInvocable: true,
			disableModelInvocation: false,
			sourceType: 'custom',
			sourceRepo: null,
			sourceRef: null,
			skillPath: null,
			registryUrl: null,
			installSource: null,
			skillName: name,
			installAgent: DEFAULT_INSTALL_AGENT,
			version: '1',
			contentHash,
			license: null,
			compatibility: null,
			packageManifest: null,
			status: 'ENABLED',
			createdByUserId: input.userId,
			projectId: input.projectId
		})
		.returning();

	return rowToSkill(row);
}

export type CustomSkillUpdateInput = {
	name?: string;
	description?: string | null;
	whenToUse?: string | null;
	prompt?: string;
	allowedTools?: string[];
	argumentHint?: string | null;
	model?: string | null;
	status?: AgentSkillStatus;
};

export function bumpVersion(current: string | null | undefined): string {
	const n = Number.parseInt((current ?? '1').trim(), 10);
	if (Number.isFinite(n) && n > 0) return String(n + 1);
	// Non-numeric (e.g. "latest") — fall back to "1" so numeric bumps apply next.
	return '2';
}

export async function updateCustomSkill(
	id: string,
	input: CustomSkillUpdateInput,
	opts: { userId: string; projectId: string },
) {
	if (!db) throw new Error('Database is not configured');
	const [existing] = await db
		.select()
		.from(agentSkillRegistry)
		.where(eq(agentSkillRegistry.id, id))
		.limit(1);
	if (!existing) throw new Error('Skill not found');
	if (existing.sourceType !== 'custom') {
		throw new Error('Only custom skills are editable by users');
	}
	if (existing.projectId !== opts.projectId) {
		throw new Error('Skill belongs to another workspace');
	}

	const patch: Partial<typeof agentSkillRegistry.$inferInsert> & {
		updatedAt: Date;
	} = { updatedAt: new Date() };
	let promptChanged = false;

	if (input.name !== undefined) patch.name = input.name.trim();
	if (input.description !== undefined) patch.description = input.description?.trim() || null;
	if (input.whenToUse !== undefined) patch.whenToUse = input.whenToUse?.trim() || null;
	if (typeof input.prompt === 'string' && input.prompt.trim() !== existing.prompt) {
		patch.prompt = input.prompt.trim();
		promptChanged = true;
	}
	if (input.allowedTools !== undefined) {
		patch.allowedTools = input.allowedTools.filter(
			(t) => typeof t === 'string' && t.trim().length > 0,
		);
	}
	if (input.argumentHint !== undefined)
		patch.argumentHint = input.argumentHint?.trim() || null;
	if (input.model !== undefined) patch.model = input.model?.trim() || null;
	if (input.status && ['ENABLED', 'DISABLED', 'DRAFT'].includes(input.status)) {
		patch.status = input.status;
	}

	if (promptChanged) {
		patch.version = bumpVersion(existing.version);
		patch.contentHash = `custom:${existing.slug}:${Date.now()}`;
	}

	const [row] = await db
		.update(agentSkillRegistry)
		.set(patch)
		.where(eq(agentSkillRegistry.id, id))
		.returning();
	return rowToSkill(row);
}

export async function deleteCustomSkill(
	id: string,
	opts: { projectId: string },
): Promise<boolean> {
	if (!db) throw new Error('Database is not configured');
	const [existing] = await db
		.select()
		.from(agentSkillRegistry)
		.where(eq(agentSkillRegistry.id, id))
		.limit(1);
	if (!existing) return false;
	if (existing.sourceType !== 'custom' || existing.projectId !== opts.projectId) {
		throw new Error('Custom skill not found in this workspace');
	}
	const [row] = await db
		.delete(agentSkillRegistry)
		.where(eq(agentSkillRegistry.id, id))
		.returning({ id: agentSkillRegistry.id });
	return Boolean(row);
}

export async function upsertAgentSkillMetadata(input: SkillMetadataInput, userId: string) {
	if (!db) throw new Error('Database is not configured');
	const installSource = normalizeInstallSource(input.installSource || input.source || input.sourceRepo);
	const skillName = String(input.skillName || input.name || '').trim();
	if (!installSource) throw new Error('Skill install source is required');
	if (!skillName) throw new Error('Skill name is required');
	const slug = slugify(input.slug || defaultSkillSlug(installSource, skillName));
	if (!slug) throw new Error('Skill name must produce a valid slug');
	const status = skillStatus(input.status);
	const version = String(input.version || input.sourceRef || 'latest').trim() || 'latest';

	const values = {
		slug,
		name: skillName,
		description: input.description?.trim() || null,
		whenToUse: input.description?.trim() || null,
		prompt: '',
		allowedTools: [],
		arguments: [],
		argumentHint: null,
		model: null,
		userInvocable: true,
		disableModelInvocation: false,
		sourceType: 'registry' as const,
		sourceRepo: installSource,
		sourceRef: input.sourceRef || null,
		skillPath: skillName,
		registryUrl: registryUrl(installSource, skillName, input.registryUrl),
		installSource,
		skillName,
		installAgent: input.installAgent || DEFAULT_INSTALL_AGENT,
		version,
		contentHash: `metadata:${installSource}@${skillName}:${version}`,
		license: null,
		compatibility: null,
		packageManifest: null,
		status,
		createdByUserId: userId
	};

	const [row] = await db
		.insert(agentSkillRegistry)
		.values(values)
		.onConflictDoUpdate({
			target: agentSkillRegistry.slug,
			set: {
				slug: values.slug,
				name: values.name,
				description: values.description,
				whenToUse: values.whenToUse,
				prompt: values.prompt,
				allowedTools: values.allowedTools,
				arguments: values.arguments,
				argumentHint: values.argumentHint,
				model: values.model,
				userInvocable: values.userInvocable,
				disableModelInvocation: values.disableModelInvocation,
				sourceType: values.sourceType,
				sourceRepo: values.sourceRepo,
				sourceRef: values.sourceRef,
				skillPath: values.skillPath,
				registryUrl: values.registryUrl,
				installSource: values.installSource,
				skillName: values.skillName,
				installAgent: values.installAgent,
				version: values.version,
				contentHash: values.contentHash,
				license: values.license,
				compatibility: values.compatibility,
				packageManifest: values.packageManifest,
				status: values.status,
				updatedAt: new Date()
			}
		})
		.returning();

	return rowToSkill(row);
}

export const importAgentSkill = upsertAgentSkillMetadata;

export async function setAgentSkillStatus(idOrSlug: string, status: AgentSkillStatus) {
	if (!db) throw new Error('Database is not configured');
	const [row] = await db
		.update(agentSkillRegistry)
		.set({ status, updatedAt: new Date() })
		.where(eq(agentSkillRegistry.id, idOrSlug))
		.returning();
	if (row) return rowToSkill(row);
	const [bySlug] = await db
		.update(agentSkillRegistry)
		.set({ status, updatedAt: new Date() })
		.where(eq(agentSkillRegistry.slug, idOrSlug))
		.returning();
	if (!bySlug) throw new Error('Skill not found');
	return rowToSkill(bySlug);
}

export type SkillSearchResult = AgentSkillRegistryEntry & {
	installs?: string;
};

export function skillsCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const home = env.HOME && env.HOME !== '/' ? env.HOME : SKILLS_CLI_HOME;
	const npmCache = env.NPM_CONFIG_CACHE || env.npm_config_cache || `${SKILLS_CLI_HOME}/.npm`;
	return {
		...env,
		HOME: home,
		XDG_CACHE_HOME: env.XDG_CACHE_HOME || `${SKILLS_CLI_HOME}/.cache`,
		NPM_CONFIG_CACHE: npmCache,
		npm_config_cache: npmCache
	};
}

export function parseSkillSearchOutput(output: string): SkillSearchResult[] {
	const normalizedOutput = stripAnsi(output);
	const lines = normalizedOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const results: SkillSearchResult[] = [];

	for (let i = 0; i < lines.length; i += 1) {
		const match = lines[i].match(/^([^\s@]+\/[^\s@]+)@(.+?)\s+([\d.]+[KMB]?)\s+installs/i);
		if (!match) continue;
		const installSource = normalizeInstallSource(match[1]);
		const skillName = match[2].trim();
		const slug = defaultSkillSlug(installSource, skillName);
		const urlLine = lines.slice(i + 1, i + 3).find((line) => line.includes('https://skills.sh/'));
		const url = urlLine?.match(/https:\/\/skills\.sh\/\S+/)?.[0];
		results.push({
			id: `search:${installSource}@${slug}`,
			registryId: `search:${installSource}@${slug}`,
			slug,
			name: skillName,
			description: undefined,
			whenToUse: undefined,
			allowedTools: [],
			sourceType: 'registry',
			sourceRepo: installSource,
			registryUrl: registryUrl(installSource, skillName, url),
			installSource,
			skillName,
			installAgent: DEFAULT_INSTALL_AGENT,
			version: 'latest',
			status: 'DRAFT',
			installs: match[3]
		});
	}

	return results;
}

export async function searchSkills(query: string): Promise<SkillSearchResult[]> {
	const q = query.trim();
	if (!q) return [];
	const { stdout, stderr } = await execFileAsync(
		'npx',
		['--yes', SKILLS_CLI_PACKAGE, 'find', q],
		{
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
			env: skillsCliEnv()
		}
	);
	return parseSkillSearchOutput(`${stdout}\n${stderr}`);
}

export async function canManageAgentSkills(userId: string, projectId?: string): Promise<boolean> {
	if (!db) return true;
	const [user] = await db
		.select({ platformRole: users.platformRole })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (user?.platformRole === 'ADMIN') return true;

	if (projectId) {
		const [member] = await db
			.select({ role: projectMembers.role })
			.from(projectMembers)
			.where(and(eq(projectMembers.userId, userId), eq(projectMembers.projectId, projectId)))
			.limit(1);
		return member?.role === 'ADMIN';
	}

	const [adminMembership] = await db
		.select({ role: projectMembers.role })
		.from(projectMembers)
		.where(and(eq(projectMembers.userId, userId), eq(projectMembers.role, 'ADMIN')))
		.limit(1);
	return adminMembership?.role === 'ADMIN';
}
