import type { RuntimeHandoffModePort } from '$lib/server/application/ports';
import type { RuntimeHandoffMode } from '$lib/types/runtime-handoff';

/** Vite-owned adapter: development is the live-sync server, build is deployed. */
export class ViteRuntimeHandoffModeAdapter implements RuntimeHandoffModePort {
	constructor(private readonly development = import.meta.env.DEV) {}

	current(): RuntimeHandoffMode {
		return this.development ? 'live-sync' : 'deployed';
	}
}
