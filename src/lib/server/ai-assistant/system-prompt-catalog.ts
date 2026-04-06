/**
 * Build a compact catalog summary from action catalog items for the system prompt.
 */

import type { CatalogSummary } from './system-prompt';

export function buildCatalogSummary(
	items: Array<{
		name?: string;
		displayName?: string;
		group?: string;
		providerId?: string | null;
		providerLabel?: string | null;
		insertable?: boolean;
		inputSchema?: Record<string, unknown> | null;
	}>,
): CatalogSummary {
	const providerMap = new Map<string, { displayName: string; actions: { name: string; displayName: string; args?: string[] }[] }>();

	for (const item of items) {
		if (!item.insertable) continue;
		const provId = item.providerId || item.group || 'other';
		const provLabel = item.providerLabel || item.group || provId;

		if (!providerMap.has(provId)) {
			providerMap.set(provId, { displayName: provLabel, actions: [] });
		}

		const provider = providerMap.get(provId)!;
		if (provider.actions.length >= 8) continue;

		let args: string[] | undefined;
		if (item.inputSchema && typeof item.inputSchema === 'object') {
			const schema = item.inputSchema as Record<string, unknown>;
			const props = (schema.properties || schema.required) as Record<string, unknown> | string[] | undefined;
			if (Array.isArray(props)) {
				args = props.slice(0, 4);
			} else if (props && typeof props === 'object') {
				args = Object.keys(props).slice(0, 4);
			}
		}

		provider.actions.push({
			name: item.name || '',
			displayName: item.displayName || item.name || '',
			args,
		});
	}

	return {
		providers: Array.from(providerMap.entries())
			.map(([name, data]) => ({ name, ...data }))
			.sort((a, b) => b.actions.length - a.actions.length),
	};
}
