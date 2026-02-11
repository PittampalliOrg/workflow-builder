import { z } from "zod";

export const HttpRequestInputSchema = z.object({
	httpMethod: z.string().optional().default("POST"),
	endpoint: z.string().min(1),
	httpHeaders: z
		.union([z.string(), z.record(z.string(), z.unknown())])
		.optional(),
	httpBody: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
});

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
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		clearTimeout(timeoutId);
	}
}
