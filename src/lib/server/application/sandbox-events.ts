import type {
	SandboxAgentEventReadPort,
} from "$lib/server/application/ports";

export class ApplicationSandboxEventsService {
	constructor(private readonly events: SandboxAgentEventReadPort) {}

	listSandboxAgentEvents(input: {
		sandboxName: string;
		afterEventId?: number;
		limit?: number;
	}) {
		return this.events.listSandboxAgentEvents(input);
	}
}
