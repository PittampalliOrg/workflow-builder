import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { runAgent } from "~/lib/agent";

export const runAgentFn = createServerFn({ method: "POST" })
	.validator(z.object({ prompt: z.string() }))
	.handler(async ({ data }) => {
		return runAgent(data.prompt);
	});
