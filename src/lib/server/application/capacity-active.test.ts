import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationCapacityActiveService } from "$lib/server/application/capacity-active";

describe("ApplicationCapacityActiveService", () => {
	let fleetActivity: ConstructorParameters<
		typeof ApplicationCapacityActiveService
	>[0]["fleetActivity"];
	let service: ApplicationCapacityActiveService;

	beforeEach(() => {
		fleetActivity = {
			summarize: vi.fn(async () => ({
				"session:sess-1": {
					lastEventAt: "2026-01-01T00:00:00.000Z",
					recentCount: 2,
					series: [{ t: "2026-01-01T00:00:00.000Z", value: 2 }],
					tokens: 12,
					tokensIn: 5,
					tokensOut: 7,
				},
			})),
		};
		service = new ApplicationCapacityActiveService({ fleetActivity });
	});

	it("returns an empty map without hitting the activity port for empty input", async () => {
		await expect(
			service.getFleetActivity({ items: [], projectId: "project-1" }),
		).resolves.toEqual({});
		expect(fleetActivity.summarize).not.toHaveBeenCalled();
	});

	it("delegates active fleet activity to the adapter with project scope", async () => {
		const items = [{ key: "session:sess-1", kind: "session", id: "sess-1" }];

		await expect(
			service.getFleetActivity({ items, projectId: "project-1" }),
		).resolves.toEqual({
			"session:sess-1": {
				lastEventAt: "2026-01-01T00:00:00.000Z",
				recentCount: 2,
				series: [{ t: "2026-01-01T00:00:00.000Z", value: 2 }],
				tokens: 12,
				tokensIn: 5,
				tokensOut: 7,
			},
		});
		expect(fleetActivity.summarize).toHaveBeenCalledWith(items, "project-1");
	});

	it("keeps the application service independent of DB infrastructure", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "capacity-active.ts"),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});
