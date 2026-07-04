import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	vaults,
	vaultCredentials,
	type Vault,
} from "$lib/server/db/schema";
import type {
	VaultListFilter,
	VaultRepository,
} from "$lib/server/application/vault-management";
import type { VaultDetail, VaultSummary } from "$lib/types/vaults";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

function rowToSummary(row: Vault, credentialCount: number): VaultSummary {
	return {
		id: row.id,
		name: row.name,
		description: row.description ?? null,
		projectId: row.projectId ?? null,
		credentialCount,
		isArchived: row.isArchived,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export class LegacyVaultRepository implements VaultRepository {
	async list(filter: VaultListFilter): Promise<VaultSummary[]> {
		const database = requireDb();
		const conditions: ReturnType<typeof eq>[] = [];
		if (!filter.includeArchived) conditions.push(eq(vaults.isArchived, false));
		if (filter.projectId !== undefined) {
			conditions.push(
				filter.projectId === null
					? isNull(vaults.projectId)
					: eq(vaults.projectId, filter.projectId),
			);
		}

		const rows = await database
			.select()
			.from(vaults)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(asc(vaults.name));
		if (rows.length === 0) return [];

		const counts = await database
			.select({
				vaultId: vaultCredentials.vaultId,
				count: sql<number>`count(*)`,
			})
			.from(vaultCredentials)
			.where(eq(vaultCredentials.isArchived, false))
			.groupBy(vaultCredentials.vaultId);
		const countsByVault = new Map(
			counts.map((c) => [c.vaultId, Number(c.count)]),
		);

		const q = filter.q?.trim().toLowerCase();
		return rows
			.map((row) => rowToSummary(row, countsByVault.get(row.id) ?? 0))
			.filter((summary) => {
				if (!q) return true;
				const hay = `${summary.name} ${summary.description ?? ""}`.toLowerCase();
				return hay.includes(q);
			});
	}

	async get(id: string): Promise<VaultDetail | null> {
		const database = requireDb();
		const [row] = await database
			.select()
			.from(vaults)
			.where(eq(vaults.id, id))
			.limit(1);
		if (!row) return null;
		const [{ count }] = await database
			.select({ count: sql<number>`count(*)` })
			.from(vaultCredentials)
			.where(
				and(
					eq(vaultCredentials.vaultId, id),
					eq(vaultCredentials.isArchived, false),
				),
			);
		return rowToSummary(row, Number(count));
	}

	async create(input: {
		name: string;
		description: string | null;
		projectId: string | null;
		createdBy: string;
	}): Promise<VaultDetail> {
		const database = requireDb();
		const [row] = await database
			.insert(vaults)
			.values({
				name: input.name,
				description: input.description ?? null,
				projectId: input.projectId ?? null,
				createdBy: input.createdBy ?? null,
			})
			.returning();
		return rowToSummary(row, 0);
	}

	async update(
		id: string,
		input: { name?: string; description?: string | null },
	): Promise<VaultDetail | null> {
		const database = requireDb();
		const patch: Partial<Vault> & { updatedAt: Date } = {
			updatedAt: new Date(),
		};
		if (input.name !== undefined) patch.name = input.name;
		if (input.description !== undefined) patch.description = input.description;
		const [row] = await database
			.update(vaults)
			.set(patch)
			.where(eq(vaults.id, id))
			.returning();
		if (!row) return null;
		return this.get(id);
	}

	async archive(id: string): Promise<boolean> {
		const database = requireDb();
		const [row] = await database
			.update(vaults)
			.set({ isArchived: true, updatedAt: new Date() })
			.where(eq(vaults.id, id))
			.returning({ id: vaults.id });
		return Boolean(row);
	}
}
