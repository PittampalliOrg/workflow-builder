import {
	getApplicationAdapterConfig,
	type ApplicationAdapterConfig,
} from "$lib/server/application/config";
import { DaprEventBus } from "$lib/server/application/adapters/dapr";
import type { EventBus } from "$lib/server/application/ports";

export function getEventBusAdapter(
	config: ApplicationAdapterConfig = getApplicationAdapterConfig(),
): EventBus {
	if (config.eventBusAdapter !== "dapr-pubsub") {
		throw new Error(`Unsupported event bus adapter: ${config.eventBusAdapter}`);
	}
	return new DaprEventBus();
}
