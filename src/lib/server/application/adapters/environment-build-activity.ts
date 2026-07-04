import type {
	BenchmarkRunEnvironmentActivityOptions,
	EnvironmentBuildActivityOptions,
	EnvironmentBuildActivityReadPort,
} from "$lib/server/application/environment-build-activity";
import {
	getBenchmarkRunEnvironmentActivity,
	getEnvironmentBuildActivity,
} from "$lib/server/application/adapters/environment-image-builds";

export class LegacyEnvironmentBuildActivityReadAdapter implements EnvironmentBuildActivityReadPort {
	getBuildActivity(
		buildId: string,
		options: EnvironmentBuildActivityOptions = {},
	) {
		return getEnvironmentBuildActivity(buildId, options);
	}

	getBenchmarkRunActivity(
		projectId: string,
		runId: string,
		options: BenchmarkRunEnvironmentActivityOptions = {},
	) {
		return getBenchmarkRunEnvironmentActivity(projectId, runId, options);
	}
}
