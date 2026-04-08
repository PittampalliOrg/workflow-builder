import { createHighlighter, type Highlighter } from 'shiki';
import { daprFetch, getFnActivepiecesUrl, getOrchestratorUrl } from '$lib/server/dapr-client';
import {
	getCodeFunction,
	listCodeFunctions,
	toCodeFunctionDefinitionFromDetail,
	type CodeFunctionDetail,
} from '$lib/server/code-functions';
import type {
	ActionAuthMetadata,
	ActionCatalogDetail,
	ActionCatalogServiceSnapshot,
	ActionCatalogSnapshot,
	ActionFieldMetadata,
	ActionCatalogSummary,
	ActionCompatibilityStatus,
	ActionRuntimeStatus,
	ActionSwProjection,
	ActionVisibility,
} from './types';

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: ['dark-plus'],
			langs: ['python', 'typescript', 'json'],
		});
	}
	return highlighterPromise;
}

async function highlightCode(code: string, language?: string | null): Promise<string | null> {
	try {
		const highlighter = await getHighlighter();
		const lang =
			language === 'python'
				? 'python'
				: language === 'typescript' || language === 'javascript'
					? 'typescript'
					: 'json';
		return highlighter.codeToHtml(code, { lang, theme: 'dark-plus' });
	} catch {
		return null;
	}
}

async function highlightJson(value: unknown): Promise<string | null> {
	if (value === null || value === undefined) return null;
	try {
		return await highlightCode(JSON.stringify(value, null, 2), 'json');
	} catch {
		return null;
	}
}

type RemoteActionListResponse = {
	service?: string;
	ready?: boolean;
	errors?: string[];
	features?: string[];
	actions?: Array<Record<string, unknown>>;
};

type LegacyCatalogListResponse = {
	functions?: Array<{
		name?: string;
		version?: string;
		displayName?: string;
		description?: string;
		pieceName?: string;
		actionName?: string;
	}>;
};

const CACHE_TTL_MS = 30_000;
let cachedRemoteActions:
	| {
			expiresAt: number;
			items: Array<ActionCatalogDetail>;
			services: ActionCatalogServiceSnapshot[];
			partialErrors: { serviceId: string; error: string }[];
	  }
	| null = null;
let hasWarnedMissingCodeFunctionsTable = false;
let hasMissingCodeFunctionsTable = false;

type RemoteServiceDescriptor = {
	serviceId: 'workflow-orchestrator' | 'fn-activepieces';
	getBaseUrl: () => string;
	metadataPath: string;
	introspectPath: string;
};

const REMOTE_SERVICES: RemoteServiceDescriptor[] = [
	{
		serviceId: 'workflow-orchestrator',
		getBaseUrl: getOrchestratorUrl,
		metadataPath: '/api/metadata/actions',
		introspectPath: '/api/v2/runtime/introspect',
	},
	{
		serviceId: 'fn-activepieces',
		getBaseUrl: getFnActivepiecesUrl,
		metadataPath: '/api/metadata/actions',
		introspectPath: '/api/runtime/introspect',
	},
];

function buildRuntimeStatus(
	serviceReady: boolean,
	features: string[] = [],
	errors: string[] = [],
): ActionRuntimeStatus {
	return {
		registered: true,
		ready: serviceReady,
		lastSeenAt: new Date().toISOString(),
		errors,
		features,
	};
}

function buildActionId(prefix: string, slug: string): string {
	return `${prefix}.${slug}`;
}

function sanitizeText(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function humanizeLabel(value: string): string {
	return value
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join(' ');
}

function normalizeVisibility(value: unknown): ActionVisibility {
	return value === 'public-callable' ? 'public-callable' : 'inspect-only';
}

function normalizeCompatibility(value: unknown, visibility: ActionVisibility): ActionCompatibilityStatus {
	if (visibility === 'inspect-only') return 'inspect-only';
	if (value === 'compatible-with-warnings') return 'compatible-with-warnings';
	return 'compatible';
}

function normalizeStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeAuth(value: unknown): ActionAuthMetadata | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	return {
		required: record.required === true,
		displayName:
			typeof record.displayName === 'string' && record.displayName.trim().length > 0
				? record.displayName
				: null,
		description:
			typeof record.description === 'string' && record.description.trim().length > 0
				? record.description
				: null,
		kinds: normalizeStringArray(record.kinds),
		authType:
			typeof record.authType === 'string' && record.authType.trim().length > 0
				? record.authType
				: null,
		connectionResourceType:
			typeof record.connectionResourceType === 'string' &&
			record.connectionResourceType.trim().length > 0
				? record.connectionResourceType
				: null,
	};
}

