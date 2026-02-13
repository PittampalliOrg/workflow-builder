import { createServerFn } from "@tanstack/react-start";
import { eventBus } from "~/lib/event-bus";

export const getEventHistory = createServerFn({ method: "GET" }).handler(
	async () => {
		return eventBus.getRecentEvents(100);
	},
);
