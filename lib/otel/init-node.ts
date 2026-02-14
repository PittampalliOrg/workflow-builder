/**
 * OpenTelemetry Node.js SDK initializer for Next.js instrumentation hook.
 *
 * All @opentelemetry/* imports use require() inside the function body so that
 * Turbopack does not attempt to statically resolve them at compile time.
 * These packages contain native/optional dependencies that bundlers cannot handle.
 */

type OtelGlobal = {
	sdk?: unknown;
	started?: boolean;
};

const OTEL_GLOBAL_KEY = "__workflow_builder_otel__";

function getOtelGlobal(): OtelGlobal {
	const g = globalThis as unknown as Record<string, unknown>;
	const existing = g[OTEL_GLOBAL_KEY] as OtelGlobal | undefined;
	if (existing) return existing;
	const next: OtelGlobal = {};
	g[OTEL_GLOBAL_KEY] = next;
	return next;
}

function parseOtelHeaders(
	value: string | undefined,
): Record<string, string> | undefined {
	if (!value) return undefined;
	const out: Record<string, string> = {};
	for (const part of value.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const k = trimmed.slice(0, eq).trim();
		const v = trimmed.slice(eq + 1).trim();
		if (k) out[k] = v;
	}
	return Object.keys(out).length ? out : undefined;
}

function parseResourceAttributes(
	value: string | undefined,
): Record<string, string> | undefined {
	if (!value) return undefined;
	const out: Record<string, string> = {};
	for (const part of value.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const k = trimmed.slice(0, eq).trim();
		const v = trimmed.slice(eq + 1).trim();
		if (!k) continue;
		// Keep service.name under OTEL_SERVICE_NAME / default parameter control.
		if (k === "service.name") continue;
		out[k] = v;
	}
	return Object.keys(out).length ? out : undefined;
}

function buildOtlpSignalUrl(
	base: string,
	signal: "traces" | "metrics",
): string {
	const trimmed = base.replace(/\/+$/, "");
	if (trimmed.endsWith(`/v1/${signal}`)) return trimmed;
	return `${trimmed}/v1/${signal}`;
}

export function initNodeOtel(serviceName: string): void {
	const g = getOtelGlobal();
	if (g.started) return;

	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
	if (!endpoint) {
		g.started = true;
		return;
	}

	/* eslint-disable @typescript-eslint/no-require-imports */
	const {
		diag,
		DiagConsoleLogger,
		DiagLogLevel,
	} = require("@opentelemetry/api") as typeof import("@opentelemetry/api");

	const { getNodeAutoInstrumentations } =
		require("@opentelemetry/auto-instrumentations-node") as typeof import("@opentelemetry/auto-instrumentations-node");

	const { OTLPMetricExporter } =
		require("@opentelemetry/exporter-metrics-otlp-http") as typeof import("@opentelemetry/exporter-metrics-otlp-http");

	const { OTLPTraceExporter } =
		require("@opentelemetry/exporter-trace-otlp-http") as typeof import("@opentelemetry/exporter-trace-otlp-http");

	const { defaultResource, resourceFromAttributes } =
		require("@opentelemetry/resources") as typeof import("@opentelemetry/resources");

	const { NodeSDK } =
		require("@opentelemetry/sdk-node") as typeof import("@opentelemetry/sdk-node");

	const { PeriodicExportingMetricReader } =
		require("@opentelemetry/sdk-metrics") as typeof import("@opentelemetry/sdk-metrics");

	const { SemanticResourceAttributes } =
		require("@opentelemetry/semantic-conventions") as typeof import("@opentelemetry/semantic-conventions");
	/* eslint-enable @typescript-eslint/no-require-imports */

	const diagLevel = process.env.OTEL_DIAGNOSTIC_LOG_LEVEL?.toLowerCase();
	if (diagLevel) {
		const map: Record<string, typeof DiagLogLevel[keyof typeof DiagLogLevel]> = {
			none: DiagLogLevel.NONE,
			error: DiagLogLevel.ERROR,
			warn: DiagLogLevel.WARN,
			info: DiagLogLevel.INFO,
			debug: DiagLogLevel.DEBUG,
			verbose: DiagLogLevel.VERBOSE,
			all: DiagLogLevel.ALL,
		};
		diag.setLogger(
			new DiagConsoleLogger(),
			map[diagLevel] ?? DiagLogLevel.INFO,
		);
	}

	const resource = defaultResource().merge(
		resourceFromAttributes({
			[SemanticResourceAttributes.SERVICE_NAME]:
				process.env.OTEL_SERVICE_NAME?.trim() || serviceName,
			...(parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES) ?? {}),
		}),
	);

	const headers = parseOtelHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

	const sdk = new NodeSDK({
		resource,
		traceExporter: new OTLPTraceExporter({
			url: buildOtlpSignalUrl(endpoint, "traces"),
			headers,
		}),
		metricReader: new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({
				url: buildOtlpSignalUrl(endpoint, "metrics"),
				headers,
			}),
		}),
		instrumentations: [
			getNodeAutoInstrumentations({
				"@opentelemetry/instrumentation-fs": { enabled: false },
			}),
		],
	});

	sdk.start();
	g.sdk = sdk;
	g.started = true;

	const shutdown = async () => {
		try {
			await sdk.shutdown();
		} catch {
			// ignore
		}
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
