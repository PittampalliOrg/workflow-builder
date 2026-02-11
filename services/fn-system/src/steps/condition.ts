import vm from "node:vm";
import { z } from "zod";

export const ConditionInputSchema = z.object({
	condition: z.string().min(1),
});

export type ConditionInput = z.infer<typeof ConditionInputSchema>;

export async function conditionStep(
	input: ConditionInput,
): Promise<
	| { success: true; data: { result: boolean; branch: "true" | "false" } }
	| { success: false; error: string }
> {
	const timeoutMs = Number.parseInt(
		process.env.CONDITION_EVAL_TIMEOUT_MS || "100",
		10,
	);

	try {
		const sandbox: Record<string, unknown> = {
			Math,
			Date,
			Number,
			String,
			Boolean,
			JSON,
		};

		const ctx = vm.createContext(sandbox);
		const script = new vm.Script(
			`(function(){ return (${input.condition}); })()`,
		);

		const value = script.runInContext(ctx, { timeout: timeoutMs });
		const result = Boolean(value);

		return {
			success: true,
			data: { result, branch: result ? "true" : "false" },
		};
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
