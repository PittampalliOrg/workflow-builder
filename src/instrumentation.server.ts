import { context, propagation, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { activeSpanRegistryProcessor } from './lib/server/observability/http-server-spans.js';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const serviceName = process.env.OTEL_SERVICE_NAME || 'workflow-builder';
const otelGlobalKey = '__workflow_builder_console_otel_bridge__';
type OtelLogger = {
	emit(record: { severityText: string; body: string; attributes?: Record<string, string> }): void;
};
let otelLogsApi: { getLogger(name: string): OtelLogger } | null = null;

void import('@opentelemetry/api-logs')
	.then((mod) => {
		otelLogsApi = mod.logs;
	})
	.catch(() => {
		otelLogsApi = null;
	});

function normalizeEndpoint(signal: 'traces' | 'metrics'): string {
	const trimmed = endpoint?.replace(/\/+$/, '') ?? '';
	if (!trimmed) return '';
	if (trimmed.endsWith(`/v1/${signal}`)) return trimmed;
	return `${trimmed}/v1/${signal}`;
}

function currentLogAttributes(): Record<string, string> {
	const out: Record<string, string> = {};
	const span = trace.getSpan(context.active());
	const ctx = span?.spanContext();
	if (ctx) {
		out.trace_id = ctx.traceId;
		out.span_id = ctx.spanId;
	}
	const baggage = propagation.getBaggage(context.active());
	const sessionId = baggage?.getEntry('session.id')?.value ?? baggage?.getEntry('sessionId')?.value;
	const workflowExecutionId =
		baggage?.getEntry('workflow.execution.id')?.value ?? baggage?.getEntry('workflow.execution_id')?.value;
	if (sessionId) out['session.id'] = sessionId;
	if (workflowExecutionId) out['workflow.execution.id'] = workflowExecutionId;
	return out;
}

function installConsoleOtelBridge(): void {
	const g = globalThis as Record<string, unknown>;
	if (g[otelGlobalKey]) return;
	g[otelGlobalKey] = true;

	const originals = {
		log: console.log,
		info: console.info,
		warn: console.warn,
		error: console.error
	};

	function emit(severityText: 'INFO' | 'WARN' | 'ERROR', args: unknown[]) {
		if (!otelLogsApi) return;
		try {
			otelLogsApi.getLogger(serviceName).emit({
				severityText,
				body: args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '),
				attributes: currentLogAttributes()
			});
		} catch {
			// Do not let observability break server logging.
		}
	}

	console.log = (...args: unknown[]) => {
		originals.log(...args);
		emit('INFO', args);
	};
	console.info = (...args: unknown[]) => {
		originals.info(...args);
		emit('INFO', args);
	};
	console.warn = (...args: unknown[]) => {
		originals.warn(...args);
		emit('WARN', args);
	};
	console.error = (...args: unknown[]) => {
		originals.error(...args);
		emit('ERROR', args);
	};
}

if (endpoint) {
	process.env.OTEL_LOGS_EXPORTER ??= 'otlp';
	const traceExporter = new OTLPTraceExporter({
		url: normalizeEndpoint('traces')
	});
	const sdk = new NodeSDK({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: serviceName,
			[ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.0.1',
			'deployment.environment': process.env.NODE_ENV || 'development'
		}),
		traceExporter,
		spanProcessors: [
			activeSpanRegistryProcessor,
			new BatchSpanProcessor(traceExporter)
		],
		metricReader: new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({
				url: normalizeEndpoint('metrics')
			})
		}),
		instrumentations: [
			getNodeAutoInstrumentations({
				'@opentelemetry/instrumentation-fs': { enabled: false }
			})
		]
	});

	sdk.start();
	installConsoleOtelBridge();

	const shutdown = () => {
		sdk.shutdown().catch(console.error);
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);

	console.log(`[OTEL] Tracing initialized for ${serviceName} → ${endpoint}`);
} else {
	console.log('[OTEL] No OTEL_EXPORTER_OTLP_ENDPOINT set, tracing disabled');
}
