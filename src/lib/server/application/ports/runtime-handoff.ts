import type { RuntimeHandoffMode } from '$lib/types/runtime-handoff';

/** Outbound runtime boundary; the Vite adapter supplies the active server mode. */
export interface RuntimeHandoffModePort {
	current(): RuntimeHandoffMode;
}
