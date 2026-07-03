import { describe, expect, it, vi } from "vitest";
import {
	ApplicationObservabilityTraceAccessError,
	ApplicationObservabilityTraceAccessService,
	type ObservabilityTraceAccessRepository,
	type ObservabilityTraceOwnerResolver,
} from "$lib/server/application/observability-trace-access";

function makeService(options: {
	owners?: ObservabilityTraceOwnerResolver;
	access?: ObservabilityTraceAccessRepository;
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

	return {
		owners,
		access,
		service: new ApplicationObservabilityTraceAccessService({
			owners,
			access,
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
});
