import { describe, expect, it, vi } from "vitest";
import {
	ApplicationObservabilityTraceAccessError,
	ApplicationObservabilityTraceAccessService,
	type ObservabilityTraceAccessRepository,
	type ObservabilityTraceOwnerResolver,
	type ObservabilityTraceSpanDetailReader,
} from "$lib/server/application/observability-trace-access";

function makeService(options: {
	owners?: ObservabilityTraceOwnerResolver;
	access?: ObservabilityTraceAccessRepository;
	spanDetails?: ObservabilityTraceSpanDetailReader;
} = {}) {
	const owners =
		options.owners ??
		({
			resolveTraceOwners: vi.fn(async () => ({
				sessionIds: ["session-1"],
				executionIds: ["exec-1"],
			})),
		} satisfies ObservabilityTraceOwnerResolver);
	const access =
		options.access ??
		({
			hasAnyTraceOwnerInScope: vi.fn(async () => true),
		} satisfies ObservabilityTraceAccessRepository);
	const spanDetails =
		options.spanDetails ??
		({
			isConfigured: vi.fn(() => true),
			getSpanDetail: vi.fn(async () => ({ spanId: "span-1" })),
		} satisfies ObservabilityTraceSpanDetailReader);

	return {
		owners,
		access,
		spanDetails,
		service: new ApplicationObservabilityTraceAccessService({
			owners,
			access,
			spanDetails,
		}),
	};
}

describe("ApplicationObservabilityTraceAccessService", () => {
	it("allows traces when any resolved owner is in scope", async () => {
		const { service, owners, access } = makeService();

		await expect(
			service.assertTraceAccess({
				traceId: "trace-1",
				session: { userId: "user-1", projectId: "project-1" },
			}),
		).resolves.toBeUndefined();

		expect(owners.resolveTraceOwners).toHaveBeenCalledWith("trace-1");
		expect(access.hasAnyTraceOwnerInScope).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
			sessionIds: ["session-1"],
			executionIds: ["exec-1"],
		});
	});

	it("rejects unauthenticated callers before resolving trace owners", async () => {
		const { service, owners } = makeService();

		await expect(
			service.assertTraceAccess({
				traceId: "trace-1",
				session: null,
			}),
		).rejects.toMatchObject({
			status: 401,
			message: "Authentication required",
		});
		expect(owners.resolveTraceOwners).not.toHaveBeenCalled();
	});

	it("maps traces with no scoped owners to not found", async () => {
		const { service } = makeService({
			access: {
				hasAnyTraceOwnerInScope: vi.fn(async () => false),
			},
		});

		await expect(
			service.assertTraceAccess({
				traceId: "trace-1",
				session: { userId: "user-1", projectId: "project-1" },
			}),
		).rejects.toBeInstanceOf(ApplicationObservabilityTraceAccessError);
		await expect(
			service.assertTraceAccess({
				traceId: "trace-1",
				session: { userId: "user-1", projectId: "project-1" },
			}),
		).rejects.toMatchObject({
			status: 404,
			message: "Trace not found",
		});
	});

	it("loads span detail only after authorizing the trace", async () => {
		const { service, owners, access, spanDetails } = makeService();

		await expect(
			service.getTraceSpanDetail({
				traceId: "trace-1",
				spanId: "span-1",
				session: { userId: "user-1", projectId: "project-1" },
			}),
		).resolves.toEqual({ spanId: "span-1" });

		expect(owners.resolveTraceOwners).toHaveBeenCalledWith("trace-1");
		expect(access.hasAnyTraceOwnerInScope).toHaveBeenCalledOnce();
		expect(spanDetails.getSpanDetail).toHaveBeenCalledWith("trace-1", "span-1");
	});

	it("rejects span detail reads when ClickHouse is not configured", async () => {
		const { service, owners, spanDetails } = makeService({
			spanDetails: {
				isConfigured: vi.fn(() => false),
				getSpanDetail: vi.fn(),
			},
		});

		expect(service.isSpanDetailConfigured()).toBe(false);
		await expect(
			service.getTraceSpanDetail({
				traceId: "trace-1",
				spanId: "span-1",
				session: { userId: "user-1" },
			}),
		).rejects.toMatchObject({ status: 503 });
		expect(owners.resolveTraceOwners).not.toHaveBeenCalled();
		expect(spanDetails.getSpanDetail).not.toHaveBeenCalled();
	});
});
