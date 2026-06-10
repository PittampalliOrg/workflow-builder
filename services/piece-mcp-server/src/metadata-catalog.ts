import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Action, Piece } from "@activepieces/pieces-framework";
import { extensionsFor } from "./extensions/index.js";
import { PIECES, normalizePieceName } from "./piece-registry.js";
import {
	actionPropsToSchema,
	apPropToJsonSchema,
	type ApPropDef,
	type JsonSchema,
	type JsonSchemaProperty,
} from "./prop-schema.js";

export const CATALOG_SCHEMA_VERSION = 1;
export const DEFAULT_PLATFORM_ID = "OFFICIAL";

type UnknownRecord = Record<string, unknown>;

export type CatalogFieldSummary = {
	name: string;
	title: string | null;
	type: string | null;
	description: string | null;
	required: boolean;
	enum?: unknown[];
};

export type CatalogActionDynamicProp = {
	refreshers: string[];
	refreshOnSearch: boolean;
};

export type CatalogActionMetadata = {
	name: string;
	displayName: string;
	description: string | null;
	requireAuth: boolean;
	inputSchema: JsonSchema;
	fieldSummaries: CatalogFieldSummary[];
	requiredFields: string[];
	digest: string;
	props?: Record<string, unknown>;
	/**
	 * Dynamic-dropdown wiring (props whose `options` resolver is a function):
	 * `refreshers` drives the canvas dependsOn re-fetch, `refreshOnSearch`
	 * enables search-as-you-type. EXCLUDED from both the per-action digest and
	 * catalogDigest so piece_metadata rows synced before this field existed
	 * keep validating against newer runtimes.
	 */
	dynamicProps?: Record<string, CatalogActionDynamicProp>;
};

export type CatalogTriggerMetadata = {
	name: string;
	displayName: string;
	description: string | null;
	requireAuth: boolean;
};

export type PieceCatalogRow = {
	name: string;
	authors: string[];
	displayName: string;
	logoUrl: string;
	description: string | null;
	platformId: string;
	version: string;
	minimumSupportedRelease: string;
	maximumSupportedRelease: string;
	auth: unknown;
	actions: Record<string, CatalogActionMetadata>;
	triggers: Record<string, CatalogTriggerMetadata>;
	pieceType: string;
	categories: string[];
	packageType: string;
	catalogSchemaVersion: number;
	catalogDigest: string;
	catalogSourceImage: string | null;
};

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function packageVersion(pieceName: string): string | null {
	const packageName = `@activepieces/piece-${normalizePieceName(pieceName)}`;
	const candidates = [
		...(typeof __dirname !== "undefined"
			? [resolve(__dirname, "..", "node_modules", packageName, "package.json")]
			: []),
		resolve(process.cwd(), "node_modules", packageName, "package.json"),
		resolve(
			process.cwd(),
			"services",
			"piece-mcp-server",
			"node_modules",
			packageName,
			"package.json",
		),
	];
	for (const packageJsonPath of candidates) {
		try {
			const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
				version?: unknown;
			};
			const version = stringOrNull(parsed.version);
			if (version) return version;
		} catch {
			// Try the next candidate. Source tests and bundled runtime have
			// different cwd/module roots.
		}
	}
	return null;
}

function resolveValue(value: unknown): unknown {
	if (typeof value !== "function") return value;
	try {
		return (value as () => unknown)();
	} catch {
		return null;
	}
}

function jsonSafe(value: unknown): unknown {
	if (
		value == null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (Array.isArray(value)) return value.map(jsonSafe);
	if (!isRecord(value)) return undefined;

	const out: UnknownRecord = {};
	for (const key of Object.keys(value).sort()) {
		const raw = value[key];
		if (raw === undefined || typeof raw === "function" || typeof raw === "symbol") {
			continue;
		}
		const safe = jsonSafe(raw);
		if (safe !== undefined) out[key] = safe;
	}
	return out;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(jsonSafe(value));
}

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function normalizeProps(value: unknown): Record<string, ApPropDef> {
	return isRecord(value) ? (value as Record<string, ApPropDef>) : {};
}

function metadataProps(props: Record<string, ApPropDef>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, prop] of Object.entries(props)) {
		out[name] = jsonSafe({
			type: prop.type,
			displayName: prop.displayName,
			description: prop.description,
			required: prop.required === true,
			defaultValue: prop.defaultValue,
			options: prop.options,
		});
	}
	return out;
}

