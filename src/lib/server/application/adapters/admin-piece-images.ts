import { createHmac } from "node:crypto";
import { env } from "$env/dynamic/private";
import type {
	AdminPieceRuntimeImageBuildPort,
	AdminPieceRuntimeImageRegistryPort,
} from "$lib/server/application/ports";

const GHCR_ORG = (env.PIECE_IMAGE_GHCR_ORG || "pittampalliorg").toLowerCase();
const GHCR_REPO_PREFIX = env.PIECE_IMAGE_REPO_PREFIX || "ap-piece";
const GHCR_TOKEN_USER = env.PIECE_IMAGE_GHCR_USER || GHCR_ORG;

function pieceImageRepo(pieceName: string): string {
	return `${GHCR_ORG}/${GHCR_REPO_PREFIX}-${pieceName}`;
}

function pieceImageRef(pieceName: string, version: string): string {
	return `ghcr.io/${pieceImageRepo(pieceName)}:${version}`;
}

async function ghcrImageExists(
	pieceName: string,
	version: string,
): Promise<{ exists: boolean; digest?: string }> {
	const repo = pieceImageRepo(pieceName);
	const ght = env.GITHUB_TOKEN;
	try {
		const tokenHeaders: Record<string, string> = {};
		if (ght) {
			tokenHeaders.Authorization =
				"Basic " + Buffer.from(`${GHCR_TOKEN_USER}:${ght}`).toString("base64");
		}
		const tokenRes = await fetch(
			`https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`,
			{ headers: tokenHeaders, signal: AbortSignal.timeout(8000) },
		);
		if (!tokenRes.ok) return { exists: false };
		const token = ((await tokenRes.json()) as { token?: string } | null)?.token;
		if (!token) return { exists: false };

		const manifestRes = await fetch(
			`https://ghcr.io/v2/${repo}/manifests/${encodeURIComponent(version)}`,
			{
				method: "HEAD",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept:
						"application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json",
				},
				signal: AbortSignal.timeout(8000),
			},
		);
		if (manifestRes.status === 200) {
			return {
				exists: true,
				digest: manifestRes.headers.get("docker-content-digest") ?? undefined,
			};
		}
		return { exists: false };
	} catch {
		return { exists: false };
	}
}

async function triggerPieceImageBuild(args: {
	pieceName: string;
	pieceVersion: string;
	callbackUrl: string;
}): Promise<{ triggered: boolean; status?: number; reason?: string }> {
	const elUrl = env.PIECE_BUILD_TRIGGER_URL;
	if (!elUrl) return { triggered: false, reason: "PIECE_BUILD_TRIGGER_URL not configured" };
	const secret = env.PIECE_BUILD_TRIGGER_SECRET;
	if (!secret) return { triggered: false, reason: "PIECE_BUILD_TRIGGER_SECRET not configured" };
	try {
		const body = JSON.stringify({
			pieceName: args.pieceName,
			pieceVersion: args.pieceVersion,
			callbackUrl: args.callbackUrl,
			gitSha: env.PIECE_BUILD_GIT_SHA || "main",
		});
		const signature =
			"sha256=" + createHmac("sha256", secret).update(body).digest("hex");
		const res = await fetch(elUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Hub-Signature-256": signature,
				"X-GitHub-Event": "perpiece-build",
			},
			body,
			signal: AbortSignal.timeout(10000),
		});
		return { triggered: res.ok, status: res.status };
	} catch (err) {
		return {
			triggered: false,
			reason: err instanceof Error ? err.message : "trigger failed",
		};
	}
}

export class LegacyAdminPieceRuntimeImageRegistryPort
	implements AdminPieceRuntimeImageRegistryPort
{
	imageExists(input: { pieceName: string; version: string }) {
		return ghcrImageExists(input.pieceName, input.version);
	}

	imageRef(input: { pieceName: string; version: string }) {
		return pieceImageRef(input.pieceName, input.version);
	}
}

export class LegacyAdminPieceRuntimeImageBuildPort
	implements AdminPieceRuntimeImageBuildPort
{
	triggerBuild(input: {
		pieceName: string;
		pieceVersion: string;
		callbackUrl: string;
	}) {
		return triggerPieceImageBuild(input);
	}
}
