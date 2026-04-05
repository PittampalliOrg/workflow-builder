export type ActionCatalogVisibility = 'public-callable' | 'inspect-only';
export type ActionCatalogKind = 'sw-function' | 'dapr-activity' | 'dapr-workflow';
export type ActionCatalogSourceKind = 'unified' | 'catalog' | 'runtime';

export interface ActionCatalogWorkflow {
	id: string;
	name: string;
	version: string | null;
	aliases: string[];
	isLatest: boolean;
	service: string;
	source: string;
}

export interface ActionCatalogService {
	service: string;
	version: string;
	runtime: string;
	ready: boolean;
	features: string[];
	registeredWorkflows: ActionCatalogWorkflow[];
	registeredActivities: ActionCatalogItem[];
	additional: Record<string, unknown>;
}

export interface ActionCatalogItem {
	id: string;
	name: string;
	version: string | null;
	displayName: string;
	description: string;
	providerId: string | null;
	providerLabel: string | null;
	providerIconUrl: string | null;
	category: string | null;
	pieceName: string;
	actionName: string;
	service: string;
	runtime: string | null;
	kind: ActionCatalogKind;
	visibility: ActionCatalogVisibility;
	sourceKind: ActionCatalogSourceKind;
	language: 'typescript' | 'python' | null;
	entrypoint: string | null;
	registered: boolean;
	ready: boolean | null;
	features: string[];
	sourceCode: string | null;
	sourceHtml: string | null;
	doc: string | null;
	inputSchema: Record<string, unknown> | null;
	outputSchema: Record<string, unknown> | null;
	taskConfig: Record<string, unknown> | null;
	functionRef: Record<string, unknown> | null;
	insertable: boolean;
	warnings: string[];
}

export interface ActionCatalogDetail extends ActionCatalogItem {
	definition: Record<string, unknown> | null;
	auth?: {
		required: boolean;
		displayName: string | null;
		description: string | null;
		kinds: string[];
		authType?: string | null;
		connectionResourceType?: string | null;
	} | null;
	fields?: Array<{
		name: string;
		displayName: string;
		description: string | null;
		propertyType: string;
		schemaType: string;
		required: boolean;
		defaultValue: unknown | null;
		dependsOn: string[];
		refreshers: string[];
		refreshOnSearch: boolean;
		options:
			| {
					kind: 'static';
					values: Array<{ label: string; value: unknown }>;
			  }
			| {
					kind: 'dynamic';
					refreshers: string[];
					refreshOnSearch: boolean;
			  }
			| null;
	}> | null;
	rendered?: {
		inputSchemaHtml?: string | null;
		outputSchemaHtml?: string | null;
		definitionHtml?: string | null;
		rawHtml?: string | null;
	} | null;
}

export interface ActionCatalogSnapshot {
	timestamp: string;
	sourceMode: 'unified' | 'legacy';
	services: ActionCatalogService[];
	items: ActionCatalogItem[];
	partialErrors: { serviceId: string; error: string }[];
	error: string | null;
}

type FetchLike = typeof fetch;

function emptySnapshot(): ActionCatalogSnapshot {
	return {
		timestamp: new Date().toISOString(),
		sourceMode: 'legacy',
		services: [],
		items: [],
		partialErrors: [],
		error: null
	};
}

function textHead(value: string | null | undefined): string {
	return (value || '').split('\n')[0].trim();
}