function dynamicPropsMetadata(
	props: Record<string, ApPropDef>,
): Record<string, CatalogActionDynamicProp> {
	const out: Record<string, CatalogActionDynamicProp> = {};
	for (const [name, prop] of Object.entries(props)) {
		const raw = prop as {
			options?: unknown;
			refreshers?: unknown;
			refreshOnSearch?: unknown;
		};
		if (typeof raw.options !== "function") continue;
		out[name] = {
			refreshers: asStringArray(raw.refreshers),
			refreshOnSearch: raw.refreshOnSearch === true,
		};
	}
	return out;
}

/**
 * Strip digest-excluded additive fields (dynamicProps) so catalogDigest stays
 * byte-identical to rows generated before those fields existed (jsonSafe drops
 * undefined values).
 */
function digestSafeActions(
	actions: Record<string, CatalogActionMetadata>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(actions).map(([name, action]) => [
			name,
			{ ...action, dynamicProps: undefined },
		]),
	);
}

function eligibleRuntimePropCount(props: Record<string, ApPropDef>): number {
	return Object.values(props).filter((prop) => apPropToJsonSchema(prop) !== null)
		.length;
}

function fieldSummary(
	name: string,
	prop: JsonSchemaProperty,
	requiredFields: Set<string>,
): CatalogFieldSummary {
	return {
		name,
		title: prop.title ?? null,
		type: prop.type ?? null,
		description: prop.description ?? null,
		required: requiredFields.has(name),
		...(prop.enum ? { enum: prop.enum } : {}),
	};
}

// biome-ignore lint/suspicious/noExplicitAny: ActivePieces action generics are constrained to internal auth/property types.
function listActions(piece: Piece): Record<string, Action<any, any>> {
	const raw = (piece as unknown as { actions?: () => unknown }).actions?.();
	return isRecord(raw) ? (raw as Record<string, Action<any, any>>) : {};
}

function listTriggers(piece: Piece): Record<string, UnknownRecord> {
	const raw = (piece as unknown as { triggers?: () => unknown }).triggers?.();
	return isRecord(raw) ? (raw as Record<string, UnknownRecord>) : {};
}

// biome-ignore lint/suspicious/noExplicitAny: ActivePieces action generics are constrained to internal auth/property types.
function actionRequireAuth(action: Action<any, any>): boolean {
	const raw = action as unknown as { requireAuth?: boolean };
	return raw.requireAuth !== false;
}

function triggerRequireAuth(trigger: UnknownRecord): boolean {
	return trigger.requireAuth !== false;
}

function actionMetadata(
	actionName: string,
	// biome-ignore lint/suspicious/noExplicitAny: ActivePieces action generics are constrained to internal auth/property types.
	action: Action<any, any>,
): CatalogActionMetadata {
	const rawAction = action as unknown as {
		name?: string;
		displayName?: string;
		description?: string;
		props?: unknown;
	};
	const props = normalizeProps(rawAction.props);
	const inputSchema = actionPropsToSchema(props);
	if (
		eligibleRuntimePropCount(props) > 0 &&
		Object.keys(inputSchema.properties).length === 0
	) {
		throw new Error(
			`Action "${actionName}" has runtime props but generated an empty inputSchema`,
		);
	}

	const requiredSet = new Set(inputSchema.required ?? []);
	const fieldSummaries = Object.entries(inputSchema.properties).map(
		([name, prop]) => fieldSummary(name, prop, requiredSet),
	);
	const base = {
		name: rawAction.name ?? actionName,
		displayName: rawAction.displayName ?? actionName,
		description: rawAction.description ?? null,
		requireAuth: actionRequireAuth(action),
		inputSchema,
		fieldSummaries,
		requiredFields: inputSchema.required ?? [],
		props: metadataProps(props),
	};

	const dynamicProps = dynamicPropsMetadata(props);
	return {
		...base,
		digest: digest(base),
		...(Object.keys(dynamicProps).length > 0 ? { dynamicProps } : {}),
	};
}

function triggerMetadata(
	triggerName: string,
	trigger: UnknownRecord,
): CatalogTriggerMetadata {
	return {
		name: stringOrNull(trigger.name) ?? triggerName,
		displayName: stringOrNull(trigger.displayName) ?? triggerName,
		description: stringOrNull(trigger.description),
		requireAuth: triggerRequireAuth(trigger),
	};
}

