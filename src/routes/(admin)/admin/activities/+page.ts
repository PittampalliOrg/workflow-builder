import type { PageLoad } from './$types';
import { loadActionCatalog } from '$lib/stores/action-catalog.svelte';

export const load: PageLoad = async ({ fetch, depends }) => {
	depends('app:action-catalog');
	depends('app:runtime-introspect');

	const catalog = await loadActionCatalog(fetch);
	return { catalog };
};
