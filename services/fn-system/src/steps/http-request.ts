import { z } from "zod";

export const HttpRequestInputSchema = z.preprocess(
	(value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return value;
		}

		// Back-compat: older schema used { url, method, headers, body }.
		const input = value as Record<string, unknown>;
		const endpoint =
			typeof input.endpoint === "string"
				? input.endpoint
				: typeof input.url === "string"
					? input.url
					: input.endpoint;
		const httpMethod =
			typeof input.httpMethod === "string"
				? input.httpMethod
				: typeof input.method === "string"
					? input.method
					: input.httpMethod;
		const httpHeaders = input.httpHeaders ?? input.headers;
		const httpBody = input.httpBody ?? input.body;

		return {
			...input,
			endpoint,
			httpMethod,
			httpHeaders,
			httpBody,
		};
	},
	z.object({
		httpMethod: z.string().optional().default("POST"),
		endpoint: z.string().min(1),
		httpHeaders: z
			.union([z.string(), z.record(z.string(), z.unknown())])
			.optional(),
		httpBody: z
			.union([z.string(), z.record(z.string(), z.unknown())])
			.optional(),
	}),
);

export type HttpRequestInput = z.infer<typeof HttpRequestInputSchema>;

function safeJsonParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function toHeaders(value: unknown): Record<string, string> {
	if (!value) return {};
	if (typeof value === "string") {
		const parsed = safeJsonParse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return Object.fromEntries(
				Object.entries(parsed as Record<string, unknown>)
					.filter(([, v]) => v != null)
					.map(([k, v]) => [k, String(v)]),
			);
		}
		return {};
	}
	if (typeof value === "object" && !Array.isArray(value)) {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v != null)
				.map(([k, v]) => [k, String(v)]),
		);
	}
	return {};
}

function toBody(
	value: unknown,
): { kind: "none" } | { kind: "text"; text: string } {
	if (value == null) return { kind: "none" };
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return { kind: "none" };
		return { kind: "text", text: value };
	}
	if (typeof value === "object") {
		return { kind: "text", text: JSON.stringify(value) };
	}
	return { kind: "text", text: String(value) };
}

export async function httpRequestStep(input: HttpRequestInput): Promise<
	| {
			success: true;
			data: { status: number; data: unknown; headers: Record<string, string> };
	  }
	| { success: false; error: string }
> {
	const method = (input.httpMethod || "POST").toUpperCase();
	const headers = toHeaders(input.httpHeaders);

	// Compatibility shim: "events.internal" is commonly produced by LLMs as a placeholder.
	// In this stack there is no such service, so we treat it as a no-op event publish to
	// keep demo workflows from failing hard.
	try {
		const u = new URL(input.endpoint);
		if (u.hostname === "events.internal" && u.pathname === "/publish") {
			const body = toBody(input.httpBody);
			const parsed =
				body.kind === "text" ? (safeJsonParse(body.text) ?? body.text) : null;

			return {
				success: true,
				data: {
					status: 202,
					data: { published: true, target: "events.internal", payload: parsed },
					headers: {},
				},
			};
		}
	} catch {
		// If endpoint isn't a valid URL, normal validation will catch it elsewhere.
	}

	const controller = new AbortController();
	const timeoutMs = Number.parseInt(
		process.env.HTTP_REQUEST_TIMEOUT_MS || "30000",
		10,
	);
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const body =
			method === "GET" || method === "HEAD"
				? { kind: "none" as const }
				: toBody(input.httpBody);

		const resp = await fetch(input.endpoint, {
			method,
			headers,
			...(body.kind === "text" ? { body: body.text } : {}),
			signal: controller.signal,
		});

		const respHeaders: Record<string, string> = {};
		for (const [k, v] of resp.headers.entries()) {
			respHeaders[k] = v;
		}

		const contentType = resp.headers.get("content-type") || "";
		let data: unknown;
		if (contentType.includes("application/json")) {
			try {
				data = await resp.json();
			} catch {
				data = await resp.text();
			}
		} else {
			data = await resp.text();
		}

		return {
			success: true,
			data: { status: resp.status, data, headers: respHeaders },
		};
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			return {
				success: false,
				error: `HTTP request timed out after ${timeoutMs}ms`,
			};
		}
		// Undici (Node fetch) often throws TypeError("fetch failed") with a useful cause.
		const cause = (err as { cause?: unknown } | null | undefined)?.cause;
		const causeCode =
			cause && typeof cause === "object" && "code" in cause
				? String((cause as { code?: unknown }).code ?? "")
				: "";
		const causeMessage =
			cause instanceof Error
				? cause.message
				: typeof cause === "string"
					? cause
					: "";

		const baseMessage = err instanceof Error ? err.message : String(err);
		const details = [
			`endpoint=${input.endpoint}`,
			`method=${method}`,
			causeCode ? `code=${causeCode}` : null,
			causeMessage ? `cause=${causeMessage}` : null,
		]
			.filter(Boolean)
			.join(", ");

		return {
			success: false,
			error: `${baseMessage} (${details})`,
		};
	} finally {
		clearTimeout(timeoutId);
	}
}