function normalizeActionFieldOption(value: unknown): { label: string; value: unknown } | null {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return { label: String(value), value };
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const label =
		(typeof record.label === 'string' && record.label) ||
		(typeof record.displayName === 'string' && record.displayName) ||
		(typeof record.name === 'string' && record.name) ||
		(typeof record.title === 'string' && record.title) ||
		(typeof record.value === 'string' && record.value) ||
		(typeof record.id === 'string' && record.id) ||
		null;
	const optionValue =
		record.value ?? record.id ?? record.key ?? record.name ?? record.label;
	return label && optionValue !== undefined ? { label, value: optionValue } : null;
}

function normalizeActionFields(value: unknown): ActionFieldMetadata[] | null {
	if (!Array.isArray(value)) return null;
	return value
		.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
		.map((item) => {
			const options = item.options && typeof item.options === 'object' ? (item.options as Record<string, unknown>) : null;
			const staticValues = Array.isArray(options?.values)
				? (options.values as unknown[])
						.map(normalizeActionFieldOption)
						.filter((entry): entry is { label: string; value: unknown } => entry !== null)
				: [];
			return {
				name: typeof item.name === 'string' ? item.name : '',
				displayName:
					typeof item.displayName === 'string' && item.displayName.trim().length > 0
						? item.displayName
						: typeof item.name === 'string'
							? humanizeLabel(item.name)
							: '',
				description:
					typeof item.description === 'string' && item.description.trim().length > 0
						? item.description
						: null,
				propertyType: typeof item.propertyType === 'string' ? item.propertyType : 'string',
				schemaType: typeof item.schemaType === 'string' ? item.schemaType : 'string',
				required: item.required === true,
				defaultValue: item.defaultValue ?? null,
				dependsOn: normalizeStringArray(item.dependsOn),
				refreshers: normalizeStringArray(item.refreshers),
				refreshOnSearch: item.refreshOnSearch === true,
				options:
					options?.kind === 'dynamic'
						? {
								kind: 'dynamic' as const,
								refreshers: normalizeStringArray(options.refreshers),
								refreshOnSearch: options.refreshOnSearch === true,
							}
						: staticValues.length > 0
							? {
									kind: 'static' as const,
									values: staticValues,
								}
							: null,
			};
		})
		.filter((item) => item.name.length > 0);
}

