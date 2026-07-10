import type { VclusterPreviewGatewayPort } from '$lib/server/application/ports';

/** Physical command handler for ordered PreviewEnvironment + SEA teardown. */
export class ApplicationPreviewEnvironmentLifecycleBrokerService {
	constructor(private readonly gateway: Pick<VclusterPreviewGatewayPort, 'teardown' | 'cleanup'>) {}

	teardown(
		input: Readonly<{
			name: string;
			guard: NonNullable<Parameters<VclusterPreviewGatewayPort['teardown']>[1]>;
		}>
	) {
		if (!input.guard) throw new Error('preview teardown requires an ownership guard');
		return this.gateway.teardown(input.name, input.guard).then((preview) => ({
			preview,
			receipt: {
				name: input.name,
				guard: input.guard,
				desiredStateAbsent: true as const
			}
		}));
	}

	cleanup(name: string) {
		return this.gateway.cleanup(name);
	}
}
