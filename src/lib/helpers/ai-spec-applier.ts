/**
 * Applies a new SW 1.0 spec to the workflow store.
 * Validates with SDK, rebuilds the graph, enriches nodes, and auto-layouts.
 * All changes are batched to avoid canvas flicker.
 */

import type { createWorkflowStore } from '$lib/stores/workflow.svelte';

type WorkflowStore = ReturnType<typeof createWorkflowStore>;

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

	// 1. Validate with SDK (dynamic import for SSR compat)
	try {
		const { validateSpec } = await import('$lib/utils/spec-validator');
		const validation = validateSpec(spec);
		if (!validation.valid) {
			console.warn('[ai-spec-applier] Validation failed:', validation.errors);
			errors.push(...validation.errors);
		}
	} catch (err) {
		console.warn('[ai-spec-applier] Validation skipped:', err);
	}

	// 2. Set spec on store (but DON'T rebuild yet — we batch everything)
	store.spec = spec;

	// 3. Rebuild graph from spec (get nodes/edges without setting them on store yet)
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

	// 4. Enrich call nodes with AP catalog metadata BEFORE setting on store
	const enrichedNodes = await enrichNodesOffline(spec, newNodes);

	// 5. Auto-layout with ELK (on the enriched nodes, before setting on store)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let layoutedNodes = enrichedNodes as any[];
	try {
		const { layoutElkWorkflowNodes } = await import('$lib/utils/layout/elk-layout');
		if (enrichedNodes.length > 1) {
			layoutedNodes = await layoutElkWorkflowNodes(enrichedNodes as any[], newEdges as any[], {
				direction: 'TB',
				nodeWidth: 148,
				nodeHeight: 148,
				rankSep: 60,
				nodeSep: 40,
			}) as typeof store.nodes;
		}
	} catch (err) {
		console.warn('[ai-spec-applier] Auto-layout skipped:', err);
	}

	// 6. NOW set nodes/edges on store in one batch — single canvas render
	store.nodes = layoutedNodes as typeof store.nodes;
	store.edges = newEdges as typeof store.edges;
	store.isDirty = true;

	// 7. Auto-save to DB
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
