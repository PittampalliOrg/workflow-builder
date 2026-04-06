/**
 * AI SDK tools for the workflow assistant.
 * ReAct-style: the LLM discovers actions, schemas, and connections
 * through tool calls before generating the YAML spec.
 */

import { jsonSchema } from 'ai';

import { loadActionCatalogSnapshot } from '$lib/server/action-catalog';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolSet = Record<string, any>;

/**
 * Create workflow tools with access to the current user's data.
 * Called per-request so connections are fresh.
 */
export function createWorkflowTools(userId: string | null, skFetch: typeof fetch): AnyToolSet {
	// Cache catalog snapshot per request
	let catalogCache: Awaited<ReturnType<typeof loadActionCatalogSnapshot>> | null = null;
	async function getCatalog() {
		if (!catalogCache) {
			catalogCache = await loadActionCatalogSnapshot(userId).catch(() => null);
		}
		return catalogCache;
	}

	return {
		searchActions: ({
			description: 'Search available workflow actions by keyword. Returns matching actions with their input schemas, required fields, and connection requirements. Use this to find the right action before generating a spec.',
			parameters: jsonSchema({ type: "object", properties: { query: { type: "string", description: "Search keyword, e.g. gmail send email" } }, required: ["query"] }),
			execute: async ({ query }: { query: string }) => {
				const catalog = await getCatalog() as unknown as Record<string, unknown>;
				const items = ((catalog?.items || []) as Array<Record<string, unknown>>).filter((i) => i.insertable);
				const q = query.toLowerCase();

				const matches = items.filter((item: Record<string, unknown>) =>
					(item.displayName as string || '').toLowerCase().includes(q) ||
					(item.description as string || '').toLowerCase().includes(q) ||
					(item.providerLabel as string || '').toLowerCase().includes(q) ||
					(item.pieceName as string || '').toLowerCase().includes(q) ||
					(item.name as string || '').toLowerCase().includes(q)
				).slice(0, 10);

				return matches.map((item: Record<string, unknown>) => {
					const pieceName = item.pieceName as string;
					const actionName = item.actionName as string;
					// Clean action name: "gmail-send_email" → "send_email"
					const cleanAction = actionName.startsWith(pieceName + '-')
						? actionName.slice(pieceName.length + 1)
						: actionName;

					const schema = item.inputSchema as Record<string, unknown> | null;
					const props = (schema?.properties || {}) as Record<string, Record<string, unknown>>;
					const required = (schema?.required || []) as string[];

					const fields = Object.entries(props).map(([name, def]) => ({
						name,
						type: def.type || 'string',
						required: required.includes(name),
						description: def.description || def.title || '',
						default: def.default,
					}));

					return {
						callValue: `${pieceName}/${cleanAction}`,
						displayName: item.displayName,
						description: (item.description as string || '').slice(0, 200),
						provider: item.providerLabel || pieceName,
						requiresAuth: !!(item.auth as Record<string, unknown>)?.required,
						fields,
					};
				});
			},
		}),

		getActionDetail: ({
			description: 'Get complete details for a specific action including full input schema with all fields, types, defaults, and examples. Use the callValue from searchActions (e.g., "gmail/send_email").',
			parameters: jsonSchema({ type: "object", properties: { callValue: { type: "string", description: "Action identifier e.g. gmail/send_email" } }, required: ["callValue"] }),
			execute: async ({ callValue }: { callValue: string }) => {
				const catalog = await getCatalog() as unknown as Record<string, unknown>;
				const items = ((catalog?.items || []) as Array<Record<string, unknown>>);
				const [piece, action] = callValue.split('/');

				const match = items.find((item) => {
					const p = item.pieceName as string;
					const a = item.actionName as string;
					if (p === piece) {
						const clean = a.startsWith(p + '-') ? a.slice(p.length + 1) : a;
						return clean === action || a === action;
					}
					return false;
				});

				if (!match) {
					return { error: `Action "${callValue}" not found. Use searchActions to find available actions.` };
				}

				const schema = match.inputSchema as Record<string, unknown> | null;
				const props = (schema?.properties || {}) as Record<string, Record<string, unknown>>;
				const required = (schema?.required || []) as string[];

				return {
					callValue,
					displayName: match.displayName,
					description: match.description,
					provider: match.providerLabel || match.pieceName,
					requiresAuth: !!(match.auth as Record<string, unknown>)?.required,
					inputSchema: {
						fields: Object.entries(props).map(([name, def]) => ({
							name,
							type: def.type,
							required: required.includes(name),
							description: def.description || def.title || name,
							default: def.default,
							enum: def.enum,
							format: def.format,
						})),
					},
					specExample: buildSpecExample(callValue, piece, props, required),
				};
			},
		}),

		listConnections: ({
			description: 'List available OAuth/API connections. These are pre-configured integrations the user has set up. You MUST use an existing connection when an action requires auth.',
			parameters: jsonSchema({ type: "object", properties: { pieceName: { type: "string", description: "Filter by piece name e.g. gmail. Empty string for all." } }, required: ["pieceName"] }),
			execute: async ({ pieceName }: { pieceName: string }) => {
				try {
					const res = await skFetch('/api/app-connections');
					if (!res.ok) return { connections: [] as Array<Record<string, unknown>>, error: 'Failed to fetch connections' };
					const data = await res.json();
					const all = (Array.isArray(data) ? data : data.connections || []) as Array<Record<string, unknown>>;

					const active = all
						.filter((c) => c.status === 'ACTIVE')
						.filter((c) => {
							if (!pieceName) return true;
							const shortName = (c.pieceName as string || '').replace('@activepieces/piece-', '').replace(/^@.*\//, '');
							return shortName === pieceName || (c.pieceName as string) === pieceName;
						})
						.map((c) => ({
							externalId: c.externalId as string,
							pieceName: (c.pieceName as string || '').replace('@activepieces/piece-', ''),
							displayName: (c.displayName || c.pieceName) as string,
							type: c.type as string,
						}));

					return { connections: active, error: null as string | null };
				} catch {
					return { connections: [] as Array<Record<string, unknown>>, error: 'Failed to fetch connections' };
				}
			},
		}),

		validateSpec: ({
			description: 'Validate a CNCF Serverless Workflow 1.0 YAML spec. Returns validation errors or confirms the spec is valid. Use this before presenting the spec to the user.',
			parameters: jsonSchema({ type: "object", properties: { yaml: { type: "string", description: "Complete SW 1.0 spec as YAML" } }, required: ["yaml"] }),
			execute: async (params: { yaml: string }) => {
				const yamlStr = params.yaml;
				try {
					const yamlMod = await import('js-yaml');
					const parsed = yamlMod.default.load(yamlStr) as Record<string, unknown>;
					if (!parsed || typeof parsed !== 'object') {
						return { valid: false, errors: ['Invalid YAML: not an object'], taskCount: 0, taskNames: [] as string[] };
					}
					if (!parsed.document) {
						return { valid: false, errors: ['Missing "document" section'], taskCount: 0, taskNames: [] as string[] };
					}

					// Normalize: move do from document to root if needed
					const doc = parsed.document as Record<string, unknown>;
					if (Array.isArray(doc.do) && !Array.isArray(parsed.do)) {
						parsed.do = doc.do;
						delete doc.do;
					}

					if (!Array.isArray(parsed.do) || parsed.do.length === 0) {
						return { valid: false, errors: ['Missing or empty "do" array — add at least one task'], taskCount: 0, taskNames: [] as string[] };
					}

					const tasks = parsed.do as Array<Record<string, unknown>>;
					const errors: string[] = [];
					for (const entry of tasks) {
						const name = Object.keys(entry)[0];
						const def = entry[name] as Record<string, unknown>;
						if (!def?.call) {
							errors.push(`Task "${name}" is missing a "call" value`);
						}
					}

					return {
						valid: errors.length === 0,
						errors,
						taskCount: tasks.length,
						taskNames: tasks.map(e => Object.keys(e)[0]),
					};
				} catch (e) {
					return { valid: false, errors: [`YAML parse error: ${e instanceof Error ? e.message : String(e)}`], taskCount: 0, taskNames: [] as string[] };
				}
			},
		}),
	};
}

/** Build a copy-paste ready spec example for a specific action */
function buildSpecExample(
	callValue: string,
	pieceName: string,
	props: Record<string, Record<string, unknown>>,
	required: string[],
): string {
	const taskName = callValue.split('/')[1] || 'action';
	const inputFields = Object.entries(props)
		.filter(([name]) => required.includes(name))
		.map(([name, def]) => {
			const type = def.type as string;
			if (type === 'array') return `            ${name}:\n              - example`;
			if (type === 'boolean') return `            ${name}: true`;
			if (type === 'number' || type === 'integer') return `            ${name}: 0`;
			return `            ${name}: ""`;
		})
		.join('\n');

	return `  - ${taskName}:
      call: ${callValue}
      with:
        connectionExternalId: <use listConnections to find>
        body:
          input:
${inputFields || '            {}'}
          metadata:
            pieceName: ${pieceName}
            actionName: ${callValue.split('/')[1] || ''}`;
}
