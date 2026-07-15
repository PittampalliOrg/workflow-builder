import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FunctionRegistry } from "./types.js";
import {
  clearRegistryCache,
  loadRegistry,
  lookupFunction,
  lookupBuiltinFallback,
  mergeMountedRegistry,
  registryFilePath,
  strictRegistryEnabled,
} from "./registry.js";

describe("strict function registry", () => {
  const tempDirectories: string[] = [];
  const mounted: FunctionRegistry = {
    "system/*": { appId: "fn-system", type: "knative" },
  };

  afterEach(async () => {
    clearRegistryCache();
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("treats only an explicit true value as strict", () => {
    expect(strictRegistryEnabled("true")).toBe(true);
    expect(strictRegistryEnabled(" TRUE ")).toBe(true);
    expect(strictRegistryEnabled("false")).toBe(false);
    expect(strictRegistryEnabled(undefined)).toBe(false);
  });

  it("keeps the mounted registry authoritative in strict mode", () => {
    expect(mergeMountedRegistry(mounted, true)).toEqual(mounted);
    expect(mergeMountedRegistry(mounted, true)).not.toHaveProperty("browser/*");
    expect(mergeMountedRegistry(mounted, true)).not.toHaveProperty("_default");
  });

  it("retains persistent-dev fallbacks outside strict mode", () => {
    expect(mergeMountedRegistry(mounted, false)).toMatchObject({
      "system/*": mounted["system/*"],
      "browser/*": {
        appId: "openshell-agent-runtime",
        type: "knative",
      },
      _default: { type: "activepieces" },
    });
  });

  it("does not resolve an undeployed builtin in strict mode", () => {
    expect(lookupBuiltinFallback("browser/validate", true)).toBeUndefined();
    expect(lookupBuiltinFallback("browser/validate", false)).toEqual({
      appId: "openshell-agent-runtime",
      type: "knative",
    });
  });

  it("loads the mounted registry first and rejects unknown routes in strict mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "function-registry-"));
    tempDirectories.push(directory);
    const registryPath = join(directory, "functions.json");
    await writeFile(registryPath, JSON.stringify(mounted), "utf8");
    vi.stubEnv("REGISTRY_FILE_PATH", registryPath);
    vi.stubEnv("FUNCTION_REGISTRY_STRICT", "true");
    vi.stubEnv(
      "FUNCTION_REGISTRY",
      JSON.stringify({ _default: { type: "activepieces" } }),
    );

    expect(registryFilePath()).toBe(registryPath);
    expect(await loadRegistry()).toEqual(mounted);
    await expect(lookupFunction("browser/validate")).rejects.toThrow(
      'No Knative function registered for function slug "browser/validate"',
    );
  });

  it("fails closed when strict mode has no readable registry source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "function-registry-"));
    tempDirectories.push(directory);
    vi.stubEnv("REGISTRY_FILE_PATH", join(directory, "missing.json"));
    vi.stubEnv("FUNCTION_REGISTRY_STRICT", "true");
    vi.stubEnv(
      "FUNCTION_REGISTRY",
      JSON.stringify({ _default: { type: "activepieces" } }),
    );

    expect(await loadRegistry()).toEqual({});
    await expect(lookupFunction("system/http-request")).rejects.toThrow(
      "Available patterns: ",
    );
  });

  it("fails closed when the strict mounted registry is malformed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "function-registry-"));
    tempDirectories.push(directory);
    const registryPath = join(directory, "functions.json");
    await writeFile(registryPath, "{not-json", "utf8");
    vi.stubEnv("REGISTRY_FILE_PATH", registryPath);
    vi.stubEnv("FUNCTION_REGISTRY_STRICT", "true");
    vi.stubEnv(
      "FUNCTION_REGISTRY",
      JSON.stringify({ _default: { type: "activepieces" } }),
    );

    expect(await loadRegistry()).toEqual({});
    await expect(lookupFunction("system/http-request")).rejects.toThrow(
      'No Knative function registered for function slug "system/http-request"',
    );
  });

  it("keeps the cache stable until explicitly cleared", async () => {
    const directory = await mkdtemp(join(tmpdir(), "function-registry-"));
    tempDirectories.push(directory);
    const registryPath = join(directory, "functions.json");
    vi.stubEnv("REGISTRY_FILE_PATH", registryPath);
    vi.stubEnv("FUNCTION_REGISTRY_STRICT", "true");
    await writeFile(registryPath, JSON.stringify(mounted), "utf8");

    expect(await loadRegistry()).toEqual(mounted);
    const replacement: FunctionRegistry = {
      "code/*": { appId: "code-runtime", type: "knative" },
    };
    await writeFile(registryPath, JSON.stringify(replacement), "utf8");
    expect(await loadRegistry()).toEqual(mounted);

    clearRegistryCache();
    expect(await loadRegistry()).toEqual(replacement);
  });
});
