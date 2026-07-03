import { scryptSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { platforms, projects, userIdentities, users } from "$lib/server/db/schema";
import { generateTokens } from "$lib/server/auth";

export type PasswordSignInResult =
	| {
			ok: false;
			status: number;
			message: string;
	  }
	| {
			ok: true;
			accessToken: string;
			refreshToken: string;
			user: {
				id: string;
				email: string | null;
				name: string | null;
				image: string | null;
			};
	  };

export async function signInWithPassword(
	body: Record<string, unknown>,
): Promise<PasswordSignInResult> {
	const email = typeof body.email === "string" ? body.email.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	if (!email || !password) {
		return { ok: false, status: 400, message: "Email and password are required" };
	}

	if (!db) {
		return { ok: false, status: 503, message: "Database not configured" };
	}

	const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
	if (!user) return invalidCredentials();

	const [identity] = await db
		.select()
		.from(userIdentities)
		.where(eq(userIdentities.userId, user.id))
		.limit(1);
	if (!identity?.password) return invalidCredentials();

	const valid = await verifyPassword(password, identity.password);
	if (!valid) return invalidCredentials();

	const platformId =
		user.platformId || (await db.select().from(platforms).limit(1))?.[0]?.id;
	if (!platformId) {
		return { ok: false, status: 500, message: "Platform not configured" };
	}

	const [project] = await db
		.select()
		.from(projects)
		.where(eq(projects.ownerId, user.id))
		.limit(1);
	const projectId = project?.id || "default";

	try {
		const tokens = await generateTokens(
			user.id,
			user.email!,
			platformId,
			projectId,
			identity.tokenVersion,
		);
		return {
			ok: true,
			...tokens,
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
				image: user.image,
			},
		};
	} catch {
		return { ok: false, status: 500, message: "JWT signing key not configured" };
	}
}

async function verifyPassword(password: string, storedPassword: string): Promise<boolean> {
	const bcrypt = await import("bcryptjs");
	try {
		return await bcrypt.compare(password, storedPassword);
	} catch {
		if (!storedPassword.includes(":")) return false;
		try {
			const [salt, storedHash] = storedPassword.split(":");
			const derivedHash = scryptSync(password, salt, 64).toString("hex");
			return derivedHash === storedHash;
		} catch {
			return false;
		}
	}
}

function invalidCredentials(): PasswordSignInResult {
	return { ok: false, status: 400, message: "Invalid email or password" };
}
