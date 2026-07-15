import type {
	PreviewDeploymentScopePort,
	RuntimeHandoffModePort
} from '$lib/server/application/ports';
import type { RuntimeHandoffIdentity } from '$lib/types/runtime-handoff';

/**
 * Identifies the server generation behind a preview origin. The browser uses
 * this to perform one full reload when Kubernetes hands the Service between the
 * deployed BFF and the live-sync Vite pod.
 */
export class ApplicationRuntimeHandoffService {
	constructor(
		private readonly deps: {
			scope: Pick<PreviewDeploymentScopePort, 'current'>;
			mode: RuntimeHandoffModePort;
		}
	) {}

	current(): RuntimeHandoffIdentity {
		const scope = this.deps.scope.current();
		const mode = this.deps.mode.current();
		if (scope.kind === 'control-plane') {
			return {
				watch: false,
				previewName: null,
				mode,
				generation: `control-plane:${mode}`
			};
		}
		return {
			watch: true,
			previewName: scope.preview.name,
			mode,
			generation: `${scope.preview.name}:${mode}`
		};
	}
}
