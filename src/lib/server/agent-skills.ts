import { createHash } from 'node:crypto';
import { posix as posixPath } from 'node:path';
import yaml from 'js-yaml';
import { and, asc, eq } from 'drizzle-orm';
import {
	DEFAULT_CURATED_AGENT_SKILLS,
	type AgentSkillConfig,
	type AgentSkillRegistryEntry
} from '$lib/agent-skill-presets';
import { db } from '$lib/server/db';
import { agentSkillRegistry, projectMembers, users } from '$lib/server/db/schema';
import { env } from '$env/dynamic/private';

type SkillFrontmatter = Record<string, unknown>;

type SkillPackageFile = {
	path: string;
	content: string;
	size: number;
	encoding: 'utf-8';
};

type SkillPackageManifest = {
	schemaVersion: 1;
	frontmatter: SkillFrontmatter;
	root: string;
	files: SkillPackageFile[];
	totalBytes: number;
	sourceRepo?: string;
	sourceRef?: string;
	skillPath?: string;
	importedAt?: string;
};

export type ParsedSkillPackage = {
	skill: AgentSkillConfig;
	frontmatter: SkillFrontmatter;
	contentHash: string;
};

export type ImportSkillInput = {
	sourceRepo?: string;
	sourceRef?: string;
	skillPath?: string;
	skillMarkdown?: string;
	status?: 'ENABLED' | 'DISABLED' | 'DRAFT';
};

const DEFAULT_ALLOWED_SOURCES = [
	'https://github.com/vercel-labs/agent-skills',
	'https://github.com/agentskills/agentskills'
];
const MAX_PACKAGE_FILES = 40;
const MAX_PACKAGE_BYTES = 256 * 1024;
const MAX_PACKAGE_FILE_BYTES = 64 * 1024;
const TEXT_PACKAGE_EXTENSIONS = new Set([
	'',
	'.md',
	'.mdx',
	'.txt',
	'.json',
	'.jsonc',
	'.yaml',
	'.yml',
	'.toml',
	'.js',
	'.jsx',
	'.ts',
	'.tsx',
	'.py',
	'.sh',
	'.css',
	'.html'
]);

function slugify(value: unknown): string {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

function stringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
	if (typeof value === 'string') {
		return value
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean);
	}
	return [];
}

function skillStatus(value: unknown): 'ENABLED' | 'DISABLED' | 'DRAFT' {
	return value === 'ENABLED' || value === 'DISABLED' || value === 'DRAFT' ? value : 'DRAFT';
}