function buildRemoteDetail(
	serviceId: string,
	serviceReady: boolean,
	serviceErrors: string[],
	serviceFeatures: string[],
	raw: Record<string, unknown>,
): ActionCatalogDetail {
	const visibility = normalizeVisibility(
		raw.visibility ??
			(raw.visibility === undefined &&
			raw.swCompatibility &&
			typeof raw.swCompatibility === 'object' &&
			(raw.swCompatibility as Record<string, unknown>).status === 'compatible'
				? 'public-callable'
				: 'inspect-only'),
	);
	const swCompatibilityRaw =
		raw.swCompatibility && typeof raw.swCompatibility === 'object'
			? (raw.swCompatibility as Record<string, unknown>)
			: {};
	const swRaw =
		raw.sw && typeof raw.sw === 'object'
			? (raw.sw as Record<string, unknown>)
			: swCompatibilityRaw;
	const runtimeRaw =
		raw.runtime && typeof raw.runtime === 'object'
			? (raw.runtime as Record<string, unknown>)
			: {};
	const compatibility = normalizeCompatibility(
		raw.compatibility ??
			(swCompatibilityRaw.status === 'compatible-with-warnings'
				? 'compatible-with-warnings'
				: swCompatibilityRaw.status === 'compatible'
					? 'compatible'
					: visibility === 'inspect-only'
						? 'inspect-only'
						: 'compatible'),
		visibility,
	);
	const sourceRaw =
		raw.source && typeof raw.source === 'object'
			? (raw.source as Record<string, unknown>)
			: {};
	const signatureRaw =
		raw.signature && typeof raw.signature === 'object'
			? (raw.signature as Record<string, unknown>)
			: {};
	const actionName =
		sanitizeText(raw.actionName) ||
		sanitizeText(raw.name) ||
		sanitizeText(raw.id) ||
		sanitizeText(swCompatibilityRaw.projection && typeof swCompatibilityRaw.projection === 'object'
			? (swCompatibilityRaw.projection as Record<string, unknown>).functionRefName
			: '');
	const inputSchema =
		raw.inputSchema && typeof raw.inputSchema === 'object'
			? (raw.inputSchema as Record<string, unknown>)
			: signatureRaw.inputSchema && typeof signatureRaw.inputSchema === 'object'
				? (signatureRaw.inputSchema as Record<string, unknown>)
				: null;
	const warnings = normalizeStringArray(swCompatibilityRaw.reasons ?? swRaw.warnings);
	const hasExecutableProjection =
		(swRaw.taskConfig && typeof swRaw.taskConfig === 'object') ||
		(swRaw.definition && typeof swRaw.definition === 'object') ||
		(raw.taskConfig && typeof raw.taskConfig === 'object') ||
		(raw.definition && typeof raw.definition === 'object');

	const runtime: ActionRuntimeStatus = {
		registered: runtimeRaw.registered !== false,
		ready: runtimeRaw.ready === true || serviceReady,
		lastSeenAt:
			typeof runtimeRaw.lastSeenAt === 'string'
				? runtimeRaw.lastSeenAt
				: new Date().toISOString(),
		errors: normalizeStringArray(runtimeRaw.errors).concat(serviceErrors),
		features: normalizeStringArray(runtimeRaw.features).length
			? normalizeStringArray(runtimeRaw.features)
			: serviceFeatures,
	};

	return {
		id: sanitizeText(raw.id) || buildActionId(serviceId, sanitizeText(raw.slug) || sanitizeText(raw.name)),
		slug: sanitizeText(raw.slug) || sanitizeText(raw.name),
		name: sanitizeText(raw.name) || sanitizeText(raw.slug),
		displayName: sanitizeText(raw.displayName) || sanitizeText(raw.name) || sanitizeText(raw.slug),
		description: sanitizeText(raw.description),
		providerId:
			sanitizeText(raw.providerId) ||
			(serviceId === 'fn-activepieces'
				? sanitizeText(raw.pieceName) || sanitizeText(raw.group)
				: serviceId),
		providerLabel:
			sanitizeText(raw.providerLabel) ||
			(serviceId === 'fn-activepieces'
				? sanitizeText(raw.providerDisplayName) ||
					humanizeLabel(sanitizeText(raw.pieceName) || sanitizeText(raw.group))
				: humanizeLabel(serviceId)),
		providerIconUrl: sanitizeText(raw.providerIconUrl) || null,
		category:
			sanitizeText(raw.category) ||
			(serviceId === 'fn-activepieces'
				? sanitizeText(raw.group) || null
				: raw.kind === 'dapr-workflow' || raw.kind === 'sw-subflow'
					? 'workflow'
					: 'activity'),
		serviceId,
		kind:
			raw.kind === 'dapr-workflow' || raw.kind === 'sw-subflow'
				? 'dapr-workflow'
				: raw.kind === 'code-function'
					? 'code-function'
					: raw.kind === 'catalog-function' || raw.kind === 'sw-function'
						? 'catalog-function'
						: 'dapr-activity',
		visibility,
		compatibility,
		group:
			sanitizeText(raw.group) ||
			sanitizeText(raw.category) ||
			(serviceId === 'fn-activepieces' ? sanitizeText(raw.pieceName) || 'Activepieces' : serviceId),
		version: sanitizeText(raw.version) || null,
		language: sanitizeText(raw.language) || null,
		entrypoint: sanitizeText(raw.entrypoint) || null,
		sourceKind:
			raw.sourceKind === 'code'
				? 'code'
				: raw.sourceKind === 'workflow'
					? 'workflow'
					: raw.sourceKind === 'activity'
						? 'activity'
						: 'integration',
		insertable:
			visibility === 'public-callable' &&
			compatibility !== 'inspect-only' &&
			Boolean(hasExecutableProjection),
		auth: normalizeAuth(raw.auth),
		fields: normalizeActionFields(raw.fields),
		tags: normalizeStringArray(raw.tags),
		doc: sanitizeText(raw.doc) || null,
		inputSchema,
		outputSchema:
			raw.outputSchema && typeof raw.outputSchema === 'object'
				? (raw.outputSchema as Record<string, unknown>)
				: null,
		semanticModel:
			raw.semanticModel && typeof raw.semanticModel === 'object'
				? (raw.semanticModel as Record<string, unknown>)
					: null,
		sourceCode: sanitizeText(raw.sourceCode) || sanitizeText(sourceRaw.sourceCode) || null,
		sourceHtml: sanitizeText(raw.sourceHtml) || null,
		sw: {
			functionName:
				sanitizeText(swRaw.functionName) ||
				sanitizeText(
					swCompatibilityRaw.projection && typeof swCompatibilityRaw.projection === 'object'
						? (swCompatibilityRaw.projection as Record<string, unknown>).functionRefName
						: '',
				) ||
				null,
			definition:
				swRaw.definition && typeof swRaw.definition === 'object'
					? (swRaw.definition as Record<string, unknown>)
					: raw.definition && typeof raw.definition === 'object'
						? (raw.definition as Record<string, unknown>)
						: null,
			taskConfig:
				swRaw.taskConfig && typeof swRaw.taskConfig === 'object'
					? (swRaw.taskConfig as Record<string, unknown>)
					: raw.taskConfig && typeof raw.taskConfig === 'object'
						? (raw.taskConfig as Record<string, unknown>)
					: null,
			warnings: [
				...warnings,
				...(visibility === 'public-callable' && !hasExecutableProjection
					? ['Action is visible but does not yet provide an executable SW projection.']
					: []),
			],
		},
		runtime,
		rendered: null,
		raw,
	};
}

