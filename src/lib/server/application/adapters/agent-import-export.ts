import {
	listEnvironments,
	resolveEnvironmentRef,
} from "$lib/server/application/adapters/environment-registry";
import type {
	AgentImportExportEnvironmentRef,
	AgentImportExportReferenceRepository,
	AgentImportExportVaultRef,
} from "$lib/server/application/agent-import-export";
import { LegacyVaultRepository } from "./vaults";

const vaultRepository = new LegacyVaultRepository();

export class LegacyAgentImportExportReferenceRepository
	implements AgentImportExportReferenceRepository
{
	async listEnvironments(input: {
		includeArchived?: boolean;
	}): Promise<AgentImportExportEnvironmentRef[]> {
		const environments = await listEnvironments(input);
		return environments.map((environment) => ({
			id: environment.id,
			slug: environment.slug,
			currentVersion: environment.currentVersion,
		}));
	}

	async listVaults(input: {
		includeArchived?: boolean;
	}): Promise<AgentImportExportVaultRef[]> {
		const vaults = (await vaultRepository.list(
			input,
		)) as AgentImportExportVaultRef[];
		return vaults.map((vault) => ({
			id: vault.id,
			name: vault.name,
		}));
	}

	async resolveEnvironmentSlug(input: {
		id: string;
		version?: number | null;
	}): Promise<string | null> {
		const environment = await resolveEnvironmentRef({
			id: input.id,
			version: input.version ?? undefined,
		});
		return environment?.slug ?? null;
	}
}