function hashContent(content: string): string {
	return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function hashPackageFiles(files: SkillPackageFile[]): string {
	const normalized = [...files]
		.sort((a, b) => a.path.localeCompare(b.path))
		.map((file) => ({ path: file.path, content: file.content }));
	return hashContent(JSON.stringify(normalized));
}

function allowedSources(): string[] {
	const configured = String(env.AGENT_SKILL_SOURCE_ALLOWLIST || '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
	return configured.length > 0 ? configured : DEFAULT_ALLOWED_SOURCES;
}

function isSourceAllowed(sourceRepo: string): boolean {
	const normalized = sourceRepo.replace(/\/+$/, '');
	return allowedSources().some((source) => normalized === source.replace(/\/+$/, ''));
}

function githubRawUrl(sourceRepo: string, sourceRef: string, skillPath: string): string | null {
	const parts = githubRepoParts(sourceRepo);
	if (!parts) return null;
	const { owner, repo } = parts;
	const cleanPath = skillPath.replace(/^\/+/, '');
	return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(sourceRef)}/${cleanPath}`;
}

function githubRepoParts(sourceRepo: string): { owner: string; repo: string } | null {
	const match = sourceRepo.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
	if (!match) return null;
	return { owner: match[1], repo: match[2] };
}

function githubContentsApiUrl(sourceRepo: string, sourceRef: string, path: string): string | null {
	const parts = githubRepoParts(sourceRepo);
	if (!parts) return null;
	const cleanPath = path
		.replace(/^\/+/, '')
		.split('/')
		.filter(Boolean)
		.map(encodeURIComponent)
		.join('/');
	const suffix = cleanPath ? `/contents/${cleanPath}` : '/contents';
	return `https://api.github.com/repos/${parts.owner}/${parts.repo}${suffix}?ref=${encodeURIComponent(sourceRef)}`;
}

function skillRoot(skillPath: string): string {
	const normalized = posixPath.normalize(skillPath.replace(/^\/+/, '') || 'SKILL.md');
	const dir = posixPath.dirname(normalized);
	return dir === '.' ? '' : dir;
}

function relativePackagePath(root: string, filePath: string): string | null {
	const cleanRoot = root ? posixPath.normalize(root).replace(/^\/+/, '') : '';
	const cleanFile = posixPath.normalize(filePath).replace(/^\/+/, '');
	const relative = cleanRoot ? posixPath.relative(cleanRoot, cleanFile) : cleanFile;
	if (!relative || relative.startsWith('..') || posixPath.isAbsolute(relative)) return null;
	return relative;
}

function shouldImportPackageFile(path: string, size: number): boolean {
	if (size < 0 || size > MAX_PACKAGE_FILE_BYTES) return false;
	const ext = posixPath.extname(path).toLowerCase();
	return TEXT_PACKAGE_EXTENSIONS.has(ext);
}

async function fetchText(url: string): Promise<string> {
	const headers: Record<string, string> = {
		accept: 'application/vnd.github+json',
		'user-agent': 'workflow-builder-agent-skills'
	};
	if (env.AGENT_SKILL_GITHUB_TOKEN) {
		headers.authorization = `Bearer ${env.AGENT_SKILL_GITHUB_TOKEN}`;
	}
	const response = await fetch(url, { headers });
	if (!response.ok) {
		throw new Error(`Fetch failed (${response.status})`);
	}
	return response.text();
}

async function fetchSkillMarkdown(input: ImportSkillInput): Promise<string> {
	if (typeof input.skillMarkdown === 'string' && input.skillMarkdown.trim()) {
		return input.skillMarkdown;
	}
	const sourceRepo = String(input.sourceRepo || '').trim();
	const sourceRef = String(input.sourceRef || 'main').trim();
	const skillPath = String(input.skillPath || 'SKILL.md').trim();
	if (!sourceRepo || !isSourceAllowed(sourceRepo)) {
		throw new Error('Skill source is not in the curated allowlist');
	}
	const rawUrl = githubRawUrl(sourceRepo, sourceRef, skillPath);
	if (!rawUrl) {
		throw new Error('Only GitHub HTTPS skill sources are supported by the importer');
	}
	return fetchText(rawUrl);
}

async function fetchGitHubPackageFiles(input: ImportSkillInput, skillMarkdown: string): Promise<SkillPackageFile[]> {
	const sourceRepo = String(input.sourceRepo || '').trim();
	const sourceRef = String(input.sourceRef || 'main').trim();
	const normalizedSkillPath = String(input.skillPath || 'SKILL.md').replace(/^\/+/, '');
	const root = skillRoot(normalizedSkillPath);
	if (!root) {
		return [{
			path: 'SKILL.md',
			content: skillMarkdown,
			size: Buffer.byteLength(skillMarkdown, 'utf8'),
			encoding: 'utf-8'
		}];
	}
	const rootUrl = githubContentsApiUrl(sourceRepo, sourceRef, root);
	if (!rootUrl) {
		return [{ path: 'SKILL.md', content: skillMarkdown, size: skillMarkdown.length, encoding: 'utf-8' }];
	}

	type GitHubContentItem = {
		type?: string;
		path?: string;
		size?: number;
		download_url?: string | null;
	};

	const files: SkillPackageFile[] = [];
	let totalBytes = 0;

	async function visit(url: string): Promise<void> {
		if (files.length >= MAX_PACKAGE_FILES || totalBytes >= MAX_PACKAGE_BYTES) return;
		const response = await fetch(url, {
			headers: {
				accept: 'application/vnd.github+json',
				'user-agent': 'workflow-builder-agent-skills',
				...(env.AGENT_SKILL_GITHUB_TOKEN ? { authorization: `Bearer ${env.AGENT_SKILL_GITHUB_TOKEN}` } : {})
			}
		});
		if (!response.ok) return;
		const payload = (await response.json()) as GitHubContentItem[] | GitHubContentItem;
		const items = Array.isArray(payload) ? payload : [payload];
		for (const item of items) {
			if (files.length >= MAX_PACKAGE_FILES || totalBytes >= MAX_PACKAGE_BYTES) return;
			const path = typeof item.path === 'string' ? item.path : '';
			if (!path) continue;
			if (item.type === 'dir') {
				const dirUrl = githubContentsApiUrl(sourceRepo, sourceRef, path);
				if (dirUrl) await visit(dirUrl);
				continue;
			}
			if (item.type !== 'file') continue;
			const size = typeof item.size === 'number' ? item.size : 0;
			const relativePath = relativePackagePath(root, path);
			if (!relativePath || !shouldImportPackageFile(relativePath, size)) continue;
			const downloadUrl = typeof item.download_url === 'string' ? item.download_url : '';
			if (!downloadUrl) continue;
			try {
				const content = relativePath === posixPath.basename(normalizedSkillPath)
					? skillMarkdown
					: await fetchText(downloadUrl);
				const bytes = Buffer.byteLength(content, 'utf8');
				if (bytes > MAX_PACKAGE_FILE_BYTES || totalBytes + bytes > MAX_PACKAGE_BYTES) continue;
				files.push({ path: relativePath, content, size: bytes, encoding: 'utf-8' });
				totalBytes += bytes;
			} catch {
				// A missing optional package file should not block importing SKILL.md.
			}
		}
	}

	await visit(rootUrl);
	if (!files.some((file) => file.path === posixPath.basename(normalizedSkillPath))) {
		files.unshift({
			path: posixPath.basename(normalizedSkillPath),
			content: skillMarkdown,
			size: Buffer.byteLength(skillMarkdown, 'utf8'),
			encoding: 'utf-8'
		});
	}
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function buildPackageManifest(
	input: ImportSkillInput,
	frontmatter: SkillFrontmatter,
	skillMarkdown: string
): Promise<SkillPackageManifest> {
	const normalizedSkillPath = String(input.skillPath || 'SKILL.md').replace(/^\/+/, '') || 'SKILL.md';
	const root = skillRoot(normalizedSkillPath);
	let files: SkillPackageFile[] = [
		{
			path: posixPath.basename(normalizedSkillPath),
			content: skillMarkdown,
			size: Buffer.byteLength(skillMarkdown, 'utf8'),
			encoding: 'utf-8'
		}
	];
	if (!input.skillMarkdown && input.sourceRepo && isSourceAllowed(input.sourceRepo)) {
		files = await fetchGitHubPackageFiles(input, skillMarkdown);
	}
	return {
		schemaVersion: 1,
		frontmatter,
		root,
		files,
		totalBytes: files.reduce((sum, file) => sum + file.size, 0),
		sourceRepo: input.sourceRepo,
		sourceRef: input.sourceRef || 'main',
		skillPath: normalizedSkillPath,
		importedAt: new Date().toISOString()
	};
}

export function parseSkillMarkdown(markdown: string, input: ImportSkillInput = {}): ParsedSkillPackage {
	const trimmed = markdown.replace(/^\uFEFF/, '');
	const match = trimmed.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!match) {
		throw new Error('Skill package must start with YAML frontmatter');
	}
	const frontmatter = (yaml.load(match[1]) || {}) as SkillFrontmatter;
	const body = match[2].trim();
	const name = String(frontmatter.name || frontmatter.title || '').trim();
	const description = String(frontmatter.description || '').trim();
	if (!name) throw new Error('Skill frontmatter must include name');
	if (!description) throw new Error('Skill frontmatter must include description');
	if (!body) throw new Error('Skill body must not be empty');
	const slug = slugify(frontmatter.slug || name);
	if (!slug) throw new Error('Skill name must produce a valid slug');

	const allowedTools = stringArray(frontmatter['allowed-tools'] ?? frontmatter.allowedTools);
	const skill: AgentSkillConfig = {
		name: slug,
		slug,
		description,
		prompt: body,
		whenToUse:
			typeof frontmatter.whenToUse === 'string'
				? frontmatter.whenToUse
				: typeof frontmatter['when-to-use'] === 'string'
					? frontmatter['when-to-use']
					: description,
		allowedTools,
		arguments: stringArray(frontmatter.arguments),
		argumentHint:
			typeof frontmatter.argumentHint === 'string'
				? frontmatter.argumentHint
				: typeof frontmatter['argument-hint'] === 'string'
					? frontmatter['argument-hint']
					: undefined,
		model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
		userInvocable:
			typeof frontmatter.userInvocable === 'boolean'
				? frontmatter.userInvocable
				: typeof frontmatter['user-invocable'] === 'boolean'
					? frontmatter['user-invocable']
					: true,
		disableModelInvocation:
			typeof frontmatter.disableModelInvocation === 'boolean'
				? frontmatter.disableModelInvocation
				: typeof frontmatter['disable-model-invocation'] === 'boolean'
					? frontmatter['disable-model-invocation']
					: false,
		sourceType: 'imported',
		sourceRepo: input.sourceRepo,
		sourceRef: input.sourceRef || 'main',
		skillPath: input.skillPath || 'SKILL.md',
		version: String(frontmatter.version || input.sourceRef || '1'),
		license: typeof frontmatter.license === 'string' ? frontmatter.license : undefined,
		compatibility:
			frontmatter.compatibility && typeof frontmatter.compatibility === 'object'
				? (frontmatter.compatibility as Record<string, unknown>)
				: undefined,
		packageManifest: {
			schemaVersion: 1,
			frontmatter,
			root: skillRoot(input.skillPath || 'SKILL.md'),
			files: [
				{
					path: posixPath.basename(input.skillPath || 'SKILL.md'),
					content: markdown,
					size: Buffer.byteLength(markdown, 'utf8'),
					encoding: 'utf-8'
				}
			],
			totalBytes: Buffer.byteLength(markdown, 'utf8'),
			sourceRepo: input.sourceRepo,
			sourceRef: input.sourceRef || 'main',
			skillPath: input.skillPath || 'SKILL.md'
		}
	};
	return {
		skill,
		frontmatter,
		contentHash: hashContent(markdown)
	};
}

function rowToSkill(row: typeof agentSkillRegistry.$inferSelect): AgentSkillRegistryEntry {
	return {
		id: row.id,
		registryId: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description || undefined,
		prompt: row.prompt,
		whenToUse: row.whenToUse || undefined,
		allowedTools: Array.isArray(row.allowedTools) ? row.allowedTools : [],
		arguments: Array.isArray(row.arguments) ? row.arguments : [],
		argumentHint: row.argumentHint || undefined,
		model: row.model || undefined,
		userInvocable: row.userInvocable,
		disableModelInvocation: row.disableModelInvocation,
		sourceType:
			row.sourceType === 'builtin'
				? 'builtin'
				: row.sourceType === 'imported'
					? 'imported'
					: 'curated',
		sourceRepo: row.sourceRepo || undefined,
		sourceRef: row.sourceRef || undefined,
		skillPath: row.skillPath || undefined,
		version: row.version,
		contentHash: row.contentHash,
		license: row.license || undefined,
		compatibility: row.compatibility || undefined,
		packageManifest: row.packageManifest || undefined,
		status: row.status
	};
}

export function mergeAgentSkillRegistryEntries(rows: AgentSkillRegistryEntry[]): AgentSkillRegistryEntry[] {
	const merged = new Map<string, AgentSkillRegistryEntry>();
	for (const skill of DEFAULT_CURATED_AGENT_SKILLS) {
		merged.set(skill.slug, skill);
	}
	for (const row of rows) {
		merged.set(row.slug, row);
	}
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listAgentSkills(options: { includeDisabled?: boolean } = {}) {
	if (!db) return mergeAgentSkillRegistryEntries([]);
	try {
		const rows = await db.select().from(agentSkillRegistry).orderBy(asc(agentSkillRegistry.name));
		const skills = rows.map(rowToSkill);
		return mergeAgentSkillRegistryEntries(skills).filter(
			(skill) => options.includeDisabled || skill.status === 'ENABLED'
		);
	} catch (err) {
		console.warn('[agent-skills] Failed loading DB skills, using curated built-ins:', err);
		return mergeAgentSkillRegistryEntries([]);
	}
}

export async function importAgentSkill(input: ImportSkillInput, userId: string) {
	const markdown = await fetchSkillMarkdown(input);
	const parsed = parseSkillMarkdown(markdown, input);
	const skill = parsed.skill;
	const packageManifest = await buildPackageManifest(input, parsed.frontmatter, markdown);
	const contentHash = hashPackageFiles(packageManifest.files);
	const status = skillStatus(input.status);
	const slug = String(skill.slug || skill.name);
	if (!db) {
		return {
			...skill,
			id: `imported:${slug}`,
			registryId: `imported:${slug}`,
			slug,
			contentHash,
			packageManifest,
			status,
			sourceType: 'imported'
		} satisfies AgentSkillRegistryEntry;
	}

	const [row] = await db
		.insert(agentSkillRegistry)
		.values({
			slug,
			name: skill.name,
			description: skill.description,
			whenToUse: skill.whenToUse,
			prompt: skill.prompt,
			allowedTools: skill.allowedTools || [],
			arguments: skill.arguments || [],
			argumentHint: skill.argumentHint,
			model: skill.model,
			userInvocable: skill.userInvocable ?? true,
			disableModelInvocation: skill.disableModelInvocation ?? false,
			sourceType: 'imported',
			sourceRepo: input.sourceRepo,
			sourceRef: input.sourceRef || 'main',
			skillPath: input.skillPath || 'SKILL.md',
			version: skill.version || input.sourceRef || '1',
			contentHash,
			license: skill.license,
			compatibility: skill.compatibility,
			packageManifest,
			status,
			createdByUserId: userId
		})
		.onConflictDoUpdate({
			target: agentSkillRegistry.slug,
			set: {
				name: skill.name,
				description: skill.description,
				whenToUse: skill.whenToUse,
				prompt: skill.prompt,
				allowedTools: skill.allowedTools || [],
				arguments: skill.arguments || [],
				argumentHint: skill.argumentHint,
				model: skill.model,
				userInvocable: skill.userInvocable ?? true,
				disableModelInvocation: skill.disableModelInvocation ?? false,
				sourceType: 'imported',
				sourceRepo: input.sourceRepo,
				sourceRef: input.sourceRef || 'main',
				skillPath: input.skillPath || 'SKILL.md',
				version: skill.version || input.sourceRef || '1',
				contentHash,
				license: skill.license,
				compatibility: skill.compatibility,
				packageManifest,
				status,
				updatedAt: new Date()
			}
		})
		.returning();

	return rowToSkill(row);
}

export async function setAgentSkillStatus(idOrSlug: string, status: 'ENABLED' | 'DISABLED' | 'DRAFT') {
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
	if (!bySlug) {
		const curated = DEFAULT_CURATED_AGENT_SKILLS.find(
			(skill) => skill.id === idOrSlug || skill.slug === idOrSlug || skill.name === idOrSlug
		);
		if (!curated) throw new Error('Skill not found');
		const [created] = await db
			.insert(agentSkillRegistry)
			.values({
				id: curated.id,
				slug: curated.slug,
				name: curated.name,
				description: curated.description,
				whenToUse: curated.whenToUse,
				prompt: curated.prompt,
				allowedTools: curated.allowedTools || [],
				arguments: curated.arguments || [],
				argumentHint: curated.argumentHint,
				model: curated.model,
				userInvocable: curated.userInvocable ?? true,
				disableModelInvocation: curated.disableModelInvocation ?? false,
				sourceType: curated.sourceType,
				sourceRepo: curated.sourceRepo,
				sourceRef: curated.sourceRef,
				skillPath: curated.skillPath,
				version: curated.version || '1',
				contentHash: curated.contentHash || curated.id,
				license: curated.license,
				compatibility: curated.compatibility,
				packageManifest: curated.packageManifest,
				status
			})
			.onConflictDoUpdate({
				target: agentSkillRegistry.slug,
				set: { status, updatedAt: new Date() }
			})
			.returning();
		return rowToSkill(created);
	}
	return rowToSkill(bySlug);
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