function buildLegacyFnActivepiecesDetail(
	serviceReady: boolean,
	serviceErrors: string[],
	serviceFeatures: string[],
	raw: NonNullable<LegacyCatalogListResponse['functions']>[number],
): ActionCatalogDetail {
	const pieceName = sanitizeText(raw.pieceName) || 'activepieces';
	const actionName = sanitizeText(raw.actionName) || sanitizeText(raw.name);
	const displayName = sanitizeText(raw.displayName) || sanitizeText(raw.name) || actionName;
	const slug = `${pieceName}/${actionName}`;

	return {
		id: buildActionId('fn-activepieces', sanitizeText(raw.name) || slug),
		slug,
		name: sanitizeText(raw.name) || slug,
		displayName,
		description: sanitizeText(raw.description),
		providerId: pieceName,
		providerLabel: humanizeLabel(pieceName),
		providerIconUrl: null,
		category: null,
		serviceId: 'fn-activepieces',
		kind: 'catalog-function',
		visibility: 'public-callable',
		compatibility: 'compatible-with-warnings',
		group: pieceName,
		version: sanitizeText(raw.version) || '1.0.0',
		language: 'typescript',
		entrypoint: actionName || null,
		sourceKind: 'integration',
		insertable: true,
		auth: null,
		fields: null,
		tags: ['activepieces', 'legacy-catalog'],
		doc: null,
		inputSchema: null,
		outputSchema: null,
		semanticModel: null,
		sourceCode: null,
		sourceHtml: null,
		sw: {
			functionName: sanitizeText(raw.name) || slug,
			definition: {
				call: slug,
				with: {
					body: {
						input: {},
						metadata: {
							pieceName,
							actionName,
							sourceKind: 'integration',
						},
					},
				},
			},
			taskConfig: {
				call: slug,
				with: {
					body: {
						input: {},
						metadata: {
							pieceName,
							actionName,
							sourceKind: 'integration',
						},
					},
				},
			},
			warnings: [
				'Using legacy fn-activepieces catalog fallback. Rich metadata and generated schemas require the new /api/metadata/actions endpoint.',
			],
		},
		runtime: {
			registered: true,
			ready: serviceReady,
			lastSeenAt: new Date().toISOString(),
			errors: serviceErrors,
			features: serviceFeatures,
		},
		rendered: null,
		raw: {
			...raw,
			__legacyFnActivepieces: true,
			pieceName,
			actionName,
		},
	};
}

