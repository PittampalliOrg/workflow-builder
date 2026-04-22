/**
 * Pure skill-bundle ingestion + validation helpers. No DB import — this
 * module is safe for `pnpm tsx` scripts + integration tests to import
 * directly (the $env/dynamic/private resolution trap in $lib/server/db
 * only bites code that imports from `./agent-skills.ts`).
 *
 * Keep this file free of Svelte-app concerns. DB writes live in
 * `./agent-skills.ts` and re-export these types for back-compat.
 */

import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';

// ---------------------------------------------------------------------------
// Types + errors
// ---------------------------------------------------------------------------

export class SkillNotFoundError extends Error {
	constructor(public readonly url: string) {
		super(`SKILL.md not found at ${url}`);
		this.name = 'SkillNotFoundError';
	}
}

export class SkillFetchError extends Error {
	constructor(
		public readonly url: string,
		public readonly status: number,
		detail?: string
	) {
		super(
			`Failed to fetch SKILL.md from ${url} (HTTP ${status})${detail ? `: ${detail}` : ''}`
		);
		this.name = 'SkillFetchError';
	}
}

export class SkillBundleValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SkillBundleValidationError';
	}
}

export type SkillFrontmatter = {
	name?: string;
	description?: string;
	whenToUse?: string;
	allowedTools?: string[];
	arguments?: string[];
	argumentHint?: string;
	model?: string;
	userInvocable?: boolean;
	disableModelInvocation?: boolean;
	license?: string;
	raw: Record<string, string>;
};

export type FetchedSkill = {
	prompt: string;
	frontmatter: SkillFrontmatter;
	contentHash: string;
	url: string;
};

export type SkillSource =
	| { type: 'github'; repo: string; skillName: string; ref?: string; skillPath?: string }
	| { type: 'zip'; buffer: ArrayBuffer | Buffer; skillName: string }
	| { type: 'gitea'; repoUrl: string; skillName: string; ref?: string }; // stub

export type SkillPackageFile = { path: string; content: string };

export type FetchedSkillBundle = {
	prompt: string;
	frontmatter: SkillFrontmatter;
	contentHash: string;
	packageFiles: SkillPackageFile[];
	sourceUrl: string | null;
	suggestedSourceType: 'registry' | 'custom';
};

// ---------------------------------------------------------------------------
// Constants (mirror services/dapr-agent-py/src/main.py:848-857)
// ---------------------------------------------------------------------------

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';
const SKILL_FETCH_TIMEOUT_MS = 15_000;

// Caps are deliberately generous. anthropics/skills' xlsx/pptx bundles ship
// ~1.5 MB of reference schemas + patterns; real-world SKILL.md bundles
// need headroom. Keep these in lock-step with
// services/dapr-agent-py/src/main.py (PACKAGE_* constants). Admin-UI
// ingestion rejects bundles that exceed these caps; the runtime silently
// skips individual oversize files as a second line of defence.
export const PACKAGE_MAX_FILES = 80;
export const PACKAGE_MAX_FILE_BYTES = 128 * 1024;
export const PACKAGE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/;
const KV_RE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/;

function parseBool(value: string, fallback: boolean): boolean {
	const v = value.trim().toLowerCase();
	if (v === 'true' || v === 'yes' || v === '1') return true;
	if (v === 'false' || v === 'no' || v === '0') return false;
	return fallback;
}

function parseCsv(value: string): string[] {
	return value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

export function parseSkillMarkdown(raw: string): { prompt: string; frontmatter: SkillFrontmatter } {
	const match = FRONTMATTER_RE.exec(raw);
	const meta: Record<string, string> = {};
	let body = raw;
	if (match) {
		const header = match[1] ?? '';
		body = match[2] ?? '';
		for (const line of header.split(/\r?\n/)) {
			const kv = KV_RE.exec(line);
			if (kv) meta[kv[1].trim()] = kv[2].trim();
		}
	}

	const pick = (...keys: string[]): string | undefined => {
		for (const k of keys) if (k in meta) return meta[k];
		return undefined;
	};

	const frontmatter: SkillFrontmatter = { raw: meta };
	const name = pick('name');
	if (name) frontmatter.name = name;
	const description = pick('description');
	if (description) frontmatter.description = description;
	const whenToUse = pick('when_to_use', 'when-to-use');
	if (whenToUse) frontmatter.whenToUse = whenToUse;
	const allowedTools = pick('allowed-tools', 'allowed_tools');
	if (allowedTools !== undefined) frontmatter.allowedTools = parseCsv(allowedTools);
	const args = pick('arguments');
	if (args !== undefined) frontmatter.arguments = parseCsv(args);
	const argumentHint = pick('argument-hint', 'argument_hint');
	if (argumentHint) frontmatter.argumentHint = argumentHint;
	const model = pick('model');
	if (model) frontmatter.model = model;
	const userInvocable = pick('user-invocable', 'user_invocable');
	if (userInvocable !== undefined) frontmatter.userInvocable = parseBool(userInvocable, true);
	const disableModelInvocation = pick('disable-model-invocation', 'disable_model_invocation');
	if (disableModelInvocation !== undefined)
		frontmatter.disableModelInvocation = parseBool(disableModelInvocation, false);
	const license = pick('license');
	if (license) frontmatter.license = license;

	return { prompt: body.trim(), frontmatter };
}

// ---------------------------------------------------------------------------
// SKILL.md fetcher
// ---------------------------------------------------------------------------

export function buildSkillMdUrl(
	sourceRepo: string,
	skillName: string,
	ref: string,
	skillPath?: string
) {
	// Convention matches anthropics/skills and compatible repos.
	const path = (skillPath && skillPath.trim()) || `skills/${skillName}`;
	const trimmed = path.replace(/^\/+|\/+$/g, '');
	return `${GITHUB_RAW_BASE}/${sourceRepo}/${ref}/${trimmed}/SKILL.md`;
}

export async function fetchSkillFromGithub(
	sourceRepo: string,
	skillName: string,
	ref = 'main',
	skillPath?: string
): Promise<FetchedSkill> {
	const url = buildSkillMdUrl(sourceRepo, skillName, ref, skillPath);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SKILL_FETCH_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new SkillFetchError(url, 0, msg);
	} finally {
		clearTimeout(timer);
	}
	if (res.status === 404) throw new SkillNotFoundError(url);
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new SkillFetchError(url, res.status, detail.slice(0, 200));
	}
	const raw = await res.text();
	const { prompt, frontmatter } = parseSkillMarkdown(raw);
	const contentHash = createHash('sha256').update(raw).digest('hex');
	return { prompt, frontmatter, contentHash, url };
}

