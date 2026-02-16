/**
 * Mastra Workspace Setup — extracts workspace tools from @mastra/core Workspace.
 *
 * Falls back to empty tool set if @mastra/core is not installed.
 * Enabled by MASTRA_WORKSPACE=true env var.
 */

import type { DurableAgentTool } from "../types/tool.js";
import { adaptMastraTools, type MastraToolLike } from "./tool-adapter.js";

/**
 * Attempt to create Mastra Workspace tools from a filesystem and sandbox.
 *
 * @param filesystem - Mastra Filesystem instance (or compatible object)
 * @param sandbox - Mastra Sandbox instance (or compatible object)
 * @returns Record of adapted workspace tools, or empty {} if @mastra/core unavailable
 */
export async function createMastraWorkspaceTools(
  filesystem: unknown,
  sandbox: unknown,
): Promise<Record<string, DurableAgentTool>> {
  try {
    // @ts-expect-error optional peer dependency
    const mastraCore = await import("@mastra/core");
    const Workspace = (mastraCore as any).Workspace;

    if (!Workspace) {
      console.warn(
        "[workspace-setup] @mastra/core loaded but Workspace class not found",
      );
      return {};
    }

    const workspace = new Workspace({ filesystem, sandbox });

    // Extract auto-injected tools from the workspace
    const tools: Record<string, MastraToolLike> = workspace.tools ?? {};

    if (Object.keys(tools).length === 0) {
      console.log("[workspace-setup] Workspace created but has no tools");
      return {};
    }

    const adapted = adaptMastraTools(tools);
    console.log(
      `[workspace-setup] Adapted ${Object.keys(adapted).length} Mastra workspace tool(s): ${Object.keys(adapted).join(", ")}`,
    );
    return adapted;
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find module") || msg.includes("MODULE_NOT_FOUND")) {
      console.log(
        "[workspace-setup] @mastra/core not installed, skipping workspace tools",
      );
    } else {
      console.warn(`[workspace-setup] Failed to create workspace tools: ${msg}`);
    }
    return {};
  }
}