async function fetchLegacyFnActivepiecesService(
	descriptor: RemoteServiceDescriptor,
	introspectRes: Response,
): Promise<{
	actions: ActionCatalogDetail[];
	service: ActionCatalogServiceSnapshot;
}> {
	const baseUrl = descriptor.getBaseUrl();
	const catalogRes = await daprFetch(`${baseUrl}/catalog/functions`, { maxRetries: 1 });
	if (!catalogRes.ok) {
		throw new Error(`metadata HTTP 404; legacy catalog HTTP ${catalogRes.status}`);
	}

	const introspection = (await introspectRes.json()) as Record<string, unknown>;
	const catalog = (await catalogRes.json()) as LegacyCatalogListResponse;
	const ready = introspection.ready === true;
	const errors = normalizeStringArray(introspection.errors);
	const features = normalizeStringArray(introspection.features);
	const functions = Array.isArray(catalog.functions) ? catalog.functions : [];

	const details = functions.map((item) =>
		buildLegacyFnActivepiecesDetail(ready, errors, features, item),
	);

	return {
		actions: details,
		service: {
			service:
				typeof introspection.service === 'string'
					? introspection.service
					: descriptor.serviceId,
			version:
				typeof introspection.version === 'string'
					? introspection.version
					: 'unknown',
			runtime:
				typeof introspection.runtime === 'string'
					? introspection.runtime
					: 'unknown',
			ready,
			features: [...features, 'legacy-catalog-fallback'],
			registeredWorkflows: [],
			registeredActivities: details.map((item) => ({
				id: item.id,
				name: item.name,
				displayName: item.displayName,
				description: item.description,
				doc: item.doc ?? null,
				sourceCode: null,
				sourceHtml: null,
			})),
			additional:
				introspection.additional && typeof introspection.additional === 'object'
					? (introspection.additional as Record<string, unknown>)
					: {},
		},
	};
}

async function fetchRemoteService(
	descriptor: RemoteServiceDescriptor,
): Promise<{
	actions: ActionCatalogDetail[];
	service: ActionCatalogServiceSnapshot;
}> {
	const baseUrl = descriptor.getBaseUrl();
	const [metadataRes, introspectRes] = await Promise.all([
		daprFetch(`${baseUrl}${descriptor.metadataPath}`, { maxRetries: 1 }),
		daprFetch(`${baseUrl}${descriptor.introspectPath}`, { maxRetries: 1 }),
	]);

	if (!metadataRes.ok) {
		if (descriptor.serviceId === 'fn-activepieces' && metadataRes.status === 404 && introspectRes.ok) {
			return fetchLegacyFnActivepiecesService(descriptor, introspectRes);
		}
		throw new Error(`metadata HTTP ${metadataRes.status}`);
	}
	if (!introspectRes.ok) {
		throw new Error(`introspection HTTP ${introspectRes.status}`);
	}

	const payload = (await metadataRes.json()) as RemoteActionListResponse;
	const introspection = (await introspectRes.json()) as Record<string, unknown>;
	const ready = introspection.ready === true;
	const errors = normalizeStringArray(introspection.errors);
	const features = normalizeStringArray(introspection.features);
	const actions = Array.isArray(payload.actions) ? payload.actions : [];

	const details = actions
		.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
		.map((item) => buildRemoteDetail(descriptor.serviceId, ready, errors, features, item));

	const workflows = Array.isArray(introspection.registeredWorkflows)
		? introspection.registeredWorkflows
		: [];

	return {
		actions: details,
		service: {
			service:
				typeof introspection.service === 'string'
					? introspection.service
					: descriptor.serviceId,
			version:
				typeof introspection.version === 'string'
					? introspection.version
					: 'unknown',
			runtime:
				typeof introspection.runtime === 'string'
					? introspection.runtime
					: 'unknown',
			ready,
			features,
			registeredWorkflows: workflows
				.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
				.map((item) => ({
					id: buildActionId(
						`${descriptor.serviceId}-workflow`,
						`${sanitizeText(item.name)}:${sanitizeText(item.version) || 'latest'}`,
					),
					name: sanitizeText(item.name),
					version: sanitizeText(item.version) || null,
					aliases: normalizeStringArray(item.aliases),
					isLatest: item.isLatest === true,
					service: descriptor.serviceId,
					source: sanitizeText(item.source) || 'service-introspection',
				})),
			registeredActivities: details
				.filter((item) => item.kind === 'dapr-activity')
				.map((item) => ({
					id: item.id,
					name: item.name,
					displayName: item.displayName,
					description: item.description,
					doc: item.doc ?? null,
					sourceCode: item.sourceCode ?? null,
					sourceHtml: item.sourceHtml ?? null,
				})),
			additional:
				introspection.additional && typeof introspection.additional === 'object'
					? (introspection.additional as Record<string, unknown>)
					: {},
		},
	};
}

