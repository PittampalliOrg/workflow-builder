import {
	archiveVault,
	createVault,
	getVault,
	listVaults,
	updateVault,
} from "$lib/server/vaults/registry";
import type {
	VaultListFilter,
	VaultRepository,
} from "$lib/server/application/vault-management";

export class LegacyVaultRepository implements VaultRepository {
	list(filter: VaultListFilter): Promise<unknown[]> {
		return listVaults(filter);
	}

	get(id: string): Promise<unknown | null> {
		return getVault(id);
	}

	create(input: {
		name: string;
		description: string | null;
		projectId: string | null;
		createdBy: string;
	}): Promise<unknown> {
		return createVault(input);
	}

	update(
		id: string,
		input: { name?: string; description?: string | null },
	): Promise<unknown | null> {
		return updateVault(id, input);
	}

	archive(id: string): Promise<boolean> {
		return archiveVault(id);
	}
}
