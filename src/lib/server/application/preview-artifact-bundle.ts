import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";
import type {
	PreviewAcceptanceArtifactSnapshot,
	PreviewArtifactCaptureCatalogPort,
} from "$lib/server/application/ports";
import type { StrictPreviewCapture } from "$lib/server/application/preview-acceptance-trust";

const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
const MAX_OVERLAY_BYTES = 25 * 1024 * 1024;
const MAX_OVERLAY_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_TAR_MEMBERS = 20_000;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class PreviewArtifactBundleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PreviewArtifactBundleError";
	}
}

export type ValidatedPreviewArtifactBundle = Readonly<{
	captureId: string;
	generation: string;
	services: readonly string[];
	overlayDigests: Readonly<Record<string, `sha256:${string}`>>;
}>;

function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function exactString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value || value !== value.trim()) {
		throw new PreviewArtifactBundleError(`overlay manifest ${field} is invalid`);
	}
	return value;
}

function safeRelativePath(value: unknown, field: string, allowRoot = false): string {
	const raw = exactString(value, field);
	if (raw.includes("\\") || raw.includes("\0") || raw.startsWith("/")) {
		throw new PreviewArtifactBundleError(`overlay manifest ${field} is unsafe`);
	}
	const parts = raw.split("/").filter((part) => part && part !== ".");
	if (parts.some((part) => part === "..") || (!allowRoot && parts.length === 0)) {
		throw new PreviewArtifactBundleError(`overlay manifest ${field} is unsafe`);
	}
	return parts.join("/") || ".";
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
		throw new PreviewArtifactBundleError(`overlay manifest ${field} is invalid`);
	}
	const values = value.map((entry, index) =>
		safeRelativePath(entry, `${field}[${index}]`),
	);
	if (new Set(values).size !== values.length) {
		throw new PreviewArtifactBundleError(`overlay manifest ${field} has duplicates`);
	}
	return values;
}

function mappings(value: unknown): Array<{ from: string; to: string }> {
	if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
		throw new PreviewArtifactBundleError("overlay captureMappings are invalid");
	}
	const result = value.map((entry, index) => {
		const mapping = object(entry);
		return {
			from: safeRelativePath(mapping.from, `captureMappings[${index}].from`),
			to: safeRelativePath(mapping.to, `captureMappings[${index}].to`),
		};
	});
	const identities = result.map(({ from, to }) => `${from}\0${to}`);
	if (new Set(identities).size !== identities.length) {
		throw new PreviewArtifactBundleError("overlay captureMappings have duplicates");
	}
	return result;
}

function canonicalStrings(values: readonly string[]): string {
	return JSON.stringify([...values].sort());
}

function canonicalMappings(
	values: readonly Readonly<{ from: string; to: string }>[],
): string {
	return JSON.stringify(
		[...values]
			.map(({ from, to }) => ({ from, to }))
			.sort((left, right) =>
				left.to.localeCompare(right.to) || left.from.localeCompare(right.from),
			),
	);
}

function decodeBase64(value: unknown): Buffer {
	const encoded = exactString(value, "tarGzipBase64");
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
		throw new PreviewArtifactBundleError("overlay tarGzipBase64 is invalid");
	}
	const bytes = Buffer.from(encoded, "base64");
	if (
		bytes.byteLength === 0 ||
		bytes.byteLength > MAX_OVERLAY_BYTES ||
		bytes[0] !== 0x1f ||
		bytes[1] !== 0x8b ||
		bytes.toString("base64") !== encoded
	) {
		throw new PreviewArtifactBundleError("overlay archive is invalid");
	}
	return bytes;
}

function digest(bytes: Buffer): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isUnder(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

async function validateTarArchive(
	archive: Buffer,
	allowedRoots: readonly string[],
): Promise<void> {
	let tar: Buffer;
	try {
		tar = gunzipSync(archive, { maxOutputLength: MAX_OVERLAY_EXPANDED_BYTES });
	} catch {
		throw new PreviewArtifactBundleError("overlay archive is not bounded gzip data");
	}
	const unpack = extract();
	let members = 0;
	let expandedBytes = 0;
	const seen = new Set<string>();
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const fail = (cause: unknown) => {
			if (settled) return;
			settled = true;
			reject(
				cause instanceof PreviewArtifactBundleError
					? cause
					: new PreviewArtifactBundleError("overlay tar archive is malformed"),
			);
		};
		unpack.on("entry", (header, stream, next) => {
			try {
				members += 1;
				if (members > MAX_TAR_MEMBERS) {
					throw new PreviewArtifactBundleError("overlay archive has too many members");
				}
				const path = safeRelativePath(header.name, "tar member path");
				if (seen.has(path)) {
					throw new PreviewArtifactBundleError("overlay archive has duplicate members");
				}
				seen.add(path);
				if (header.type !== "file" && header.type !== "directory") {
					throw new PreviewArtifactBundleError("overlay archive contains a link or special file");
				}
				if (!allowedRoots.some((root) => isUnder(path, root))) {
					throw new PreviewArtifactBundleError(
						`overlay archive member ${path} is outside catalog capture roots`,
					);
				}
				stream.on("data", (chunk: Buffer) => {
					expandedBytes += chunk.byteLength;
					if (expandedBytes > MAX_OVERLAY_EXPANDED_BYTES) {
						stream.destroy(
							new PreviewArtifactBundleError("overlay archive exceeds expanded limit"),
						);
					}
				});
				stream.on("end", next);
				stream.on("error", fail);
				stream.resume();
			} catch (cause) {
				stream.resume();
				fail(cause);
			}
		});
		unpack.on("finish", () => {
			if (!settled) {
				settled = true;
				resolve();
			}
		});
		unpack.on("error", fail);
		unpack.end(tar);
	});
	if (members === 0) {
		throw new PreviewArtifactBundleError("overlay archive is empty");
	}
}

