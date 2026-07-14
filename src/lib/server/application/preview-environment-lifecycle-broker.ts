import type {
	PreviewEnvironmentTeardownCommandPort,
	PreviewEnvironmentTeardownStatusPort,
	VclusterPreviewGatewayPort
} from '$lib/server/application/ports';
import type { VclusterPreviewTeardownTicket } from '$lib/types/dev-previews';

/** Physical command handler for ordered PreviewEnvironment + SEA teardown. */
export class ApplicationPreviewEnvironmentLifecycleBrokerService {
	constructor(
		private readonly gateway: Pick<VclusterPreviewGatewayPort, 'teardown' | 'cleanup'> &
			PreviewEnvironmentTeardownCommandPort &
			PreviewEnvironmentTeardownStatusPort
	) {}

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

	requestTeardown(
		input: Readonly<{
			name: string;
			guard: Extract<
				NonNullable<Parameters<VclusterPreviewGatewayPort['teardown']>[1]>,
				{ mode: 'owned' }
			>;
		}>
	) {
		if (!input.guard) throw new Error('preview teardown requires an ownership guard');
		return this.gateway.request(input.name, input.guard).then(({ preview, ticket }) => ({
			preview,
			ticket,
			receipt: {
				name: input.name,
				guard: input.guard,
				ticket,
				desiredStateDeletionAccepted: true as const
			}
		}));
	}

	status(ticket: VclusterPreviewTeardownTicket) {
		return this.gateway.status(ticket).then((cleanup) => ({
			cleanup,
			receipt: { ticket }
		}));
	}

	cleanup(name: string) {
		return this.gateway.cleanup(name);
	}
}
