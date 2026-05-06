/**
 * Sync platform OAuth apps from environment variables.
 *
 * Reads OAUTH_APP_*_CLIENT_ID / OAUTH_APP_*_CLIENT_SECRET pairs and upserts
 * rows into platform_oauth_apps with AP-compatible AES-256-CBC encrypted
 * client secrets.
 *
 * Usage:
 *   pnpm tsx scripts/sync-oauth-apps.ts
 */

import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

type OAuthAppMapping = {
	suffix: string;
	pieceName: string;
};

const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/workflow";
const AP_PREFIX = "@activepieces/piece-";

const KNOWN_OAUTH_APPS: OAuthAppMapping[] = [
	{ suffix: "MICROSOFT_TODO", pieceName: "@activepieces/piece-microsoft-todo" },
	{
		suffix: "MICROSOFT_DYNAMICS_365_BC",
		pieceName: "@activepieces/piece-microsoft-dynamics-365-business-central",
	},
	{ suffix: "MICROSOFT_ONEDRIVE", pieceName: "@activepieces/piece-microsoft-onedrive" },
	{
		suffix: "MICROSOFT_OUTLOOK_CALENDAR",
		pieceName: "@activepieces/piece-microsoft-outlook-calendar",
	},
	{ suffix: "MICROSOFT_TEAMS", pieceName: "@activepieces/piece-microsoft-teams" },
	{ suffix: "MICROSOFT_EXCEL", pieceName: "@activepieces/piece-microsoft-excel-365" },
	{ suffix: "MICROSOFT_OUTLOOK", pieceName: "@activepieces/piece-microsoft-outlook" },
	{ suffix: "MICROSOFT_POWER_BI", pieceName: "@activepieces/piece-microsoft-power-bi" },
	{ suffix: "MICROSOFT_PLANNER", pieceName: "@activepieces/piece-microsoft-365-planner" },
	{ suffix: "MICROSOFT_ONENOTE", pieceName: "@activepieces/piece-microsoft-onenote" },
	{ suffix: "MICROSOFT_SHAREPOINT", pieceName: "@activepieces/piece-microsoft-sharepoint" },
	{ suffix: "MICROSOFT_PEOPLE", pieceName: "@activepieces/piece-microsoft-365-people" },
	{ suffix: "MICROSOFT_DYNAMICS_CRM", pieceName: "@activepieces/piece-microsoft-dynamics-crm" },
	{ suffix: "GITHUB", pieceName: "@activepieces/piece-github" },
	{ suffix: "GITEA", pieceName: "@activepieces/piece-gitea" },
	{ suffix: "NOTION", pieceName: "@activepieces/piece-notion" },
	{ suffix: "LINKEDIN", pieceName: "@activepieces/piece-linkedin" },
	{ suffix: "GOOGLE_SHEETS", pieceName: "@activepieces/piece-google-sheets" },
	{ suffix: "GOOGLE_DRIVE", pieceName: "@activepieces/piece-google-drive" },
	{ suffix: "GOOGLE_CALENDAR", pieceName: "@activepieces/piece-google-calendar" },
	{ suffix: "GMAIL", pieceName: "@activepieces/piece-gmail" },
];

function isHex(value: string): boolean {
	return /^[0-9a-fA-F]+$/.test(value);
}

function getEncryptionKey(): Buffer {
	const secret = process.env.AP_ENCRYPTION_KEY;
	if (!secret) {
		throw new Error("AP_ENCRYPTION_KEY is required");
	}
	if (secret.length === 64 && isHex(secret)) {
		return Buffer.from(secret, "hex");
	}
	if (secret.length === 32) {
		return Buffer.from(secret, "binary");
	}
	throw new Error(
		`AP_ENCRYPTION_KEY must be a 64-char hex string or 32-char string, got ${secret.length}`,
	);
}

function encryptString(plaintext: string): { iv: string; data: string } {
	const iv = randomBytes(16);
	const cipher = createCipheriv("aes-256-cbc", getEncryptionKey(), iv);
	let encrypted = cipher.update(plaintext, "utf8", "hex");
	encrypted += cipher.final("hex");
	return { iv: iv.toString("hex"), data: encrypted };
}

function pieceAliases(pieceName: string): string[] {
	const shortName = pieceName.startsWith(AP_PREFIX) ? pieceName.slice(AP_PREFIX.length) : pieceName;
	return Array.from(new Set([pieceName, `${AP_PREFIX}${shortName}`, shortName]));
}

function discoverMappings(): OAuthAppMapping[] {
	const known = new Map(KNOWN_OAUTH_APPS.map((mapping) => [mapping.suffix, mapping]));
	const discovered: OAuthAppMapping[] = [];

	for (const key of Object.keys(process.env)) {
		const match = key.match(/^OAUTH_APP_(.+)_CLIENT_ID$/);
		if (!match) continue;
		const suffix = match[1];
		const mapped = known.get(suffix);
		if (mapped) {
			discovered.push(mapped);
			continue;
		}
		discovered.push({
			suffix,
			pieceName: `${AP_PREFIX}${suffix.toLowerCase().replaceAll("_", "-")}`,
		});
	}

	return discovered;
}

async function main() {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		let platformRows: { id: string }[] = await sql`
			select id
			from platforms
			where id = 'default-platform'
			limit 1
		`;

		if (platformRows.length === 0) {
			await sql`
				insert into platforms (id, name, created_at, updated_at)
				values ('default-platform', 'Default Platform', now(), now())
				on conflict (id) do nothing
			`;
			platformRows = [{ id: "default-platform" }];
		}

		const platformId = platformRows[0].id;
		let upserted = 0;

		for (const { suffix, pieceName } of discoverMappings()) {
			const clientId = process.env[`OAUTH_APP_${suffix}_CLIENT_ID`]?.trim();
			const clientSecret = process.env[`OAUTH_APP_${suffix}_CLIENT_SECRET`];
			if (!clientId || !clientSecret) {
				console.log(`Skipping ${pieceName}: missing OAUTH_APP_${suffix}_CLIENT_ID/CLIENT_SECRET`);
				continue;
			}

			const aliases = pieceAliases(pieceName);
			const encryptedSecret = JSON.stringify(encryptString(clientSecret));

			await sql`
				delete from platform_oauth_apps
				where platform_id = ${platformId}
					and piece_name in ${sql(aliases)}
					and piece_name <> ${pieceName}
			`;

			await sql`
				insert into platform_oauth_apps
					(id, platform_id, piece_name, client_id, client_secret, created_at, updated_at)
				values
					(${randomUUID()}, ${platformId}, ${pieceName}, ${clientId}, ${encryptedSecret}::jsonb, now(), now())
				on conflict (platform_id, piece_name)
				do update set
					client_id = excluded.client_id,
					client_secret = excluded.client_secret,
					updated_at = excluded.updated_at
			`;
			console.log(`Synced ${pieceName}`);
			upserted++;
		}

		console.log(`Done. Upserted ${upserted} OAuth app row(s).`);
	} finally {
		await sql.end();
	}
}

main().catch((error) => {
	console.error("Failed to sync OAuth apps:", error);
	process.exit(1);
});
