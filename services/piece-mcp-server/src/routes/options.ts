/**
 * POST /options — dynamic dropdown option resolution for the canvas UI
 * (BFF options proxy → this service). Ported from fn-activepieces.
 *
 * Auth: the BFF proxy decrypts the connection itself and passes `auth`
 * in the body (it owns decryption); X-Connection-External-Id self-resolve
 * is supported as an alternative for header-only callers.
 */

import type http from "node:http";
import { z } from "zod";
import type { Piece } from "@activepieces/pieces-framework";
import { resolveAuth } from "../auth-resolver.js";
import { normalizePieceName } from "../piece-registry.js";
import { setSpanInput, setSpanOutput } from "../observability/content.js";

const OPTIONS_TIMEOUT_MS = Number.parseInt(
	process.env.OPTIONS_TIMEOUT_MS || "60000",
	10,
);

const OptionsRequestSchema = z.object({
	pieceName: z.string().min(1),
	actionName: z.string().min(1),
	propertyName: z.string().min(1),
	auth: z.unknown().optional(),
	input: z.record(z.string(), z.unknown()).default({}),
	searchValue: z.string().optional(),
});

export type OptionsRequest = z.infer<typeof OptionsRequestSchema>;

export type DropdownState = {
	options: Array<{ label: string; value: unknown }>;
	disabled?: boolean;
	placeholder?: string;
};

type OptionsDeps = {
	piece: Piece;
	pieceName: string;
};

function sendJson(
	res: http.ServerResponse,
	status: number,
	data: unknown,
): void {
	setSpanOutput(data);
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeoutHandle = setTimeout(() => {
					reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

/** Call a DROPDOWN prop's options() function on the loaded piece. */
async function fetchOptions(
	piece: Piece,
	request: OptionsRequest,
	auth: unknown,
): Promise<DropdownState> {
	const { actionName, propertyName, input, searchValue } = request;

	const action = piece.getAction(actionName);
	if (!action) {
		throw new Error(
			`Action "${actionName}" not found in piece "${request.pieceName}".`,
		);
	}

	const prop = (action.props as Record<string, unknown>)?.[propertyName] as
		| { options?: unknown }
		| undefined;
	if (!prop) {
		throw new Error(
			`Property "${propertyName}" not found in action "${actionName}" of piece "${request.pieceName}".`,
		);
	}

	const optionsFn = prop.options;
	if (typeof optionsFn !== "function") {
		throw new Error(
			`Property "${propertyName}" does not have a dynamic options function.`,
		);
	}

	const propsValue = { ...input, auth };
	const ctx = {
		searchValue: searchValue || "",
		server: { apiUrl: "", publicUrl: "", token: "" },
	};

	const result = await optionsFn(propsValue, ctx);

	if (result && typeof result === "object") {
		const dropdownState = result as {
			options?: Array<{ label: string; value: unknown }>;
			disabled?: boolean;
			placeholder?: string;
		};
		return {
			options: (dropdownState.options || []).map((opt) => ({
				label: String(opt.label),
				value: opt.value,
			})),
			disabled: dropdownState.disabled,
			placeholder: dropdownState.placeholder,
		};
	}

	return { options: [] };
}

export async function handleOptions(
	_req: http.IncomingMessage,
	res: http.ServerResponse,
	body: unknown,
	deps: OptionsDeps,
): Promise<void> {
	const parseResult = OptionsRequestSchema.safeParse(body);
	if (!parseResult.success) {
		sendJson(res, 400, {
			error: "Validation failed",
			details: parseResult.error.issues,
			options: [],
		});
		return;
	}

	const request = parseResult.data;
	setSpanInput({
		pieceName: request.pieceName,
		actionName: request.actionName,
		propertyName: request.propertyName,
		searchValue: request.searchValue,
	});

	if (
		normalizePieceName(request.pieceName) !==
		normalizePieceName(deps.pieceName)
	) {
		sendJson(res, 400, {
			error: `Options request targets piece "${request.pieceName}" but this runtime serves "${deps.pieceName}".`,
			options: [],
		});
		return;
	}

	const auth = request.auth ?? (await resolveAuth());

	console.log(
		`[piece-runtime] Fetching options for ${request.pieceName}/${request.actionName}.${request.propertyName}`,
	);

	try {
		const result = await withTimeout(
			fetchOptions(deps.piece, request, auth),
			OPTIONS_TIMEOUT_MS,
			`Options resolver for ${request.pieceName}/${request.actionName}.${request.propertyName}`,
		);
		console.log(
			`[piece-runtime] Options for ${request.propertyName}: ${result.options.length} items`,
		);
		sendJson(res, 200, result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const isTimeout = message.includes("timed out");
		console.error(
			`[piece-runtime] Options fetch failed for ${request.pieceName}/${request.actionName}.${request.propertyName}:`,
			error,
		);
		sendJson(res, isTimeout ? 504 : 500, { error: message, options: [] });
	}
}