// ---------------------------------------------------------------------------
// Package-file validation
// ---------------------------------------------------------------------------

function safePackageRelativePath(value: string): string | null {
	const raw = value.replace(/\\/g, '/').trim();
	if (!raw) return null;
	const segments: string[] = [];
	for (const part of raw.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') return null;
		segments.push(part);
	}
	if (segments.length === 0) return null;
	return segments.join('/');
}

function isLikelyBinary(buf: Buffer): boolean {
	const probe = buf.subarray(0, Math.min(buf.length, 8192));
	return probe.indexOf(0) >= 0;
}

function validateAndCollectPackageFiles(entries: SkillPackageFile[]): SkillPackageFile[] {
	const out: SkillPackageFile[] = [];
	let totalBytes = 0;
	for (const entry of entries) {
		const safe = safePackageRelativePath(entry.path);
		if (!safe) {
			throw new SkillBundleValidationError(
				`Rejected unsafe package file path: ${JSON.stringify(entry.path)}`
			);
		}
		if (typeof entry.content !== 'string') continue;
		const size = Buffer.byteLength(entry.content, 'utf8');
		if (size > PACKAGE_MAX_FILE_BYTES) {
			throw new SkillBundleValidationError(
				`Package file ${safe} is ${size} bytes (>${PACKAGE_MAX_FILE_BYTES}). Split or shrink it.`
			);
		}
		if (totalBytes + size > PACKAGE_MAX_TOTAL_BYTES) {
			throw new SkillBundleValidationError(
				`Package total would exceed ${PACKAGE_MAX_TOTAL_BYTES} bytes after adding ${safe}.`
			);
		}
		totalBytes += size;
		out.push({ path: safe, content: entry.content });
		if (out.length > PACKAGE_MAX_FILES) {
			throw new SkillBundleValidationError(
				`Package has more than ${PACKAGE_MAX_FILES} files after validation.`
			);
		}
	}
	return out;
}

function hashBundle(prompt: string, files: SkillPackageFile[]): string {
	const h = createHash('sha256');
	h.update('SKILL.md\n');
	h.update(prompt);
	h.update('\n');
	const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
	for (const f of sorted) {
		h.update(`${f.path}\n`);
		h.update(f.content);
		h.update('\n');
	}
	return h.digest('hex');
}

// ---------------------------------------------------------------------------
// GitHub bundle fetcher
// ---------------------------------------------------------------------------

type GithubTreeEntry = {
	path: string;
	type: 'blob' | 'tree' | 'commit';
	sha: string;
	size?: number;
};

