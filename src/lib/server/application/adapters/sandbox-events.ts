import type { SandboxAgentEventReadPort } from "$lib/server/application/ports";
import { listSandboxAgentEvents } from "$lib/server/application/adapters/execution-read-model";

export class LegacySandboxAgentEventReadPort implements SandboxAgentEventReadPort {
	listSandboxAgentEvents(input: {
		sandboxName: string;
		afterEventId?: number;
		limit?: number;
	}) {
		return listSandboxAgentEvents(
			input.sandboxName,
			input.afterEventId ?? 0,
			input.limit ?? 200,
		);
	}
}
