import {
	context,
	diag,
	DiagConsoleLogger,
	DiagLogLevel,
	propagation,
	trace,
} from "@opentelemetry/api";
import { inspect } from "node:util";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
	defaultResource,
	resourceFromAttributes,
} from "@opentelemetry/resources";
import {
	BatchLogRecordProcessor,
	LoggerProvider,
} from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { logs as otelLogsApi } from "@opentelemetry/api-logs";

type OtelGlobal = {
	sdk?: NodeSDK;
	logsProvider?: LoggerProvider;
	started?: boolean;
};

const OTEL_GLOBAL_KEY = "__workflow_builder_otel__";
let activeServiceName = "function-router";
const OTEL_CONSOLE_BRIDGE_KEY = "__workflow_builder_function_router_console_otel__";
type OtelLogger = {
	emit(record: {
		severityText: string;
		body: string;
		attributes?: Record<string, string>;
	}): void;
};
const otelLogsBridge = otelLogsApi;

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
		if (k === "service.name") continue;
		out[k] = v;
	}
	return Object.keys(out).length ? out : undefined;
}

function buildOtlpSignalUrl(
	base: string,
	signal: "traces" | "metrics" | "logs",
): string {
	const trimmed = base.replace(/\/+$/, "");
	// If caller already provided /v1/<signal>, keep it.
	if (trimmed.endsWith(`/v1/${signal}`)) return trimmed;
	return `${trimmed}/v1/${signal}`;
}

export function initOtel(serviceName: string): void {
	const g = getOtelGlobal();
	if (g.started) return;
	activeServiceName = serviceName;

	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
	if (!endpoint) {
		// Opt-in: if no endpoint is configured, we do not start the SDK.
		g.started = true;
		return;
	}

	process.env.OTEL_LOGS_EXPORTER ??= "otlp";

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

	const logsProvider = new LoggerProvider({
		resource,
		processors: [
			new BatchLogRecordProcessor(
			new OTLPLogExporter({
				url: buildOtlpSignalUrl(endpoint, "logs"),
				headers,
			}),
			),
		],
	});
	otelLogsBridge.setGlobalLoggerProvider(logsProvider);

	sdk.start();
	installConsoleOtelBridge();
	g.sdk = sdk;
	g.logsProvider = logsProvider;
	g.started = true;

	const shutdown = async () => {
		try {
			await sdk.shutdown();
		} catch {
			// ignore
		}
		try {
			await logsProvider.shutdown();
		} catch {
			// ignore
		}
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

export function otelLogMixin(): Record<string, string> {
	const span = trace.getSpan(context.active());
	const sc = span?.spanContext();
	const baggage = propagation.getBaggage(context.active());
	const sessionId = baggage?.getEntry("session.id")?.value ?? baggage?.getEntry("sessionId")?.value;
	const workflowExecutionId =
		baggage?.getEntry("workflow.execution.id")?.value ??
		baggage?.getEntry("workflow.execution_id")?.value;
	return {
		...(sc ? { trace_id: sc.traceId, span_id: sc.spanId } : {}),
		...(sessionId ? { "session.id": sessionId } : {}),
		...(workflowExecutionId ? { "workflow.execution.id": workflowExecutionId } : {}),
	};
}

function normalizeConsoleArgs(args: unknown[]): string {
	return args
		.map((value) => {
			if (typeof value === "string") return value;
			if (value && typeof value === "object") {
				const maybeMsg =
					"msg" in value && typeof value.msg === "string" ? value.msg : null;
				if (maybeMsg) return maybeMsg;
				try {
					return JSON.stringify(value, getCircularReplacer());
				} catch {
					return inspect(value, { depth: 4, breakLength: 120 });
				}
			}
			try {
				return JSON.stringify(value);
			} catch {
				return String(value);
			}
		})
		.join(" ");
}

function getCircularReplacer(): (_key: string, value: unknown) => unknown {
	const seen = new WeakSet<object>();
	return (_key, value) => {
		if (value && typeof value === "object") {
			if (seen.has(value)) return "[Circular]";
			seen.add(value);
		}
		return value;
	};
}

function emitOtelLog(
	severityText: "INFO" | "WARN" | "ERROR",
	args: unknown[],
): void {
	try {
		otelLogsBridge.getLogger(activeServiceName).emit({
			severityText,
			body: normalizeConsoleArgs(args),
			attributes: otelLogMixin(),
		});
	} catch {
		// Ignore observability failures.
	}
}

function normalizePinoLevel(level: number): "INFO" | "WARN" | "ERROR" {
	if (level >= 50) return "ERROR";
	if (level >= 40) return "WARN";
	return "INFO";
}

export const otelPinoHooks = {
	logMethod(
		this: unknown,
		args: unknown[],
		method: (...methodArgs: unknown[]) => void,
		level: number,
	): void {
		emitOtelLog(normalizePinoLevel(level), args);
		method.apply(this, args);
	},
};

function installConsoleOtelBridge(): void {
	const g = globalThis as Record<string, unknown>;
	if (g[OTEL_CONSOLE_BRIDGE_KEY]) return;
	g[OTEL_CONSOLE_BRIDGE_KEY] = true;

	const originals = {
		log: console.log,
		info: console.info,
		warn: console.warn,
		error: console.error,
	};

	console.log = (...args: unknown[]) => {
		originals.log(...args);
		emitOtelLog("INFO", args);
	};
	console.info = (...args: unknown[]) => {
		originals.info(...args);
		emitOtelLog("INFO", args);
	};
	console.warn = (...args: unknown[]) => {
		originals.warn(...args);
		emitOtelLog("WARN", args);
	};
	console.error = (...args: unknown[]) => {
		originals.error(...args);
		emitOtelLog("ERROR", args);
	};
}

initOtel("function-router");