async function fetchGithubBundle(
	repo: string,
	skillName: string,
	ref: string,
	skillPath: string | undefined
): Promise<FetchedSkillBundle> {
	const skillMd = await fetchSkillFromGithub(repo, skillName, ref, skillPath);
	const basePath = (skillPath && skillPath.trim()) || `skills/${skillName}`;
	const normalizedBase = basePath.replace(/^\/+|\/+$/g, '');
	const skillMdPath = `${normalizedBase}/SKILL.md`;

	const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SKILL_FETCH_TIMEOUT_MS);
	let treeRes: Response;
	try {
		treeRes = await fetch(treeUrl, {
			signal: controller.signal,
			redirect: 'follow',
			headers: { Accept: 'application/vnd.github+json' }
		});
	} catch (err) {
		clearTimeout(timer);
		const msg = err instanceof Error ? err.message : String(err);
		throw new SkillFetchError(treeUrl, 0, msg);
	}
	clearTimeout(timer);
	if (!treeRes.ok) {
		const detail = await treeRes.text().catch(() => '');
		throw new SkillFetchError(treeUrl, treeRes.status, detail.slice(0, 200));
	}
	const tree = (await treeRes.json()) as { tree?: GithubTreeEntry[]; truncated?: boolean };
	const entries: GithubTreeEntry[] = Array.isArray(tree.tree) ? tree.tree : [];

	const candidates: GithubTreeEntry[] = [];
	for (const e of entries) {
		if (e.type !== 'blob') continue;
		if (e.path === skillMdPath) continue;
		if (!e.path.startsWith(`${normalizedBase}/`)) continue;
		if (typeof e.size === 'number' && e.size > PACKAGE_MAX_FILE_BYTES) continue;
		candidates.push(e);
	}

	const fetched = await Promise.all(
		candidates.slice(0, PACKAGE_MAX_FILES * 2).map(async (entry): Promise<SkillPackageFile | null> => {
			const rawUrl = `${GITHUB_RAW_BASE}/${repo}/${ref}/${entry.path}`;
			const ctl = new AbortController();
			const t = setTimeout(() => ctl.abort(), SKILL_FETCH_TIMEOUT_MS);
			try {
				const res = await fetch(rawUrl, { signal: ctl.signal, redirect: 'follow' });
				if (!res.ok) return null;
				const buf = Buffer.from(await res.arrayBuffer());
				if (isLikelyBinary(buf)) return null;
				const content = buf.toString('utf8');
				if (content.includes('\uFFFD')) return null;
				const rel = entry.path.slice(normalizedBase.length + 1);
				return { path: rel, content };
			} catch {
				return null;
			} finally {
				clearTimeout(t);
			}
		})
	);
	const rawFiles = fetched.filter((f): f is SkillPackageFile => f !== null);
	const packageFiles = validateAndCollectPackageFiles(rawFiles);
	const contentHash = hashBundle(skillMd.prompt, packageFiles);
	return {
		prompt: skillMd.prompt,
		frontmatter: skillMd.frontmatter,
		contentHash,
		packageFiles,
		sourceUrl: `https://github.com/${repo}/tree/${ref}/${normalizedBase}`,
		suggestedSourceType: 'registry'
	};
}

// ---------------------------------------------------------------------------
// Zip bundle extractor
// ---------------------------------------------------------------------------

function extractZipBundle(buffer: Buffer, skillName: string): FetchedSkillBundle {
	let zip: AdmZip;
	try {
		zip = new AdmZip(buffer);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new SkillBundleValidationError(`Invalid zip archive: ${msg}`);
	}
	const rawEntries = zip.getEntries();
	const preferred = `${skillName}/SKILL.md`;
	let skillMdEntry = rawEntries.find((e) => !e.isDirectory && e.entryName === preferred);
	if (!skillMdEntry) {
		const endsWith = rawEntries.filter(
			(e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('/skill.md')
		);
		if (endsWith.length === 1) skillMdEntry = endsWith[0];
	}
	if (!skillMdEntry) {
		throw new SkillBundleValidationError(
			`Could not locate SKILL.md in zip. Expected ${preferred} or a single */SKILL.md entry.`
		);
	}
	const baseDir = skillMdEntry.entryName.slice(
		0,
		skillMdEntry.entryName.length - 'SKILL.md'.length
	);
	const skillMdRaw = skillMdEntry.getData().toString('utf8');
	const { prompt, frontmatter } = parseSkillMarkdown(skillMdRaw);

	const rawFiles: SkillPackageFile[] = [];
	for (const entry of rawEntries) {
		if (entry.isDirectory) continue;
		if (entry.entryName === skillMdEntry.entryName) continue;
		if (!entry.entryName.startsWith(baseDir)) continue;
		const data = entry.getData();
		if (data.length > PACKAGE_MAX_FILE_BYTES) continue;
		if (isLikelyBinary(data)) continue;
		const content = data.toString('utf8');
		if (content.includes('\uFFFD')) continue;
		const rel = entry.entryName.slice(baseDir.length);
		rawFiles.push({ path: rel, content });
	}
	const packageFiles = validateAndCollectPackageFiles(rawFiles);
	const contentHash = hashBundle(prompt, packageFiles);
	return {
		prompt,
		frontmatter,
		contentHash,
		packageFiles,
		sourceUrl: null,
		suggestedSourceType: 'custom'
	};
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

export async function ingestSkillBundle(source: SkillSource): Promise<FetchedSkillBundle> {
	if (source.type === 'github') {
		return fetchGithubBundle(
			source.repo,
			source.skillName,
			(source.ref || 'main').trim() || 'main',
			source.skillPath
		);
	}
	if (source.type === 'zip') {
		const buf =
			source.buffer instanceof Buffer
				? source.buffer
				: Buffer.from(source.buffer as ArrayBuffer);
		return extractZipBundle(buf, source.skillName);
	}
	if (source.type === 'gitea') {
		throw new SkillBundleValidationError('Gitea SkillSource is not implemented yet.');
	}
	throw new SkillBundleValidationError(
		`Unknown SkillSource type: ${(source as { type?: string }).type ?? '<missing>'}`
	);
}
