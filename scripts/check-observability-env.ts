#!/usr/bin/env tsx

import process from "node:process";
import { getConfiguration, isAvailable } from "@/lib/dapr/client";

type CheckResult = {
	name: string;
	ok: boolean;
	details: string;
};

const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_JAEGER_QUERY_URL =
	"http://jaeger-query.observability.svc.cluster.local:16686";
const DEFAULT_JAEGER_QUERY_SERVICE =
	process.env.OTEL_SERVICE_NAME?.trim() || "workflow-builder";

const JAEGER_QUERY_CONFIG_KEY = "jaeger-query-url";
const DAPR_CONFIG_STORE =
	process.env.DAPR_CONFIG_STORE || "azureappconfig-workflow-builder";
const DAPR_CONFIG_LABEL = process.env.CONFIG_LABEL || "workflow-builder";

async function resolveJaegerQueryUrl(): Promise<{
	value: string;
	source: "dapr-config" | "env" | "default";
}> {
	if (await isAvailable()) {
		const stores =
			DAPR_CONFIG_STORE === "azureappconfig"
				? ["azureappconfig"]
				: [DAPR_CONFIG_STORE, "azureappconfig"];

		for (const storeName of stores) {
			try {
				const cfg = await getConfiguration(
					storeName,
					[JAEGER_QUERY_CONFIG_KEY],
					{
						label: DAPR_CONFIG_LABEL,
					},
				);
				const value = cfg[JAEGER_QUERY_CONFIG_KEY]?.value?.trim();
				if (value) {
					return { value, source: "dapr-config" };
				}
			} catch {
				// Try next store
			}
		}
	}

	const envValue = process.env.JAEGER_QUERY_URL?.trim();
	if (envValue) {
		return { value: envValue, source: "env" };
	}

	return {
		value: DEFAULT_JAEGER_QUERY_URL,
		source: "default",
	};
}

function parseOptionalHeaders(raw: string | undefined): HeadersInit {
	if (!raw) {
		return {};
	}

	const headers: Record<string, string> = {};
	for (const pair of raw.split(",")) {
		const [k, ...rest] = pair.split("=");
		const key = k?.trim();
		const value = rest.join("=").trim();
		if (key && value) {
			headers[key] = value;
		}
	}

	return headers;
}

async function fetchWithTimeout(
	url: string,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				...parseOptionalHeaders(process.env.JAEGER_QUERY_HEADERS),
			},
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

async function run() {
	const timeoutMs = Number.parseInt(process.env.CHECK_TIMEOUT_MS ?? "", 10);
	const requestTimeoutMs = Number.isFinite(timeoutMs)
		? timeoutMs
		: DEFAULT_TIMEOUT_MS;

	const results: CheckResult[] = [];
	const urlResolution = await resolveJaegerQueryUrl();
	const rawUrl = urlResolution.value.trim();
	const configuredJaegerService =
		process.env.JAEGER_QUERY_SERVICE?.trim() || "";
	const jaegerService = configuredJaegerService || DEFAULT_JAEGER_QUERY_SERVICE;

	if (!rawUrl) {
		results.push({
			name: "JAEGER_QUERY_URL",
			ok: false,
			details:
				"Empty Jaeger query URL (Dapr config/env/default resolution failed)",
		});
	} else {
		try {
			const parsed = new URL(rawUrl);
			results.push({
				name: "JAEGER_QUERY_URL",
				ok: true,
				details: `Resolved Jaeger base URL (${urlResolution.source}): ${parsed.toString()}`,
			});
		} catch {
			results.push({
				name: "JAEGER_QUERY_URL",
				ok: false,
				details: `Invalid Jaeger query URL: ${rawUrl}`,
			});
		}
	}

	const validBase = results.find(
		(result) => result.name === "JAEGER_QUERY_URL",
	)?.ok;
	if (validBase) {
		const base = rawUrl.replace(/\/$/, "");

		try {
			const servicesRes = await fetchWithTimeout(
				`${base}/api/services`,
				requestTimeoutMs,
			);
			if (!servicesRes.ok) {
				results.push({
					name: "Jaeger Reachability",
					ok: false,
					details: `GET /api/services failed with status ${servicesRes.status}`,
				});
			} else {
				const body = (await servicesRes.json()) as {
					data?: unknown;
				};
				const services = Array.isArray(body.data) ? body.data : [];
				results.push({
					name: "Jaeger Reachability",
					ok: true,
					details: `Jaeger reachable; ${services.length} services discovered`,
				});

				const found = services.some(
					(service) => typeof service === "string" && service === jaegerService,
				);
				results.push({
					name: "JAEGER_QUERY_SERVICE",
					ok: found,
					details: found
						? `${configuredJaegerService ? "Configured" : "Default"} service '${jaegerService}' exists in Jaeger services list`
						: `${configuredJaegerService ? "Configured" : "Default"} service '${jaegerService}' not found in Jaeger services list`,
				});
			}
		} catch (error) {
			results.push({
				name: "Jaeger Reachability",
				ok: false,
				details:
					error instanceof Error ? error.message : "Unknown reachability error",
			});
		}

		try {
			const tracesUrl = new URL(`${base}/api/traces`);
			tracesUrl.searchParams.set("limit", "1");
			tracesUrl.searchParams.set("service", jaegerService);
			const tracesRes = await fetchWithTimeout(
				tracesUrl.toString(),
				requestTimeoutMs,
			);
			results.push({
				name: "Jaeger Trace Query",
				ok: tracesRes.ok,
				details: tracesRes.ok
					? "Trace query endpoint is reachable"
					: `Trace query failed with status ${tracesRes.status}`,
			});
		} catch (error) {
			results.push({
				name: "Jaeger Trace Query",
				ok: false,
				details:
					error instanceof Error ? error.message : "Unknown trace query error",
			});
		}
	}

	let hasFailure = false;
	for (const result of results) {
		const marker = result.ok ? "PASS" : "FAIL";
		if (!result.ok) {
			hasFailure = true;
		}
		console.log(`${marker} ${result.name}: ${result.details}`);
	}

	if (hasFailure) {
		process.exit(1);
	}
}

run().catch((error) => {
	console.error(
		"FAIL Script Error:",
		error instanceof Error ? error.message : error,
	);
	process.exit(1);
});
