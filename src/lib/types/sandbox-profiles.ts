import type { PackageManager } from "./environments";

/**
 * Per-manager list of package specs the profile pre-installs at image build
 * time. Each string follows the manager's native syntax (pip uses
 * `pkg==1.0.0`, npm uses `pkg@1.0.0`, apt uses the package name, etc.).
 * Mirrors CMA's `environment.packages` shape verbatim.
 */
export type SandboxProfilePackages = Partial<Record<PackageManager, string[]>>;

/**
 * Build-status lifecycle states surfaced by the admin UI + recorded per
 * profile row.
 *
 * - `null` — never built (fresh profile, no image yet)
 * - `"building"` — Tekton pipeline in flight
 * - `"built"` — succeeded, imageTag is the current artifact
 * - `"failed"` — pipeline failed; lastBuildError carries the message
 */
export type SandboxProfileBuildStatus =
	| "building"
	| "built"
	| "failed"
	| null;

export type SandboxProfile = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	baseProfileSlug: string | null;
	packages: SandboxProfilePackages;
	capabilities: string[];
	dockerfilePath: string | null;
	imageTag: string | null;
	lastBuild: {
		sha: string | null;
		at: string | null;
		status: SandboxProfileBuildStatus;
		error: string | null;
	};
	isArchived: boolean;
	isBuiltin: boolean;
	usedByCount?: number;
	createdAt: string;
	updatedAt: string;
};

/**
 * The builtin profile slugs. Seeded on first workflow-builder start via
 * `scripts/seed-sandbox-profiles.ts`. These rows have `isBuiltin: true` and
 * are guarded against archive/delete in the admin UI.
 */
export const BUILTIN_PROFILE_SLUGS = [
	"dapr-agent",
	"dapr-agent-xlsx",
	"dapr-agent-animation",
	"dapr-agent-datasci",
	"dapr-agent-webdev",
] as const;

export type BuiltinProfileSlug = (typeof BUILTIN_PROFILE_SLUGS)[number];

/**
 * Slugs must match Docker-image-tag-safe characters — lowercase alnum + dash,
 * no leading/trailing dash, no double dashes, max 63 chars.
 */
export const PROFILE_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
