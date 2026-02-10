import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "./index";
import { platformOauthApps } from "./schema";
import {
	encryptString,
	decryptString,
	type EncryptedObject,
} from "@/lib/security/encryption";
import { generateId } from "@/lib/utils/id";
import { ensureDefaultPlatform } from "@/lib/platform-service";

const ACTIVEPIECES_PACKAGE_PREFIX = "@activepieces/piece-";

export type DecryptedOAuthApp = {
	id: string;
	pieceName: string;
	clientId: string;
	clientSecret: string; // decrypted plaintext
};

export type OAuthAppSummary = {
	id: string;
	pieceName: string;
	clientId: string;
	hasSecret: boolean;
};

function decryptOAuthApp(
	row: typeof platformOauthApps.$inferSelect,
): DecryptedOAuthApp {
	return {
		id: row.id,
		pieceName: row.pieceName,
		clientId: row.clientId,
		clientSecret: decryptString(row.clientSecret as EncryptedObject),
	};
}

function toSummary(
	row: typeof platformOauthApps.$inferSelect,
): OAuthAppSummary {
	return {
		id: row.id,
		pieceName: row.pieceName,
		clientId: row.clientId,
		hasSecret: true,
	};
}

function expandPieceNameCandidates(name: string): string[] {
	const candidates = new Set([name]);
	if (name.startsWith(ACTIVEPIECES_PACKAGE_PREFIX)) {
		candidates.add(name.slice(ACTIVEPIECES_PACKAGE_PREFIX.length));
	} else {
		candidates.add(`${ACTIVEPIECES_PACKAGE_PREFIX}${name}`);
	}
	return Array.from(candidates);
}

export async function getOAuthAppByPieceName(
	pieceName: string,
): Promise<DecryptedOAuthApp | null> {
	const platform = await ensureDefaultPlatform();
	const candidates = expandPieceNameCandidates(pieceName);
	const row = await db.query.platformOauthApps.findFirst({
		where: and(
			inArray(platformOauthApps.pieceName, candidates),
			eq(platformOauthApps.platformId, platform.id),
		),
	});

	if (!row) return null;
	return decryptOAuthApp(row);
}

export async function listOAuthApps(): Promise<OAuthAppSummary[]> {
	const platform = await ensureDefaultPlatform();
	const rows = await db
		.select()
		.from(platformOauthApps)
		.where(eq(platformOauthApps.platformId, platform.id));
	return rows.map(toSummary);
}

export async function upsertOAuthApp(params: {
	pieceName: string;
	clientId: string;
	clientSecret: string;
}): Promise<OAuthAppSummary> {
	const platform = await ensureDefaultPlatform();
	const encryptedSecret = encryptString(params.clientSecret);
	const now = new Date();

	const existing = await db.query.platformOauthApps.findFirst({
		where: and(
			eq(platformOauthApps.pieceName, params.pieceName),
			eq(platformOauthApps.platformId, platform.id),
		),
	});

	if (existing) {
		const [updated] = await db
			.update(platformOauthApps)
			.set({
				clientId: params.clientId,
				clientSecret: encryptedSecret,
				updatedAt: now,
			})
			.where(eq(platformOauthApps.id, existing.id))
			.returning();

		return toSummary(updated);
	}

	const [created] = await db
		.insert(platformOauthApps)
		.values({
			id: generateId(),
			platformId: platform.id,
			pieceName: params.pieceName,
			clientId: params.clientId,
			clientSecret: encryptedSecret,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return toSummary(created);
}

export async function deleteOAuthApp(pieceName: string): Promise<boolean> {
	const platform = await ensureDefaultPlatform();
	const rows = await db
		.delete(platformOauthApps)
		.where(
			and(
				eq(platformOauthApps.pieceName, pieceName),
				eq(platformOauthApps.platformId, platform.id),
			),
		)
		.returning();

	return rows.length > 0;
}
