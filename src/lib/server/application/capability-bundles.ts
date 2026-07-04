import { createHash } from "node:crypto";
import { canonicalJson } from "$lib/server/agents/config-hash";
import {
	flattenBundleConfigs,
	resolveBundleProvenanceFromVersions,
	type BundleProvenanceEntry,
	type ResolvedCapabilityBundleVersion,
} from "$lib/server/capabilities/flatten";
import type { CapabilityBundleConfig } from "$lib/types/agents";
import type { AgentConfig, BundleRef } from "$lib/types/agents";

export type CapabilityBundleSummary = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	tags: string[];
	projectId: string | null;
	currentVersion: number | null;
	isArchived: boolean;
	createdAt: string;
	updatedAt: string;
};

export type CapabilityBundleDetail = CapabilityBundleSummary & {
	config: CapabilityBundleConfig;
	configHash: string;
	changelog: string | null;
};

export type CapabilityBundleCreateRecord = {
	slugBase: string;
	name: string;
	description: string | null;
	tags: string[];
	config: CapabilityBundleConfig;
	configHash: string;
	createdBy: string | null;
	projectId: string | null;
};

export type CapabilityBundleUpdateRecord = {
	name?: string;
	description?: string | null;
	tags?: string[];
	config?: CapabilityBundleConfig;
	configHash?: string;
	changelog?: string | null;
	publishedBy: string | null;
};

export interface CapabilityBundleRepository {
	listBundles(input: {
		projectId?: string | null;
		includeArchived?: boolean;
	}): Promise<CapabilityBundleSummary[]>;
	getBundle(id: string): Promise<CapabilityBundleDetail | null>;
	resolveBundleVersions(input: {
		refs: BundleRef[];
		projectId?: string | null;
	}): Promise<ResolvedCapabilityBundleVersion[]>;
	createBundle(input: CapabilityBundleCreateRecord): Promise<CapabilityBundleDetail>;
	updateBundle(
		id: string,
		input: CapabilityBundleUpdateRecord,
	): Promise<CapabilityBundleDetail | null>;
	archiveBundle(id: string): Promise<boolean>;
}

export class ApplicationCapabilityBundleService {
	constructor(private readonly repository: CapabilityBundleRepository) {}

	listBundles(input: {
		projectId?: string | null;
		includeArchived?: boolean;
	}): Promise<CapabilityBundleSummary[]> {
		return this.repository.listBundles(input);
	}

	getBundle(input: { id: string }): Promise<CapabilityBundleDetail | null> {
		return this.repository.getBundle(input.id);
	}

	async flattenBundles(
		config: AgentConfig,
		projectId?: string | null,
	): Promise<AgentConfig> {
		const refs = validBundleRefs(config.bundleRefs);
		if (refs.length === 0) return config;
		const rows = await this.repository.resolveBundleVersions({
			refs,
			projectId: projectId ?? null,
		});
		return flattenBundleConfigs(
			config,
			rows.map((row) => row.config),
		);
	}

	async resolveBundleProvenance(
		refs: BundleRef[] | null | undefined,
		projectId?: string | null,
	): Promise<BundleProvenanceEntry[]> {
		const valid = validBundleRefs(refs);
		if (valid.length === 0) return [];
		const rows = await this.repository.resolveBundleVersions({
			refs: valid,
			projectId: projectId ?? null,
		});
		return resolveBundleProvenanceFromVersions(rows);
	}

	createBundle(input: {
		body: Record<string, unknown>;
		userId: string;
		projectId?: string | null;
	}): Promise<CapabilityBundleDetail> {
		const name = stringValue(input.body.name)?.trim() || "Untitled bundle";
		const config = normalizeBundleConfig(
			isRecord(input.body.config) ? (input.body.config as CapabilityBundleConfig) : {},
		);
		return this.repository.createBundle({
			slugBase:
				stringValue(input.body.slug)?.trim() || slugify(name) || "bundle",
			name,
			description:
				typeof input.body.description === "string"
					? input.body.description
					: null,
			tags: stringArray(input.body.tags),
			config,
			configHash: hashBundleConfig(config),
			createdBy: input.userId,
			projectId:
				typeof input.body.projectId === "string"
					? input.body.projectId
					: (input.projectId ?? null),
		});
	}

	updateBundle(input: {
		id: string;
		body: Record<string, unknown>;
		userId: string;
	}): Promise<CapabilityBundleDetail | null> {
		const config = isRecord(input.body.config)
			? normalizeBundleConfig(input.body.config as CapabilityBundleConfig)
			: undefined;
		return this.repository.updateBundle(input.id, {
			name:
				typeof input.body.name === "string" ? input.body.name : undefined,
			description:
				typeof input.body.description === "string"
					? input.body.description
					: input.body.description === null
						? null
						: undefined,
			tags: Array.isArray(input.body.tags)
				? input.body.tags.map(String)
				: undefined,
			config,
			configHash: config ? hashBundleConfig(config) : undefined,
			changelog:
				typeof input.body.changelog === "string"
					? input.body.changelog
					: undefined,
			publishedBy: input.userId,
		});
	}

	archiveBundle(input: { id: string }): Promise<boolean> {
		return this.repository.archiveBundle(input.id);
	}
}

function hashBundleConfig(config: CapabilityBundleConfig): string {
	return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

/** Light normalization: every capability surface a bundle declares is an array. */
function normalizeBundleConfig(config: CapabilityBundleConfig): CapabilityBundleConfig {
	const out: CapabilityBundleConfig = {};
	if (Array.isArray(config.mcpServers)) out.mcpServers = config.mcpServers;
	if (Array.isArray(config.skills)) out.skills = config.skills;
	if (Array.isArray(config.tools)) out.tools = config.tools.map((tool) => String(tool));
	if (Array.isArray(config.builtinTools)) {
		out.builtinTools = config.builtinTools.map((tool) => String(tool));
	}
	if (Array.isArray(config.plugins)) {
		out.plugins = config.plugins.map((plugin) => String(plugin));
	}
	if (Array.isArray(config.staticPromptPresetRefs)) {
		out.staticPromptPresetRefs = config.staticPromptPresetRefs;
	}
	if (Array.isArray(config.dynamicPromptPresetRefs)) {
		out.dynamicPromptPresetRefs = config.dynamicPromptPresetRefs;
	}
	if (config.hooks && typeof config.hooks === "object") out.hooks = config.hooks;
	return out;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function validBundleRefs(value: BundleRef[] | null | undefined): BundleRef[] {
	return Array.isArray(value)
		? value.filter(
				(ref): ref is BundleRef =>
					!!ref && typeof ref.id === "string" && ref.id.length > 0,
			)
		: [];
}
