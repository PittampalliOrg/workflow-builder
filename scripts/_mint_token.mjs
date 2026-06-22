// Mint a BFF access token (RS256) for a cluster, signed with its JWT_SIGNING_KEY.
// Usage: node scripts/_mint_token.mjs <keyPemPath> <projectId> [sub] [email] [platformId]
import { readFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";

const [, , keyPath, projectId, sub, email, platformId] = process.argv;
if (!keyPath || !projectId) {
	console.error("usage: _mint_token.mjs <keyPemPath> <projectId> [sub] [email] [platformId]");
	process.exit(1);
}
const key = await importPKCS8(readFileSync(keyPath, "utf-8"), "RS256");
const token = await new SignJWT({
	sub: sub || "640e9vekv3saahy59g8il",
	email: email || "vinod@pittampalli.com",
	platformId: platformId || "default-platform",
	projectId,
	tokenVersion: 0,
	type: "access",
})
	.setProtectedHeader({ alg: "RS256" })
	.setIssuedAt()
	.setExpirationTime("12h")
	.sign(key);
console.log(token);
