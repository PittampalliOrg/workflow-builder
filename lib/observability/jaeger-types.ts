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
