/**
 * Catalog store — caches AP piece function catalog for the function browser.
 */

export interface CatalogFunction {
	name: string;
	version: string;
	displayName: string;
	description: string;
	pieceName: string;
	actionName: string;
}

export interface CatalogGroup {
	pieceName: string;
	functions: CatalogFunction[];
}

export function createCatalogStore() {
	let functions = $state<CatalogFunction[]>([]);
	let loading = $state(false);
	let loaded = $state(false);
	let error = $state<string | null>(null);

	async function load() {
		if (loaded || loading) return;
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/catalog/functions');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			functions = data.functions || [];
			loaded = true;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	function search(query: string): CatalogGroup[] {
		const q = query.toLowerCase().trim();
		const filtered = q
			? functions.filter(
					(f) =>
						f.displayName.toLowerCase().includes(q) ||
						f.pieceName.toLowerCase().includes(q) ||
						f.actionName.toLowerCase().includes(q) ||
						f.description.toLowerCase().includes(q)
				)
			: functions;

		// Group by piece
		const groups = new Map<string, CatalogFunction[]>();
		for (const fn of filtered) {
			const list = groups.get(fn.pieceName) || [];
			list.push(fn);
			groups.set(fn.pieceName, list);
		}

		return Array.from(groups.entries())
			.map(([pieceName, fns]) => ({ pieceName, functions: fns }))
			.sort((a, b) => a.pieceName.localeCompare(b.pieceName));
	}

	async function getDefinition(name: string, version: string): Promise<Record<string, unknown>> {
		const res = await fetch(`/api/catalog/functions/${name}/${version}`);
		if (!res.ok) throw new Error(`Failed to fetch function definition: HTTP ${res.status}`);
		return res.json();
	}

	return {
		get functions() { return functions; },
		get loading() { return loading; },
		get loaded() { return loaded; },
		get error() { return error; },
		load,
		search,
		getDefinition,
	};
}
