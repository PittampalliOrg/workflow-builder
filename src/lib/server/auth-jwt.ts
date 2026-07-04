import { importPKCS8, SignJWT } from "jose";
import { env } from "$env/dynamic/private";

export type TokenPayload = {
	sub: string; // userId
	email: string;
	platformId: string;
	projectId: string;
	tokenVersion: number;
	type: "access" | "refresh";
};

/**
 * Generate new access + refresh token pair using the RS256 signing key.
 */
export async function generateTokens(
	userId: string,
	email: string,
	platformId: string,
	projectId: string,
	tokenVersion: number,
): Promise<{ accessToken: string; refreshToken: string }> {
	const keyPem = env.JWT_SIGNING_KEY;
	if (!keyPem) throw new Error("JWT_SIGNING_KEY not configured");

	const privateKey = await importPKCS8(keyPem, "RS256");

	const accessToken = await new SignJWT({
		sub: userId,
		email,
		platformId,
		projectId,
		tokenVersion,
		type: "access",
	} satisfies TokenPayload)
		.setProtectedHeader({ alg: "RS256" })
		.setIssuedAt()
		.setExpirationTime(env.JWT_ACCESS_TOKEN_EXPIRY || "1h")
		.sign(privateKey);

	const refreshToken = await new SignJWT({
		sub: userId,
		email,
		platformId,
		projectId,
		tokenVersion,
		type: "refresh",
	} satisfies TokenPayload)
		.setProtectedHeader({ alg: "RS256" })
		.setIssuedAt()
		.setExpirationTime(env.JWT_REFRESH_TOKEN_EXPIRY || "7d")
		.sign(privateKey);

	return { accessToken, refreshToken };
}
