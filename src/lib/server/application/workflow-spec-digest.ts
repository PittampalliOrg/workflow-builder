import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("workflow spec is not JSON");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Stable digest for an executable workflow spec, independent of JSONB key order. */
export function workflowSpecDigest(spec: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(spec), "utf8")
    .digest("hex")}`;
}