export function buildPieceCatalogRow(input: {
	pieceName: string;
	piece: Piece;
	platformId?: string;
	sourceImage?: string | null;
}): PieceCatalogRow {
	const normalizedName = normalizePieceName(input.pieceName);
	const rawPiece = input.piece as unknown as UnknownRecord;
	const actions: Record<string, CatalogActionMetadata> = {};
	for (const [actionName, action] of Object.entries(listActions(input.piece))) {
		actions[actionName] = actionMetadata(actionName, action);
	}
	for (const extension of extensionsFor(normalizedName)) {
		actions[extension.name] = actionMetadata(extension.name, extension);
	}

	const triggers: Record<string, CatalogTriggerMetadata> = {};
	for (const [triggerName, trigger] of Object.entries(listTriggers(input.piece))) {
		triggers[triggerName] = triggerMetadata(triggerName, trigger);
	}

	const base = {
		name: normalizedName,
		authors: asStringArray(rawPiece.authors),
		displayName: stringOrNull(rawPiece.displayName) ?? normalizedName,
		logoUrl: stringOrNull(rawPiece.logoUrl) ?? "",
		description: stringOrNull(rawPiece.description),
		platformId: input.platformId ?? DEFAULT_PLATFORM_ID,
		version:
			stringOrNull(rawPiece.version) ?? packageVersion(normalizedName) ?? "0.0.0",
		minimumSupportedRelease:
			stringOrNull(rawPiece.minimumSupportedRelease) ?? "0.0.0",
		maximumSupportedRelease:
			stringOrNull(rawPiece.maximumSupportedRelease) ?? "9999.9999.9999",
		auth: resolveValue(rawPiece.auth) ?? null,
		actions,
		triggers,
		pieceType: "OFFICIAL",
		categories: asStringArray(rawPiece.categories),
		packageType: "REGISTRY",
		catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
		catalogSourceImage: input.sourceImage ?? null,
	};

	return {
		...base,
		catalogDigest: digest({
			...base,
			actions: digestSafeActions(actions),
			catalogSourceImage: undefined,
		}),
	};
}

export function buildPieceCatalogRows(options: {
	platformId?: string;
	sourceImage?: string | null;
	pieceNames?: string[];
} = {}): PieceCatalogRow[] {
	const names = options.pieceNames?.length
		? options.pieceNames.map(normalizePieceName)
		: Object.keys(PIECES);
	return names
		.map((pieceName) => {
			const piece = PIECES[pieceName];
			if (!piece) throw new Error(`Piece "${pieceName}" is not in the registry`);
			return buildPieceCatalogRow({
				pieceName,
				piece,
				platformId: options.platformId,
				sourceImage: options.sourceImage,
			});
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function validateCatalogMetadata(input: {
	pieceName: string;
	piece: Piece;
	row: {
		actions: Record<string, unknown> | null;
		catalogSchemaVersion: number | null;
		catalogDigest: string | null;
	};
}): PieceCatalogRow {
	const expected = buildPieceCatalogRow({
		pieceName: input.pieceName,
		piece: input.piece,
	});
	if (input.row.catalogSchemaVersion !== CATALOG_SCHEMA_VERSION) {
		throw new Error(
			`piece_metadata for "${input.pieceName}" is legacy or missing catalog_schema_version=${CATALOG_SCHEMA_VERSION}`,
		);
	}
	if (!input.row.catalogDigest) {
		throw new Error(
			`piece_metadata for "${input.pieceName}" is missing catalog_digest`,
		);
	}
	if (input.row.catalogDigest !== expected.catalogDigest) {
		throw new Error(
			`piece_metadata digest mismatch for "${input.pieceName}": db=${input.row.catalogDigest} runtime=${expected.catalogDigest}`,
		);
	}
	if (!isRecord(input.row.actions) || Object.keys(input.row.actions).length === 0) {
		throw new Error(`piece_metadata for "${input.pieceName}" has no actions`);
	}
	for (const [actionName, expectedAction] of Object.entries(expected.actions)) {
		const rawAction = input.row.actions[actionName];
		if (!isRecord(rawAction)) {
			throw new Error(
				`piece_metadata for "${input.pieceName}" is missing action "${actionName}"`,
			);
		}
		const schema = rawAction.inputSchema;
		if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) {
			throw new Error(
				`piece_metadata for "${input.pieceName}" action "${actionName}" is missing inputSchema`,
			);
		}
		if (
			Object.keys(expectedAction.inputSchema.properties).length > 0 &&
			Object.keys(schema.properties).length === 0
		) {
			throw new Error(
				`piece_metadata for "${input.pieceName}" action "${actionName}" has an empty inputSchema`,
			);
		}
	}
	return expected;
}