function normalizePath(value: string): string {
	return value.replace(/^\//, '').trim();
}

function inferVisibility(kind: ActionCatalogKind, service: string): ActionCatalogVisibility {
	if (kind === 'dapr-workflow') return 'inspect-only';
	if (service === 'workflow-orchestrator') return 'inspect-only';
	return 'public-callable';
}

function inferKind(sourceKind: ActionCatalogSourceKind, service: string): ActionCatalogKind {
	if (sourceKind === 'catalog') return 'sw-function';
	return service === 'workflow-orchestrator' ? 'dapr-workflow' : 'dapr-activity';
}

function normalizeRuntimeActivity(
	service: ActionCatalogService,
	activity: {
		name: string;
		source?: string;
		sourceCode?: string | null;
		sourceHtml?: string | null;
		doc?: string | null;
	},
): ActionCatalogItem {
	const kind = inferKind('runtime', service.service);
	return {
		id: `runtime:${service.service}:${activity.name}`,
		name: activity.name,
		version: service.version || null,
		displayName: activity.name,
		description: textHead(activity.doc),
		providerId: service.service,
		providerLabel: service.service,
		providerIconUrl: null,
		category: null,
		pieceName: service.service,
		actionName: activity.name,
		service: service.service,
		runtime: service.runtime || null,
		kind,
		visibility: inferVisibility(kind, service.service),
		sourceKind: 'runtime',
		language: null,
		entrypoint: null,
		registered: true,
		ready: service.ready,
		features: service.features || [],
		sourceCode: activity.sourceCode ?? null,
		sourceHtml: activity.sourceHtml ?? null,
		doc: activity.doc ?? null,
		inputSchema: null,
		outputSchema: null,
		taskConfig: null,
		functionRef: null,
		insertable: false,
		warnings: service.ready ? [] : [`${service.service} is not ready`],
	};
}

function normalizeRuntimeWorkflow(
	service: ActionCatalogService,
	workflow: {
		name: string;
		version: string | null;
		aliases: string[];
		isLatest: boolean;
		source?: string;
	},
): ActionCatalogItem {
	const kind = inferKind('runtime', 'workflow-orchestrator');
	return {
		id: `workflow:${service.service}:${workflow.name}:${workflow.version || 'latest'}`,
		name: workflow.name,
		version: workflow.version,
		displayName: workflow.name,
		description: workflow.aliases.length > 0 ? `Aliases: ${workflow.aliases.join(', ')}` : 'Registered workflow',
		providerId: service.service,
		providerLabel: service.service,
		providerIconUrl: null,
		category: 'workflow',
		pieceName: service.service,
		actionName: workflow.name,
		service: service.service,
		runtime: service.runtime || null,
		kind,
		visibility: 'inspect-only',
		sourceKind: 'runtime',
		language: null,
		entrypoint: null,
		registered: true,
		ready: service.ready,
		features: service.features || [],
		sourceCode: null,
		sourceHtml: null,
		doc: null,
		inputSchema: null,
		outputSchema: null,
		taskConfig: null,
		functionRef: null,
		insertable: false,
		warnings: [],
	};
}

function normalizeCatalogFunction(entry: Record<string, unknown>): ActionCatalogItem | null {
	const name = typeof entry.name === 'string' ? entry.name : '';
	const version = typeof entry.version === 'string' ? entry.version : null;
	const displayName = typeof entry.displayName === 'string' ? entry.displayName : name;
	const description = typeof entry.description === 'string' ? entry.description : '';
	const pieceName = typeof entry.pieceName === 'string' ? entry.pieceName : 'catalog';
	const actionName = typeof entry.actionName === 'string' ? entry.actionName : '';
	const language = entry.language === 'typescript' || entry.language === 'python' ? entry.language : null;
	const kind = inferKind('catalog', pieceName === 'code-functions' ? 'code-functions' : 'fn-activepieces');
	const codeFunctionId = typeof entry.codeFunctionId === 'string' ? entry.codeFunctionId : null;

	if (!name || !version) return null;

	return {
		id: `catalog:${name}:${version}`,
		name,
		version,
		displayName,
		description,
		providerId: typeof entry.providerId === 'string' ? entry.providerId : pieceName,
		providerLabel:
			typeof entry.providerLabel === 'string'
				? entry.providerLabel
				: pieceName,
		providerIconUrl:
			typeof entry.providerIconUrl === 'string' && entry.providerIconUrl.length > 0
				? entry.providerIconUrl
				: null,
		category: typeof entry.category === 'string' ? entry.category : null,
		pieceName,
		actionName,
		service: pieceName === 'code-functions' ? 'code-runtime' : 'fn-activepieces',
		runtime:
			pieceName === 'code-functions'
				? (language ? `code-${language}` : 'code-runtime')
				: 'fn-activepieces',
		kind,
		visibility: 'public-callable',
		sourceKind: 'catalog',
		language,
		entrypoint: typeof entry.entrypoint === 'string' ? entry.entrypoint : null,
		registered: true,
		ready: true,
		features: [],
		sourceCode: null,
		sourceHtml: null,
		doc: description || null,
		inputSchema: null,
		outputSchema: null,
		taskConfig: null,
		functionRef:
			pieceName === 'code-functions'
				? (codeFunctionId ? { id: codeFunctionId, slug: name, version } : { slug: name, version })
				: { name, version },
		insertable: true,
		warnings: [],
	};
}

function combineSnapshot(
	catalogFunctions: Record<string, unknown>[],
	introspection: Record<string, unknown>,
	sourceMode: 'unified' | 'legacy',
	error: string | null,
): ActionCatalogSnapshot {
	const services: ActionCatalogService[] = [];
	const items: ActionCatalogItem[] = [];
	const partialErrors = Array.isArray(introspection.partialErrors)
		? (introspection.partialErrors as { serviceId: string; error: string }[])
		: [];

	const rawServices = Array.isArray(introspection.services) ? introspection.services : [];
	for (const rawService of rawServices) {
		const service: ActionCatalogService = {
			service: typeof rawService.service === 'string' ? rawService.service : 'unknown',
			version: typeof rawService.version === 'string' ? rawService.version : 'unknown',
			runtime: typeof rawService.runtime === 'string' ? rawService.runtime : 'unknown',
			ready: Boolean(rawService.ready),
			features: Array.isArray(rawService.features) ? (rawService.features as string[]) : [],
			registeredWorkflows: [],
			registeredActivities: [],
			additional: (rawService.additional as Record<string, unknown>) || {},
		};

		const rawWorkflows = Array.isArray(rawService.registeredWorkflows)
			? (rawService.registeredWorkflows as Array<{
					name?: unknown;
					version?: unknown;
					aliases?: unknown;
					isLatest?: unknown;
					source?: unknown;
			  }>)
			: [];
		service.registeredWorkflows = rawWorkflows
			.map((workflow: {
				name?: unknown;
				version?: unknown;
				aliases?: unknown;
				isLatest?: unknown;
				source?: unknown;
			}) => ({
				id: `workflow:${service.service}:${String(workflow.name || 'unknown')}:${String(workflow.version || 'latest')}`,
				name: String(workflow.name || 'unknown'),
				version: workflow.version ? String(workflow.version) : null,
				aliases: Array.isArray(workflow.aliases) ? (workflow.aliases as string[]) : [],
				isLatest: Boolean(workflow.isLatest),
				service: service.service,
				source: String(workflow.source || 'service-introspection'),
			}))
			.filter((workflow: { name: string }) => workflow.name);

		const rawActivities = Array.isArray(rawService.registeredActivities)
			? (rawService.registeredActivities as Array<{
					name?: unknown;
					source?: unknown;
					sourceCode?: unknown;
					sourceHtml?: unknown;
					doc?: unknown;
			  }>)
			: [];
		service.registeredActivities = rawActivities
			.map((activity: {
				name?: unknown;
				source?: unknown;
				sourceCode?: unknown;
				sourceHtml?: unknown;
				doc?: unknown;
			}) => ({
				name: String(activity.name || 'unknown'),
				source: String(activity.source || 'service-introspection'),
				sourceCode: typeof activity.sourceCode === 'string' ? activity.sourceCode : null,
				sourceHtml: typeof activity.sourceHtml === 'string' ? activity.sourceHtml : null,
				doc: typeof activity.doc === 'string' ? activity.doc : null,
			}))
			.map((activity: { name: string; source: string; sourceCode: string | null; sourceHtml: string | null; doc: string | null }) =>
				normalizeRuntimeActivity(service, activity),
			);

		services.push(service);
		items.push(...service.registeredActivities);
		items.push(...service.registeredWorkflows.map((workflow) => normalizeRuntimeWorkflow(service, workflow)));
	}

	for (const entry of catalogFunctions) {
		const item = normalizeCatalogFunction(entry);
		if (item) items.push(item);
	}

	items.sort((left, right) => {
		const serviceOrder = left.service.localeCompare(right.service);
		if (serviceOrder !== 0) return serviceOrder;
		const kindOrder = left.kind.localeCompare(right.kind);
		if (kindOrder !== 0) return kindOrder;
		return left.displayName.localeCompare(right.displayName);
	});

	return {
		timestamp: typeof introspection.timestamp === 'string' ? introspection.timestamp : new Date().toISOString(),
		sourceMode,
		services,
		items,
		partialErrors,
		error,
	};
}

function normalizeUnifiedDetail(
	item: ActionCatalogItem,
	raw: Record<string, unknown>,
): ActionCatalogDetail {
	const sw = raw.sw && typeof raw.sw === 'object'
		? (raw.sw as Record<string, unknown>)
		: {};
	return {
		...item,
		doc: typeof raw.doc === 'string' ? raw.doc : item.doc,
		sourceCode: typeof raw.sourceCode === 'string' ? raw.sourceCode : item.sourceCode,
		sourceHtml: typeof raw.sourceHtml === 'string' ? raw.sourceHtml : item.sourceHtml,
		inputSchema:
			raw.inputSchema && typeof raw.inputSchema === 'object'
				? (raw.inputSchema as Record<string, unknown>)
				: item.inputSchema,
		outputSchema:
			raw.outputSchema && typeof raw.outputSchema === 'object'
				? (raw.outputSchema as Record<string, unknown>)
				: item.outputSchema,
		taskConfig:
			sw.taskConfig && typeof sw.taskConfig === 'object'
				? (sw.taskConfig as Record<string, unknown>)
				: raw.taskConfig && typeof raw.taskConfig === 'object'
					? (raw.taskConfig as Record<string, unknown>)
				: item.taskConfig,
		insertable:
			typeof raw.insertable === 'boolean'
				? raw.insertable
				: item.insertable,
		definition:
			sw.definition && typeof sw.definition === 'object'
				? (sw.definition as Record<string, unknown>)
				: raw.definition && typeof raw.definition === 'object'
					? (raw.definition as Record<string, unknown>)
				: null,
		rendered:
			raw.rendered && typeof raw.rendered === 'object'
				? (raw.rendered as ActionCatalogDetail['rendered'])
				: null,
		warnings: Array.isArray(sw.warnings)
			? (sw.warnings as string[])
			: item.warnings,
	};
}

export async function loadActionCatalog(fetcher: FetchLike): Promise<ActionCatalogSnapshot> {
	let unifiedError: string | null = null;
	try {
		const unified = await fetcher('/api/action-catalog');
		if (unified.ok) {
			const data = await unified.json();
			if (Array.isArray(data.items)) {
				return {
					timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
					sourceMode: 'unified',
					services: Array.isArray(data.services) ? data.services : [],
					items: Array.isArray(data.items) ? data.items : [],
					partialErrors: Array.isArray(data.partialErrors) ? data.partialErrors : [],
					error: null,
				};
			}
		} else if (unified.status !== 404) {
			unifiedError = `HTTP ${unified.status}`;
		}
	} catch (error) {
		unifiedError = error instanceof Error ? error.message : String(error);
	}

	const [catalogResult, introspectionResult] = await Promise.allSettled([
		fetcher('/api/catalog/functions').then(async (res) => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			return Array.isArray(data.functions) ? (data.functions as Record<string, unknown>[]) : [];
		}),
		fetcher('/api/runtime/introspect').then(async (res) => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return (await res.json()) as Record<string, unknown>;
		}),
	]);

	const catalogFunctions =
		catalogResult.status === 'fulfilled' ? catalogResult.value : [];
	const introspection =
		introspectionResult.status === 'fulfilled' ? introspectionResult.value : {};

	const errorParts: string[] = [];
	if (catalogResult.status === 'rejected') {
		errorParts.push(catalogResult.reason instanceof Error ? catalogResult.reason.message : String(catalogResult.reason));
	}
	if (introspectionResult.status === 'rejected') {
		errorParts.push(introspectionResult.reason instanceof Error ? introspectionResult.reason.message : String(introspectionResult.reason));
	}
	if (unifiedError) {
		errorParts.unshift(unifiedError);
	}

	return combineSnapshot(
		catalogFunctions,
		introspection,
		'legacy',
		errorParts.length > 0 ? errorParts.join('; ') : null,
	);
}

