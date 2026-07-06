import { existsSync, readFileSync } from "node:fs";

/**
 * File-first image-pin readers (preview image freshness, Phase 0).
 *
 * Preview environments historically froze image pins into pod env at provision
 * time. We are moving to ONE git-synced ConfigMap (`workflow-builder-image-pins`,
 * mounted as a directory at /etc/workflow-builder/image-pins) read file-first per
 * call, so a re-provision mid-life picks up the latest pins without a re-render.
 *
 * These readers are INERT until the new env vars are set: with no file configured
 * every lookup falls through to the existing pod env, preserving today's behavior.
 * Modeled on loadSwebenchInferenceEnvironmentMappings (mounted-file read per call,
 * tolerant of a missing/broken file).
 */

type Env = Record<string, string | undefined>;

// Warn-once guards keyed by the offending path so a broken mount logs a single
// line, not one per request (these readers run on every resolve).
const warnedPaths = new Set<string>();

function warnOnce(path: string, message: string): void {
	if (warnedPaths.has(path)) return;
	warnedPaths.add(path);
	console.warn(message);
}

function readString(value: string | undefined): string | null {
	const trimmed = (value ?? "").trim();
	return trimmed ? trimmed : null;
}

/**
 * Parse the git-synced runtime-images pin file (env WORKFLOW_BUILDER_IMAGE_PINS_FILE):
 * a JSON object of envKey → image ref. Returns {} on a missing/unreadable/invalid
 * file (warn once) so a broken mount degrades to the pod-env fallback, never a throw.
 */
export function loadImagePins(env: Env = process.env): Record<string, string> {
	const path = readString(env.WORKFLOW_BUILDER_IMAGE_PINS_FILE);
	if (!path) return {};
	if (!existsSync(path)) return {};
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		warnOnce(path, `[image-pins] failed reading ${path}: ${String(err)}`);
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warnOnce(path, `[image-pins] ${path} is not a JSON object; ignoring`);
			return {};
		}
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === "string" && value.trim()) out[key] = value.trim();
		}
		return out;
	} catch (err) {
		warnOnce(path, `[image-pins] failed parsing ${path}: ${String(err)}`);
		return {};
	}
}

/**
 * Resolve one image pin for an env key: the git-synced file wins, else the pod env
 * var, else null. Callers keep their own descriptor fallback (`... ?? fallback`).
 */
export function resolveImagePin(envKey: string, env: Env = process.env): string | null {
	const filePins = loadImagePins(env);
	return filePins[envKey] ?? readString(env[envKey]) ?? null;
}

/**
 * The execution-classes JSON string, file-first: the mounted classes.json (env
 * SANDBOX_EXECUTION_CLASSES_FILE) wins over the inline SANDBOX_EXECUTION_CLASSES_JSON
 * env, else null. Consumers parse the string exactly as they parse the env today, so
 * merge-over-defaults semantics are unchanged. Returns null (not "") when neither is
 * set so callers can keep their `if (!raw) return` guards.
 */
export function loadExecutionClassesJson(env: Env = process.env): string | null {
	const path = readString(env.SANDBOX_EXECUTION_CLASSES_FILE);
	if (path && existsSync(path)) {
		try {
			const raw = readFileSync(path, "utf8");
			if (raw.trim()) return raw;
		} catch (err) {
			warnOnce(path, `[image-pins] failed reading ${path}: ${String(err)}`);
		}
	}
	return readString(env.SANDBOX_EXECUTION_CLASSES_JSON);
}
