import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { runAgent } from "~/lib/agent";

export const runAgentFn = createServerFn({ method: "POST" })
	.inputValidator(z.object({ prompt: z.string() }))
	.handler(async ({ data }: { data: { prompt: string } }) => {
		return runAgent(data.prompt);
	});
