import { createServerFn } from "@tanstack/react-start";
import { eventBus } from "~/lib/event-bus";

export const getAgentStatus = createServerFn({ method: "GET" }).handler(
	async () => {
		return eventBus.getState();
	},
);