export function createActionCatalogStore(initial?: ActionCatalogSnapshot) {
	let snapshot = $state<ActionCatalogSnapshot>(initial ?? emptySnapshot());
	let loading = $state(false);
	let query = $state('');
	let activeTab = $state<'all' | 'callable' | 'inspect-only' | 'activities' | 'workflows' | 'functions'>('all');
	let selectedProvider = $state<string>('all');
	let selectedCategory = $state<string>('all');
	let selectedItemId = $state<string | null>(snapshot.items[0]?.id ?? null);
	let detailById = $state<Record<string, ActionCatalogDetail>>({});

	function setSnapshot(next: ActionCatalogSnapshot) {
		snapshot = next;
		if (!selectedItemId && next.items.length > 0) {
			selectedItemId = next.items[0].id;
		}
	}

	async function load(fetcher: FetchLike = fetch): Promise<ActionCatalogSnapshot> {
		loading = true;
		try {
			const next = await loadActionCatalog(fetcher);
			setSnapshot(next);
			return next;
		} finally {
			loading = false;
		}
	}

	async function refresh(fetcher: FetchLike = fetch): Promise<ActionCatalogSnapshot> {
		return load(fetcher);
	}

	function setQuery(value: string) {
		query = value;
	}

	function setActiveTab(value: typeof activeTab) {
		activeTab = value;
	}

	function selectItem(id: string) {
		selectedItemId = id;
	}

	function matches(item: ActionCatalogItem, term: string): boolean {
		if (!term) return true;
		const q = term.toLowerCase();
		return (
			item.name.toLowerCase().includes(q) ||
			item.displayName.toLowerCase().includes(q) ||
			item.description.toLowerCase().includes(q) ||
			(item.providerLabel?.toLowerCase().includes(q) ?? false) ||
			(item.category?.toLowerCase().includes(q) ?? false) ||
			item.pieceName.toLowerCase().includes(q) ||
			item.actionName.toLowerCase().includes(q) ||
			item.service.toLowerCase().includes(q) ||
			(item.doc?.toLowerCase().includes(q) ?? false) ||
			(item.sourceCode?.toLowerCase().includes(q) ?? false)
		);
	}

	function filterByTab(item: ActionCatalogItem): boolean {
		switch (activeTab) {
			case 'callable':
				return item.visibility === 'public-callable';
			case 'inspect-only':
				return item.visibility === 'inspect-only';
			case 'activities':
				return item.kind === 'dapr-activity';
			case 'workflows':
				return item.kind === 'dapr-workflow';
			case 'functions':
				return item.kind === 'sw-function';
			default:
				return true;
		}
	}

	function filterByProvider(item: ActionCatalogItem): boolean {
		return selectedProvider === 'all' || item.providerId === selectedProvider;
	}

	function filterByCategory(item: ActionCatalogItem): boolean {
		return selectedCategory === 'all' || item.category === selectedCategory;
	}

	let filteredItems = $derived.by(() => {
		const term = query.trim();
		return snapshot.items.filter(
			(item) =>
				filterByTab(item) &&
				filterByProvider(item) &&
				filterByCategory(item) &&
				matches(item, term),
		);
	});

	let availableProviders = $derived.by(() =>
		Array.from(
			new Map(
				snapshot.items
					.filter((item) => item.providerId && item.providerLabel)
					.map((item) => [
						item.providerId!,
						{
							id: item.providerId!,
							label: item.providerLabel!,
							iconUrl: item.providerIconUrl ?? null,
						},
					]),
			).values(),
		).sort((left, right) => left.label.localeCompare(right.label)),
	);

	let availableCategories = $derived.by(() =>
		Array.from(
			new Set(
				snapshot.items
					.map((item) => item.category)
					.filter((value): value is string => typeof value === 'string' && value.length > 0),
			),
		).sort((left, right) => left.localeCompare(right)),
	);

	let selectedItem = $derived.by(() => {
		if (!selectedItemId) return filteredItems[0] ?? snapshot.items[0] ?? null;
		return snapshot.items.find((item) => item.id === selectedItemId) ?? null;
	});

	let selectedDetail = $derived.by(() => {
		if (!selectedItem) return null;
		return detailById[selectedItem.id] ?? ({ ...selectedItem, definition: null } as ActionCatalogDetail);
	});

	async function loadDetail(fetcher: FetchLike = fetch): Promise<ActionCatalogDetail | null> {
		const item = selectedItem;
		if (!item) return null;
		if (detailById[item.id]) {
			return detailById[item.id];
		}

		let detail: ActionCatalogDetail = { ...item, definition: null };
		const res = await fetcher(`/api/action-catalog/${encodeURIComponent(item.id)}`);
		if (res.ok) {
			detail = normalizeUnifiedDetail(
				item,
				(await res.json()) as Record<string, unknown>,
			);
		}
		detailById = { ...detailById, [item.id]: detail };
		return detail;
	}

	return {
		get snapshot() {
			return snapshot;
		},
		get services() {
			return snapshot.services;
		},
		get items() {
			return snapshot.items;
		},
		get partialErrors() {
			return snapshot.partialErrors;
		},
		get timestamp() {
			return snapshot.timestamp;
		},
		get error() {
			return snapshot.error;
		},
		get loading() {
			return loading;
		},
		get query() {
			return query;
		},
		set query(value: string) {
			query = value;
		},
		get activeTab() {
			return activeTab;
		},
		set activeTab(value) {
			activeTab = value;
		},
		get filteredItems() {
			return filteredItems;
		},
		get availableProviders() {
			return availableProviders;
		},
		get availableCategories() {
			return availableCategories;
		},
		get selectedProvider() {
			return selectedProvider;
		},
		set selectedProvider(value: string) {
			selectedProvider = value;
		},
		get selectedCategory() {
			return selectedCategory;
		},
		set selectedCategory(value: string) {
			selectedCategory = value;
		},
		get selectedItem() {
			return selectedItem;
		},
		get selectedDetail() {
			return selectedDetail;
		},
		get selectedItemId() {
			return selectedItemId;
		},
		set selectedItemId(value: string | null) {
			selectedItemId = value;
		},
		load,
		refresh,
		replaceSnapshot: setSnapshot,
		setQuery,
		setActiveTab,
		selectItem,
		loadDetail,
	};
}
