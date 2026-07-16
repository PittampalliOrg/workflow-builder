export type ObservabilityTraceOwners = {
	sessionIds: string[];
	executionIds: string[];
};

export type ObservabilityTraceAccessSession = {
	userId: string;
	projectId?: string | null;
};

export interface ObservabilityTraceOwnerResolver {
	resolveTraceOwners(traceId: string): Promise<ObservabilityTraceOwners>;
}

export interface ObservabilityTraceAccessRepository {
	hasAnyTraceOwnerInScope(input: {
		userId: string;
		projectId?: string | null;
		sessionIds: string[];
		executionIds: string[];
	}): Promise<boolean>;
}

export interface ObservabilityTraceSpanDetailReader {
	isConfigured(): boolean;
	getSpanDetail(traceId: string, spanId: string): Promise<unknown | null>;
}

export class ApplicationObservabilityTraceAccessError extends Error {
	constructor(
		public readonly status: 401 | 404 | 503,
		message: string,
	) {
		super(message);
		this.name = "ApplicationObservabilityTraceAccessError";
	}
}

export class ApplicationObservabilityTraceAccessService {
	constructor(
		private readonly deps: {
			owners: ObservabilityTraceOwnerResolver;
			access: ObservabilityTraceAccessRepository;
			spanDetails: ObservabilityTraceSpanDetailReader;
		},
	) {}

	isSpanDetailConfigured(): boolean {
		return this.deps.spanDetails.isConfigured();
	}

	async assertTraceAccess(input: {
		traceId: string;
		session: ObservabilityTraceAccessSession | null | undefined;
	}): Promise<void> {
		if (!input.session?.userId) {
			throw new ApplicationObservabilityTraceAccessError(
				401,
				"Authentication required",
			);
		}
		const owners = await this.deps.owners.resolveTraceOwners(input.traceId);
		const isAllowed = await this.deps.access.hasAnyTraceOwnerInScope({
			userId: input.session.userId,
			projectId: input.session.projectId ?? null,
			sessionIds: owners.sessionIds,
			executionIds: owners.executionIds,
		});
		if (!isAllowed) {
			throw new ApplicationObservabilityTraceAccessError(
				404,
				"Trace not found",
			);
		}
	}

	async getTraceSpanDetail(input: {
		traceId: string;
		spanId: string;
		session: ObservabilityTraceAccessSession | null | undefined;
	}): Promise<unknown | null> {
		if (!this.deps.spanDetails.isConfigured()) {
			throw new ApplicationObservabilityTraceAccessError(
				503,
				"ClickHouse is not configured",
			);
		}
		await this.assertTraceAccess(input);
		return this.deps.spanDetails.getSpanDetail(input.traceId, input.spanId);
	}
}