function buildCodeFunctionDetail(detail: CodeFunctionDetail): ActionCatalogDetail {
	const definition = toCodeFunctionDefinitionFromDetail(detail);
	const runtime = buildRuntimeStatus(true, ['parser-backed', 'code-runtime'], []);
	return {
		id: buildActionId('code-function', detail.id),
		slug: detail.slug,
		name: detail.slug,
		displayName: detail.name,
		description: detail.description || '',
		providerId: 'code-functions',
		providerLabel: 'Code Functions',
		providerIconUrl: null,
		category: 'code',
		serviceId: 'code-functions',
		kind: 'code-function',
		visibility: 'public-callable',
		compatibility: 'compatible',
		group: 'Code Functions',
		version: detail.latestPublishedVersion || detail.version,
		language: detail.language,
		entrypoint: detail.entrypoint,
		sourceKind: 'code',
		insertable: true,
		auth: null,
		fields: null,
		tags: [
			detail.language,
			...(detail.model.capabilities.has_dynamic_inputs ? ['dynamic-inputs'] : []),
			...(detail.model.capabilities.has_resource_types ? ['resources'] : []),
		],
		doc: null,
		inputSchema:
			definition.input && typeof definition.input === 'object'
				? ((definition.input as { schema?: { document?: Record<string, unknown> } }).schema?.document ?? null)
				: null,
		outputSchema:
			definition.output && typeof definition.output === 'object'
				? (((definition.output as unknown) as { schema?: { document?: Record<string, unknown> } }).schema?.document ?? null)
				: null,
		semanticModel:
			definition.semanticModel && typeof definition.semanticModel === 'object'
				? ((definition.semanticModel as unknown) as Record<string, unknown>)
				: null,
		sourceCode: detail.source,
		sourceHtml: null,
		sw: {
			functionName: detail.slug,
			definition: {
				call: definition.call,
				with: definition.with,
			},
			taskConfig:
				definition.taskConfig && typeof definition.taskConfig === 'object'
					? (definition.taskConfig as Record<string, unknown>)
					: null,
			warnings: Array.isArray(detail.model.diagnostics) && detail.model.diagnostics.length > 0
				? ['Parser diagnostics present']
				: [],
		},
		runtime,
		rendered: null,
		raw: definition,
	};
}

async function loadCodeFunctionActions(userId?: string | null): Promise<ActionCatalogDetail[]> {
	if (!userId) return [];
	if (hasMissingCodeFunctionsTable) return [];
	try {
		const summaries = await listCodeFunctions(userId);
		const items = await Promise.all(
			summaries.map(async (summary) => {
				const detail = await getCodeFunction(summary.id, userId);
				if (!detail) return null;
				const action = buildCodeFunctionDetail(detail);
				action.sourceHtml = await highlightCode(detail.source, detail.language);
				return action;
			}),
		);
		return items.filter((item): item is ActionCatalogDetail => item !== null);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const cause = error instanceof Error ? error.cause : null;
		const causeCode =
			typeof cause === 'object' &&
			cause !== null &&
			'code' in cause &&
			typeof cause.code === 'string'
				? cause.code
				: null;
		const missingCodeFunctionsTable =
			causeCode === '42P01' &&
			message.includes('code_functions');
		if (missingCodeFunctionsTable) {
			hasMissingCodeFunctionsTable = true;
			if (!hasWarnedMissingCodeFunctionsTable) {
				console.warn(
					'[action-catalog] code_functions table is unavailable in this environment; omitting saved code functions from the catalog.',
				);
				hasWarnedMissingCodeFunctionsTable = true;
			}
		} else {
			console.error('[action-catalog] Failed to load code functions:', error);
		}
		return [];
	}
}

