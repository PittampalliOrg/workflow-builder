import { describe, expect, it } from 'vitest';
import { ApplicationRuntimeHandoffService } from '$lib/server/application/runtime-handoff';
import type { PreviewDeploymentScope } from '$lib/server/application/ports';
import type { RuntimeHandoffMode } from '$lib/types/runtime-handoff';

function service(scope: PreviewDeploymentScope, mode: RuntimeHandoffMode) {
	return new ApplicationRuntimeHandoffService({
		scope: { current: () => scope },
		mode: { current: () => mode }
	});
}

describe('ApplicationRuntimeHandoffService', () => {
	it('disables polling on the persistent control plane', () => {
		expect(service({ kind: 'control-plane' }, 'deployed').current()).toEqual({
			watch: false,
			previewName: null,
			mode: 'deployed',
			generation: 'control-plane:deployed'
		});
	});

	it('fences one preview name by deployed versus live-sync server mode', () => {
		const scope: PreviewDeploymentScope = {
			kind: 'preview',
			preview: {
				name: 'ui-proof',
				profile: 'app-live',
				platformRevision: null,
				sourceRevision: null,
				origin: 'https://ui-proof.example.test'
			}
		};
		expect(service(scope, 'deployed').current().generation).toBe('ui-proof:deployed');
		expect(service(scope, 'live-sync').current()).toMatchObject({
			watch: true,
			previewName: 'ui-proof',
			mode: 'live-sync',
			generation: 'ui-proof:live-sync'
		});
	});
});
