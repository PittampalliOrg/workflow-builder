import { createHash } from "node:crypto";
import type { EnvironmentConfig } from "$lib/types/environments";
import { canonicalJson } from "$lib/server/agents/config-hash";

export function hashEnvironmentConfig(config: EnvironmentConfig): string {
	return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

export { canonicalJson };
