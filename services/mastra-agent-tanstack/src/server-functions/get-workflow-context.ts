import { createServerFn } from "@tanstack/react-start";
import { eventBus } from "~/lib/event-bus";

export const getWorkflowContext = createServerFn({ method: "GET" }).handler(
	async () => {
		return eventBus.getWorkflowContext();
	},
);
