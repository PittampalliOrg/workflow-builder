/**
 * Applies a new SW 1.0 spec to the workflow store.
 * Validates with SDK, rebuilds the graph, enriches nodes, and auto-layouts.
 * All changes are batched to avoid canvas flicker.
 */

import type { createWorkflowStore } from '$lib/stores/workflow.svelte';

type WorkflowStore = ReturnType<typeof createWorkflowStore>;

function getTaskCount(spec: Record<string, unknown> | null | undefined): number {
	const doArray = spec?.do;
	return Array.isArray(doArray) ? doArray.length : 0;
}

function getTaskEntries(spec: Record<string, unknown>): Array<Record<string, unknown>> {
	return Array.isArray(spec.do) ? spec.do as Array<Record<string, unknown>> : [];
}

function taskNames(spec: Record<string, unknown>): string[] {
	return getTaskEntries(spec).map((entry) => Object.keys(entry)[0]).filter(Boolean);
}

function inferNodeType(taskDef: Record<string, unknown> | undefined): string {
	if (!taskDef) return 'call';
	if (taskDef.call) return 'call';
	if (taskDef.set) return 'set';
	if (taskDef.switch) return 'switch';
	if (taskDef.wait) return 'wait';
	if (taskDef.emit) return 'emit';
	if (taskDef.listen) return 'listen';
	if (taskDef.for) return 'for';
	if (taskDef.fork) return 'fork';
	if (taskDef.try) return 'try';
	if (taskDef.do) return 'do';
	if (taskDef.run) return 'run';
	if (taskDef.raise) return 'raise';
	return 'call';
}

function buildLinearGraphFallback(spec: Record<string, unknown>): {
	nodes: Array<Record<string, unknown>>;
	edges: Array<Record<string, unknown>>;
} {
	const entries = getTaskEntries(spec);
	if (entries.length === 0) return { nodes: [], edges: [] };

	const nodes: Array<Record<string, unknown>> = [{
		id: '__start__',
		type: 'start',
		position: { x: 250, y: 50 },
		data: { label: 'Start', type: 'start', taskConfig: {}, status: 'idle', enabled: true },
	}];
	const edges: Array<Record<string, unknown>> = [];
	let previousId = '__start__';

	entries.forEach((entry, index) => {
		const taskName = Object.keys(entry)[0];
		if (!taskName) return;
		const taskDef = entry[taskName] as Record<string, unknown> | undefined;
		const nodeId = `/do/${index}/${taskName}`;
		const nodeType = inferNodeType(taskDef);
		nodes.push({
			id: nodeId,
			type: nodeType,
			position: { x: 250, y: 200 + (index * 150) },
			data: {
				label: taskName,
				type: nodeType,
				taskConfig: taskDef || {},
				status: 'idle',
				enabled: true,
			},
		});
		edges.push({ id: `${previousId}->${nodeId}`, source: previousId, target: nodeId });
		previousId = nodeId;
	});

	nodes.push({
		id: '__end__',
		type: 'end',
		position: { x: 250, y: 200 + (entries.length * 150) },
		data: { label: 'End', type: 'end', taskConfig: {}, status: 'idle', enabled: true },
	});
	edges.push({ id: `${previousId}->__end__`, source: previousId, target: '__end__' });

	return { nodes, edges };
}

/**
 * Apply a new spec to the workflow store.
 * Validates, rebuilds graph, enriches, layouts — all in one batch.
 */
