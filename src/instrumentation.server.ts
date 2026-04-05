import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const serviceName = process.env.OTEL_SERVICE_NAME || 'workflow-builder';

if (endpoint) {
	const sdk = new NodeSDK({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: serviceName,
			[ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.0.1',
			'deployment.environment': process.env.NODE_ENV || 'development'
		}),
		traceExporter: new OTLPTraceExporter({
			url: `${endpoint}/v1/traces`
		}),
		metricReader: new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({
				url: `${endpoint}/v1/metrics`
			})
		}),
		instrumentations: [
			getNodeAutoInstrumentations({
				'@opentelemetry/instrumentation-fs': { enabled: false }
			})
		]
	});

	sdk.start();

	const shutdown = () => {
		sdk.shutdown().catch(console.error);
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);

	console.log(`[OTEL] Tracing initialized for ${serviceName} → ${endpoint}`);
} else {
	console.log('[OTEL] No OTEL_EXPORTER_OTLP_ENDPOINT set, tracing disabled');
}
