/**
 * RAG Tools — creates vector/graph query tools from @mastra/rag.
 *
 * Falls back to empty tool set if @mastra/rag is not installed.
 * Config from MASTRA_RAG_TOOLS env var (JSON array of RagToolConfig).
 */

import type { DurableAgentTool } from "../types/tool.js";
import { adaptMastraTool, type MastraToolLike } from "./tool-adapter.js";
import { resolveEmbeddingModel } from "./model-router.js";

export interface RagToolConfig {
  /** Name of the vector store (Dapr state store or external). */
  vectorStoreName: string;
  /** Index/collection name within the store. */
  indexName: string;
  /** Embedding model spec, e.g., "openai/text-embedding-3-small". */
  model: string;
  /** Tool type: "vector" for similarity search, "graph" for knowledge graph. */
  type?: "vector" | "graph";
  /** Optional custom tool name. */
  name?: string;
  /** Optional custom description. */
  description?: string;
}

/**
 * Parse MASTRA_RAG_TOOLS env var into RAG tool configs.
 */
export function parseRagToolsConfig(): RagToolConfig[] {
  const raw = process.env.MASTRA_RAG_TOOLS;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn("[rag-tools] MASTRA_RAG_TOOLS is not a JSON array, ignoring");
      return [];
    }
    return parsed as RagToolConfig[];
  } catch (err) {
    console.warn(`[rag-tools] Failed to parse MASTRA_RAG_TOOLS: ${err}`);
    return [];
  }
}

/**
 * Create RAG tools from configuration.
 *
 * @param configs - Array of RAG tool configs (defaults to parsing env var)
 * @returns Record of adapted RAG tools
 */
export async function createRagTools(
  configs?: RagToolConfig[],
): Promise<Record<string, DurableAgentTool>> {
  const toolConfigs = configs ?? parseRagToolsConfig();
  if (toolConfigs.length === 0) return {};

  try {
    // @ts-expect-error optional peer dependency
    const mastraRag = await import("@mastra/rag");
    const createVectorQueryTool = (mastraRag as any).createVectorQueryTool;
    const createGraphRAGTool = (mastraRag as any).createGraphRAGTool;

    const tools: Record<string, DurableAgentTool> = {};

    for (const cfg of toolConfigs) {
      const toolType = cfg.type ?? "vector";
      const toolName =
        cfg.name ??
        `rag_${toolType}_${cfg.vectorStoreName}_${cfg.indexName}`;

      try {
        const embeddingModel = resolveEmbeddingModel(cfg.model);

        let rawTool: MastraToolLike;

        if (toolType === "graph" && createGraphRAGTool) {
          rawTool = createGraphRAGTool({
            vectorStoreName: cfg.vectorStoreName,
            indexName: cfg.indexName,
            model: embeddingModel,
            description: cfg.description,
          });
        } else if (createVectorQueryTool) {
          rawTool = createVectorQueryTool({
            vectorStoreName: cfg.vectorStoreName,
            indexName: cfg.indexName,
            model: embeddingModel,
            description: cfg.description,
          });
        } else {
          console.warn(
            `[rag-tools] Tool factory for type "${toolType}" not found in @mastra/rag`,
          );
          continue;
        }

        tools[toolName] = adaptMastraTool(rawTool);
        console.log(`[rag-tools] Created RAG tool: ${toolName} (${toolType})`);
      } catch (err) {
        console.warn(
          `[rag-tools] Failed to create RAG tool "${toolName}": ${err}`,
        );
      }
    }

    return tools;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find module") || msg.includes("MODULE_NOT_FOUND")) {
      console.log("[rag-tools] @mastra/rag not installed, skipping RAG tools");
    } else {
      console.warn(`[rag-tools] Failed to create RAG tools: ${msg}`);
    }
    return {};
  }
}
