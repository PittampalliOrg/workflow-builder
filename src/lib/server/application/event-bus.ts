import {
	getApplicationAdapterConfig,
	type ApplicationAdapterConfig,
} from "$lib/server/application/config";
import { DaprEventBus } from "$lib/server/application/adapters/dapr";
import { InProcessEventBus } from "$lib/server/application/adapters/in-process";
import type { EventBus } from "$lib/server/application/ports";

// One in-process bus per process so its ring buffer observes every publish
// (getApplicationAdapters may build adapters more than once).
let inProcessBus: InProcessEventBus | null = null;

export function getEventBusAdapter(
	config: ApplicationAdapterConfig = getApplicationAdapterConfig(),
): EventBus {
	if (config.eventBusAdapter === "in-process") {
		return (inProcessBus ??= new InProcessEventBus());
	}
	if (config.eventBusAdapter !== "dapr-pubsub") {
		throw new Error(`Unsupported event bus adapter: ${config.eventBusAdapter}`);
	}
	return new DaprEventBus();
}