async function loadRemoteActionCache(): Promise<ActionCatalogDetail[]> {
	if (cachedRemoteActions && cachedRemoteActions.expiresAt > Date.now()) {
		return cachedRemoteActions.items;
	}

	const settled = await Promise.allSettled(
		REMOTE_SERVICES.map((service) => fetchRemoteService(service)),
	);

	const actions: ActionCatalogDetail[] = [];
	const services: ActionCatalogServiceSnapshot[] = [];
	const partialErrors: { serviceId: string; error: string }[] = [];
	for (const result of settled) {
		if (result.status === 'fulfilled') {
			actions.push(...result.value.actions);
			services.push(result.value.service);
		} else {
			const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
			const message = reason || 'unknown error';
			const serviceId =
				REMOTE_SERVICES[settled.indexOf(result)]?.serviceId ?? 'unknown-service';
			partialErrors.push({ serviceId, error: message });
		}
	}

	cachedRemoteActions = {
		expiresAt: Date.now() + CACHE_TTL_MS,
		items: actions,
		services,
		partialErrors,
	};

	return actions;
}

function sortActions<T extends ActionCatalogSummary>(items: T[]): T[] {
	return [...items].sort((left, right) => {
		if (left.insertable !== right.insertable) return left.insertable ? -1 : 1;
		if (left.group !== right.group) return left.group.localeCompare(right.group);
		return left.displayName.localeCompare(right.displayName);
	});
}

export async function listActionCatalog(userId?: string | null): Promise<ActionCatalogSummary[]> {
	const [remote, code] = await Promise.all([
		loadRemoteActionCache(),
		loadCodeFunctionActions(userId),
	]);
	return sortActions([...code, ...remote]).map((item) => ({
		id: item.id,
		slug: item.slug,
		name: item.name,
		displayName: item.displayName,
		description: item.description,
		providerId: item.providerId ?? null,
		providerLabel: item.providerLabel ?? null,
		providerIconUrl: item.providerIconUrl ?? null,
		category: item.category ?? null,
		serviceId: item.serviceId,
		kind: item.kind,
		visibility: item.visibility,
		compatibility: item.compatibility,
		group: item.group,
		version: item.version,
		language: item.language,
		entrypoint: item.entrypoint,
		sourceKind: item.sourceKind,
		insertable: item.insertable,
		tags: item.tags,
		runtime: item.runtime,
		inputSchema: item.inputSchema ?? null,
	}));
}

export async function getActionCatalogDetail(
	actionId: string,
	userId?: string | null,
): Promise<ActionCatalogDetail | null> {
	async function attachRendered(detail: ActionCatalogDetail): Promise<ActionCatalogDetail> {
		detail.rendered = {
			inputSchemaHtml: await highlightJson(detail.inputSchema),
			outputSchemaHtml: await highlightJson(detail.outputSchema),
			definitionHtml: await highlightJson(detail.sw.definition ?? detail.sw.taskConfig),
			rawHtml: await highlightJson(detail.raw ?? detail),
		};
		return detail;
	}

	if (actionId.startsWith('code-function.')) {
		const id = actionId.slice('code-function.'.length);
		const detail = userId ? await getCodeFunction(id, userId) : null;
		if (!detail) return null;
		const action = buildCodeFunctionDetail(detail);
		action.sourceHtml = await highlightCode(detail.source, detail.language);
		return attachRendered(action);
	}

	const remote = await loadRemoteActionCache();
	const match = remote.find((item) => item.id === actionId);
	if (!match) return null;
	const raw = match.raw && typeof match.raw === 'object' ? (match.raw as Record<string, unknown>) : null;
	if (match.serviceId === 'fn-activepieces' && raw?.__legacyFnActivepieces === true) {
		const pieceName = sanitizeText(raw.pieceName);
		const actionName = sanitizeText(raw.actionName);
		const version = match.version || '1.0.0';
		if (pieceName && actionName) {
			try {
				const functionName = sanitizeText(raw.name) || `${pieceName}-${actionName}`;
				const res = await daprFetch(
					`${getFnActivepiecesUrl()}/catalog/functions/${encodeURIComponent(functionName)}/${encodeURIComponent(version)}/function.yaml`,
					{ maxRetries: 1 },
				);
				if (res.ok) {
					const legacyDefinition = (await res.json()) as Record<string, unknown>;
					match.sw.definition = legacyDefinition;
					match.sw.taskConfig = legacyDefinition;
					const inputSchema =
						legacyDefinition.input &&
						typeof legacyDefinition.input === 'object' &&
						(legacyDefinition.input as { schema?: { document?: Record<string, unknown> } }).schema?.document
							? ((legacyDefinition.input as { schema?: { document?: Record<string, unknown> } }).schema?.document ?? null)
							: null;
					match.inputSchema = inputSchema;
				}
			} catch {
				// Keep legacy fallback summary-only metadata if enrichment fails.
			}
		}
	}
	if (match.sourceCode && !match.sourceHtml) {
		match.sourceHtml = await highlightCode(match.sourceCode, match.language);
	}
	return attachRendered(match);
}

