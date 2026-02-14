import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
	defaultResource,
	resourceFromAttributes,
} from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";

type OtelGlobal = {
	sdk?: NodeSDK;
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

function buildOtlpSignalUrl(
	base: string,
	signal: "traces" | "metrics",
): string {
	const trimmed = base.replace(/\/+$/, "");
	if (trimmed.endsWith(`/v1/${signal}`)) return trimmed;
	return `${trimmed}/v1/${signal}`;
}

export function initOtel(serviceName: string): void {
	const g = getOtelGlobal();
	if (g.started) return;

	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
	if (!endpoint) {
		g.started = true;
		return;
	}

	const diagLevel = process.env.OTEL_DIAGNOSTIC_LOG_LEVEL?.toLowerCase();
	if (diagLevel) {
		const map: Record<string, DiagLogLevel> = {
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

initOtel("mastra-agent-mcp");
