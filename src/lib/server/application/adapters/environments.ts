import { previewEnvironmentDockerfile } from "$lib/server/environments/builder";
import {
	EnvironmentConfigValidationError,
	archiveEnvironment,
	createEnvironment,
	duplicateEnvironment,
	findEnvironmentUsages,
	getBaseImageResolver,
	getEnvironment,
	getVersion,
	listEnvironments,
	listVersions,
	restoreVersion,
	updateEnvironment,
} from "$lib/server/environments/registry";
import type {
	EnvironmentCreateCommand,
	EnvironmentListFilter,
	EnvironmentRepository,
	EnvironmentUpdateCommand,
} from "$lib/server/application/environment-management";

export class LegacyEnvironmentRepository implements EnvironmentRepository {
	list(filter: EnvironmentListFilter): Promise<unknown[]> {
		return mapValidationErrors(() => listEnvironments(filter));
	}

	get(id: string): Promise<unknown | null> {
		return mapValidationErrors(() => getEnvironment(id));
	}

	create(input: EnvironmentCreateCommand): Promise<unknown> {
		return mapValidationErrors(() => createEnvironment(input));
	}

	update(id: string, input: EnvironmentUpdateCommand): Promise<unknown | null> {
		return mapValidationErrors(() => updateEnvironment(id, input));
	}

	archive(id: string): Promise<boolean> {
		return mapValidationErrors(() => archiveEnvironment(id));
	}

	duplicate(
		id: string,
		input: { name?: string; createdBy: string; projectId: string | null },
	): Promise<unknown | null> {
		return mapValidationErrors(() => duplicateEnvironment(id, input));
	}

	listVersions(id: string): Promise<unknown[]> {
		return mapValidationErrors(() => listVersions(id));
	}

	getVersion(id: string, version: number): Promise<unknown | null> {
		return mapValidationErrors(() => getVersion(id, version));
	}

	restoreVersion(
		id: string,
		version: number,
		userId: string,
	): Promise<unknown | null> {
		return mapValidationErrors(() => restoreVersion(id, version, userId));
	}

	findUsages(id: string): Promise<unknown[]> {
		return mapValidationErrors(() => findEnvironmentUsages(id));
	}

	async previewDockerfile(id: string): Promise<string | null> {
		return mapValidationErrors(async () => {
			const environment = await getEnvironment(id);
			if (!environment) return null;
			const resolver = await getBaseImageResolver();
			return previewEnvironmentDockerfile(environment, resolver);
		});
	}
}

async function mapValidationErrors<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (err) {
		if (err instanceof EnvironmentConfigValidationError) {
			const mapped = new Error(err.message) as Error & { status: number };
			mapped.status = 400;
			throw mapped;
		}
		throw err;
	}
}