export async function applySpec(
	store: WorkflowStore,
	newSpec: Record<string, unknown>,
): Promise<{ success: boolean; errors: string[] }> {
	const errors: string[] = [];

	// 0. Normalize spec structure — handle LLM putting `do` inside `document`
	let spec = newSpec;
	const doc = spec.document as Record<string, unknown> | undefined;
	if (doc && Array.isArray(doc.do) && !Array.isArray(spec.do)) {
		spec = { ...spec, do: doc.do };
		spec.document = { ...doc };
		delete (spec.document as Record<string, unknown>).do;
	}

	const currentTaskCount = getTaskCount(store.spec);
	const nextTaskCount = getTaskCount(spec);
	if (nextTaskCount === 0) {
		return {
			success: false,
			errors: [
				currentTaskCount > 0
					? 'Refusing to apply an AI spec that would remove every existing task.'
					: 'Refusing to apply an AI spec with no tasks.',
			],
		};
	}

	// 1. Validate with SDK (dynamic import for SSR compat)
	try {
		const { validateSpec } = await import('$lib/utils/spec-validator');
		const validation = validateSpec(spec);
		if (!validation.valid) {
			console.warn('[ai-spec-applier] Validation failed:', validation.errors);
			errors.push(...validation.errors);
			return { success: false, errors };
		}
	} catch (err) {
		console.warn('[ai-spec-applier] Validation skipped:', err);
	}

	// 2. Rebuild graph from spec (get nodes/edges without setting them on store yet)
	let newNodes: typeof store.nodes = [];
	let newEdges: typeof store.edges = [];
	try {
		const { specToGraph } = await import('$lib/utils/spec-graph-adapter');
		const graph = specToGraph(spec, {});
		if (graph) {
			newNodes = graph.nodes as typeof store.nodes;
			newEdges = graph.edges as typeof store.edges;
		}
	} catch (err) {
		console.warn('[ai-spec-applier] Graph rebuild failed:', err);
	}

	if (newNodes.length === 0 && nextTaskCount > 0) {
		const fallback = buildLinearGraphFallback(spec);
		newNodes = fallback.nodes as typeof store.nodes;
		newEdges = fallback.edges as typeof store.edges;
	}

	if (newNodes.length === 0) {
		return {
			success: false,
			errors: [`Refusing to apply an AI spec because it could not be rendered on the canvas. Task count: ${nextTaskCount}. Task names: ${taskNames(spec).join(', ') || '(none)'}.`],
		};
	}

	const renderedTaskNodeCount = newNodes.filter((node) => node.type !== 'start' && node.type !== 'end').length;
	if (renderedTaskNodeCount === 0 && nextTaskCount > 0) {
		const fallback = buildLinearGraphFallback(spec);
		newNodes = fallback.nodes as typeof store.nodes;
		newEdges = fallback.edges as typeof store.edges;
	}
	const fallbackRenderedTaskNodeCount = newNodes.filter((node) => node.type !== 'start' && node.type !== 'end').length;
	if (nextTaskCount > 0 && fallbackRenderedTaskNodeCount === 0) {
		return {
			success: false,
			errors: [`Refusing to apply an AI spec because its tasks could not be rendered on the canvas. Task count: ${nextTaskCount}. Task names: ${taskNames(spec).join(', ') || '(none)'}. Rendered task nodes: ${fallbackRenderedTaskNodeCount}.`],
		};
	}

	// 3. Enrich call nodes with AP catalog metadata BEFORE setting on store
	const enrichedNodes = await enrichNodesOffline(spec, newNodes);

	// 4. Auto-layout with ELK (on the enriched nodes, before setting on store)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let layoutedNodes = enrichedNodes as any[];
	try {
		const { layoutWorkflowGraph, suggestLayoutConfig } = await import('$lib/utils/layout');
		if (enrichedNodes.length > 1) {
			const layoutConfig = store.layoutConfigTouched
				? store.layoutConfig
				: suggestLayoutConfig(
						enrichedNodes as unknown as typeof store.nodes,
						newEdges as unknown as typeof store.edges,
						store.layoutConfig
					);

			if (!store.layoutConfigTouched) {
				store.setLayoutConfig(layoutConfig, { touched: false });
			}

			layoutedNodes = await layoutWorkflowGraph(
				enrichedNodes as any[],
				newEdges as any[],
				layoutConfig
			) as typeof store.nodes;
		}
	} catch (err) {
		console.warn('[ai-spec-applier] Auto-layout skipped:', err);
	}

	// 5. NOW set spec/nodes/edges on store in one batch — single canvas render
	store.spec = spec;
	store.nodes = layoutedNodes as typeof store.nodes;
	store.edges = newEdges as typeof store.edges;
	store.isDirty = true;

	// 6. Auto-save to DB
	if (store.workflowId) {
		try {
			await fetch(`/api/workflows/${store.workflowId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: store.workflowName,
					nodes: store.nodes,
					edges: store.edges,
					spec: store.spec,
				}),
			});
			store.isDirty = false;
		} catch {
			// Save failed — user can save manually
		}
	}

	return { success: true, errors };
}

/**
 * Enrich call nodes with AP catalog metadata without touching the store.
 * Returns a new array of nodes with enrichment applied.
 */
async function enrichNodesOffline(
	spec: Record<string, unknown>,
	nodes: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
	const doArray = ((spec as Record<string, unknown>).do || []) as Array<Record<string, unknown>>;

	const callTasks: { taskName: string; callValue: string }[] = [];
	for (const entry of doArray) {
		const taskName = Object.keys(entry)[0];
		const taskDef = entry[taskName] as Record<string, unknown>;
		if (!taskDef || typeof taskDef !== 'object') continue;
		const callValue = taskDef.call as string | undefined;
		if (!callValue || callValue === 'http' || callValue === 'grpc') continue;
		callTasks.push({ taskName, callValue });
	}

	if (callTasks.length === 0) return nodes as Array<Record<string, unknown>>;

	let catalogItems: Array<Record<string, unknown>>;
	try {
		const res = await fetch('/api/action-catalog');
		if (!res.ok) return nodes as Array<Record<string, unknown>>;
		const snapshot = await res.json();
		catalogItems = snapshot.items || [];
	} catch {
		return nodes as Array<Record<string, unknown>>;
	}

	// Also fetch connections for auto-attach
	let connections: Array<Record<string, unknown>> = [];
	try {
		const res = await fetch('/api/app-connections');
		if (res.ok) {
			const data = await res.json();
			connections = (Array.isArray(data) ? data : data.connections || [])
				.filter((c: Record<string, unknown>) => c.status === 'ACTIVE');
		}
	} catch { /* silent */ }

	let enrichedNodes = [...nodes] as Array<Record<string, unknown>>;

	for (const { taskName, callValue } of callTasks) {
		const parts = callValue.split('/');
		const provider = parts[0];
		const action = parts[1];

		let match = catalogItems.find(
			(i) => i.name === `${provider}-${action}` || i.name === callValue.replace('/', '-'),
		);

		if (!match && provider && action) {
			match = catalogItems.find(
				(i) =>
					(i.providerId as string || '').toLowerCase() === provider.toLowerCase() &&
					((i.name as string) || '').toLowerCase().includes(action.toLowerCase()) &&
					i.insertable,
			);
		}

		if (!match) continue;

		const catalogMeta = {
			label: match.displayName as string,
			// actionCatalogDetail provides providerIconUrl for the call-node icon
			actionCatalogDetail: {
				providerIconUrl: match.providerIconUrl as string | null,
				displayName: match.displayName as string,
				providerId: match.providerId as string,
			},
			catalogFunction: match.service === 'fn-activepieces' ? {
				name: match.name as string,
				displayName: match.displayName as string,
				pieceName: (match.providerId || match.pieceName) as string,
				actionName: match.actionName as string,
			} : undefined,
		};

		// Apply to matching nodes
		enrichedNodes = enrichedNodes.map((n) => {
			const nId = (n.id as string) || '';
			if (nId.includes(taskName)) {
				return { ...n, data: { ...(n.data as Record<string, unknown>), ...catalogMeta } };
			}
			return n;
		});

		// Auto-attach connection
		const pieceName = (match.providerId || match.pieceName) as string;
		if (pieceName && connections.length > 0) {
			const conn = connections.find((c) => {
				const connPiece = ((c.pieceName as string) || '').toLowerCase().replace('@activepieces/piece-', '');
				return connPiece.includes(pieceName.toLowerCase());
			});
			if (conn) {
				// Update the spec task's connectionExternalId
				const taskEntry = doArray.find((e) => Object.keys(e)[0] === taskName);
				if (taskEntry) {
					const taskDef = taskEntry[taskName] as Record<string, unknown>;
					const withBlock = (taskDef.with || {}) as Record<string, unknown>;
					taskEntry[taskName] = {
						...taskDef,
						with: { ...withBlock, connectionExternalId: conn.externalId },
					};
				}
			}
		}
	}

	return enrichedNodes;
}