export async function loadActionCatalogSnapshot(
	userId?: string | null,
): Promise<ActionCatalogSnapshot> {
	const [code, remoteLoaded] = await Promise.all([
		loadCodeFunctionActions(userId),
		loadRemoteActionCache(),
	]);
	const remote = cachedRemoteActions;
	const items = sortActions([...code, ...remoteLoaded]).map((item) => ({
		id: item.id,
		name: item.name,
		version: item.version,
		displayName: item.displayName,
		description: item.description,
		insertable: item.insertable,
		providerId: item.providerId ?? null,
		providerLabel: item.providerLabel ?? null,
		providerIconUrl: item.providerIconUrl ?? null,
		category: item.category ?? null,
		auth: item.auth ?? null,
		fields: item.fields ?? null,
		pieceName: item.kind === 'code-function' ? 'code-functions' : (item.providerId || item.group),
		actionName: item.entrypoint || item.slug,
		service: item.serviceId,
		runtime: item.serviceId === 'code-functions' ? `code-${item.language || 'runtime'}` : 'dapr',
		kind:
			item.kind === 'dapr-workflow'
				? 'dapr-workflow'
				: item.kind === 'dapr-activity'
					? 'dapr-activity'
					: 'sw-function',
		visibility: item.visibility,
		sourceKind:
			item.kind === 'code-function' || item.kind === 'catalog-function' ? 'catalog' : 'runtime',
		language: item.language ?? null,
		entrypoint: item.entrypoint ?? null,
		registered: item.runtime.registered,
		ready: item.runtime.ready,
		features: item.runtime.features,
		sourceCode: item.sourceCode ?? null,
		sourceHtml: item.sourceHtml ?? null,
		doc: item.doc ?? null,
		inputSchema: item.inputSchema ?? null,
		outputSchema: item.outputSchema ?? null,
		taskConfig: item.sw.taskConfig ?? null,
		functionRef:
			item.sw.functionName
				? {
						name: item.sw.functionName,
						version: item.version,
				  }
				: null,
		warnings: item.sw.warnings,
	}));

	const codeService: ActionCatalogServiceSnapshot | null =
		code.length > 0
			? {
					service: 'code-functions',
					version: 'local',
					runtime: 'code-runtime',
					ready: true,
					features: ['parser-backed', 'sw-compatible'],
					registeredWorkflows: [],
					registeredActivities: code.map((item) => ({
						id: item.id,
						name: item.name,
						displayName: item.displayName,
						description: item.description,
						doc: item.doc ?? null,
						sourceCode: item.sourceCode ?? null,
						sourceHtml: item.sourceHtml ?? null,
					})),
					additional: {},
			  }
			: null;

	return {
		timestamp: new Date().toISOString(),
		sourceMode: 'unified',
		services: codeService ? [...(remote?.services ?? []), codeService] : (remote?.services ?? []),
		items,
		partialErrors: remote?.partialErrors ?? [],
		error: null,
	};
}