export async function validatePreviewArtifactBundle(input: {
	bytes: Buffer;
	artifact: PreviewAcceptanceArtifactSnapshot;
	capture: StrictPreviewCapture;
	catalog: PreviewArtifactCaptureCatalogPort;
}): Promise<ValidatedPreviewArtifactBundle> {
	let manifest: Record<string, unknown>;
	try {
		const raw = gunzipSync(input.bytes, { maxOutputLength: MAX_MANIFEST_BYTES });
		manifest = object(JSON.parse(raw.toString("utf8")));
	} catch {
		throw new PreviewArtifactBundleError("artifact bytes are not a bounded overlay-set manifest");
	}
	if (
		manifest.version !== 2 ||
		manifest.tier !== "tar-overlay-set" ||
		manifest.captureProtocol !== "atomic-generation-v2" ||
		manifest.acceptanceEligible !== true
	) {
		throw new PreviewArtifactBundleError("artifact bytes are not a strict overlay set");
	}
	const captureId = exactString(manifest.captureId, "captureId");
	const generation = exactString(manifest.generation, "generation");
	const catalogDigest = exactString(manifest.catalogDigest, "catalogDigest");
	const sourceRevision = exactString(manifest.sourceRevision, "sourceRevision");
	const platformRevision = exactString(manifest.platformRevision, "platformRevision");
	const repository = exactString(manifest.repoUrl, "repoUrl");
	const base = exactString(manifest.base, "base");
	if (
		captureId !== input.capture.captureId ||
		generation !== input.capture.generation ||
		catalogDigest !== input.capture.catalogDigest ||
		sourceRevision !== input.capture.capturedSourceRevision ||
		platformRevision !== input.capture.platformRevision ||
		repository !== input.capture.repo ||
		base !== input.capture.base ||
		catalogDigest !== input.catalog.currentDigest()
	) {
		throw new PreviewArtifactBundleError(
			"overlay-set bytes do not match strict artifact provenance",
		);
	}
	const entries = manifest.services;
	if (!Array.isArray(entries) || entries.length < 1 || entries.length > 32) {
		throw new PreviewArtifactBundleError("overlay-set services are invalid");
	}
	const parsed: Array<{ service: string; contentSha256: `sha256:${string}` }> = [];
	for (const rawEntry of entries) {
		const entry = object(rawEntry);
		const service = exactString(entry.service, "service");
		if (!SAFE_SERVICE.test(service) || parsed.some((item) => item.service === service)) {
			throw new PreviewArtifactBundleError("overlay-set service identity is invalid");
		}
		const contract = input.catalog.captureContract(service);
		if (!contract) {
			throw new PreviewArtifactBundleError(`service ${service} is not preview-native`);
		}
		if (contract.repository !== repository || contract.base !== base) {
			throw new PreviewArtifactBundleError(`service ${service} repository contract changed`);
		}
		const repoSubdir = safeRelativePath(entry.repoSubdir, "repoSubdir", true);
		const syncPaths = stringArray(entry.syncPaths, "syncPaths");
		const captureMappings = mappings(entry.captureMappings);
		if (
			repoSubdir !== contract.repoSubdir ||
			canonicalStrings(syncPaths) !== canonicalStrings(contract.syncPaths) ||
			canonicalMappings(captureMappings) !== canonicalMappings(contract.captureMappings)
		) {
			throw new PreviewArtifactBundleError(
				`service ${service} capture paths do not match the catalog`,
			);
		}
		const tarGzip = decodeBase64(entry.tarGzipBase64);
		const contentSha256 = exactString(entry.contentSha256, "contentSha256");
		if (!SHA256.test(contentSha256) || digest(tarGzip) !== contentSha256) {
			throw new PreviewArtifactBundleError(`service ${service} overlay digest mismatch`);
		}
		await validateTarArchive(
			tarGzip,
			contract.captureMappings.map(({ from }) => from),
		);
		parsed.push({
			service,
			contentSha256: contentSha256 as `sha256:${string}`,
		});
	}
	const services = parsed.map(({ service }) => service).sort();
	if (canonicalStrings(services) !== canonicalStrings(input.capture.services)) {
		throw new PreviewArtifactBundleError("overlay-set services do not match artifact metadata");
	}
	const payload = object(input.artifact.inlinePayload);
	const metadataDigests = object(payload.overlayDigests);
	const overlayDigests = Object.fromEntries(
		parsed.map(({ service, contentSha256 }) => [service, contentSha256]),
	) as Record<string, `sha256:${string}`>;
	if (
		Object.keys(metadataDigests).length !== services.length ||
		services.some((service) => metadataDigests[service] !== overlayDigests[service])
	) {
		throw new PreviewArtifactBundleError(
			"overlay-set byte digests do not match artifact metadata",
		);
	}
	return Object.freeze({
		captureId,
		generation,
		services: Object.freeze(services),
		overlayDigests: Object.freeze(overlayDigests),
	});
}
