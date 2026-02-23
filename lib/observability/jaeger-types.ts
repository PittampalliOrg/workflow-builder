export type JaegerTag = {
	key?: string;
	type?: string;
	value?: unknown;
};

export type JaegerLogField = {
	key?: string;
	type?: string;
	value?: unknown;
};

export type JaegerLog = {
	timestamp?: number;
	fields?: JaegerLogField[];
};

export type JaegerReference = {
	refType?: string;
	traceID?: string;
	traceId?: string;
	spanID?: string;
	spanId?: string;
};

export type JaegerSpan = {
	traceID?: string;
	traceId?: string;
	spanID?: string;
	spanId?: string;
	operationName?: string;
	startTime?: number;
	duration?: number;
	processID?: string;
	processId?: string;
	references?: JaegerReference[];
	tags?: JaegerTag[];
	logs?: JaegerLog[];
};

export type JaegerProcess = {
	serviceName?: string;
	tags?: JaegerTag[];
};

export type JaegerTrace = {
	traceID?: string;
	traceId?: string;
	spans?: JaegerSpan[];
	processes?: Record<string, JaegerProcess>;
};

export type JaegerTraceListResponse = {
	data?: JaegerTrace[];
	total?: number;
	limit?: number;
	offset?: number;
	errors?: string[] | null;
};

export type JaegerTraceResponse = {
	data?: JaegerTrace[];
	total?: number;
	errors?: string[] | null;
};

export type OtlpAnyValue = {
	stringValue?: string;
	boolValue?: boolean;
	intValue?: string | number;
	doubleValue?: number;
	arrayValue?: {
		values?: OtlpAnyValue[];
	};
	kvlistValue?: {
		values?: OtlpKeyValue[];
	};
	bytesValue?: string;
};

export type OtlpKeyValue = {
	key?: string;
	value?: OtlpAnyValue;
};

export type OtlpSpanStatus = {
	code?: number | string;
	message?: string;
};

export type OtlpSpan = {
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	name?: string;
	kind?: number | string;
	startTimeUnixNano?: string | number;
	endTimeUnixNano?: string | number;
	attributes?: OtlpKeyValue[];
	status?: OtlpSpanStatus;
};

export type OtlpScopeSpans = {
	spans?: OtlpSpan[];
};

export type OtlpResource = {
	attributes?: OtlpKeyValue[];
};

export type OtlpResourceSpans = {
	resource?: OtlpResource;
	scopeSpans?: OtlpScopeSpans[];
};

export type TempoSearchTrace = {
	traceID?: string;
	traceId?: string;
	rootServiceName?: string;
	rootTraceName?: string;
	startTimeUnixNano?: string;
	durationMs?: number;
};

export type TempoSearchResponse = {
	traces?: TempoSearchTrace[];
	metrics?: Record<string, unknown>;
};

export type TempoTraceResponse = {
	batches?: OtlpResourceSpans[];
	trace?: {
		resourceSpans?: OtlpResourceSpans[];
	};
	metrics?: Record<string, unknown>;
};
