import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationEnvironmentBuildActivityService,
	type EnvironmentBuildActivityReadPort,
} from "$lib/server/application/environment-build-activity";

describe("ApplicationEnvironmentBuildActivityService", () => {
	let readPort: EnvironmentBuildActivityReadPort;
	let service: ApplicationEnvironmentBuildActivityService;

	beforeEach(() => {
		readPort = {
			getBuildActivity: vi.fn(async () => null),
			getBenchmarkRunActivity: vi.fn(async () => null),
		};
		service = new ApplicationEnvironmentBuildActivityService(readPort);
	});

	it("delegates build activity reads through the read port", async () => {
		await service.getBuildActivity("build-1", {
			sync: false,
			forceTerminal: true,
		});

		expect(readPort.getBuildActivity).toHaveBeenCalledWith("build-1", {
			sync: false,
			forceTerminal: true,
		});
	});

	it("delegates benchmark run activity reads through the read port", async () => {
		await service.getBenchmarkRunActivity("project-1", "run-1", {
			syncActive: true,
		});

		expect(readPort.getBenchmarkRunActivity).toHaveBeenCalledWith(
			"project-1",
			"run-1",
			{ syncActive: true },
		);
	});
});
