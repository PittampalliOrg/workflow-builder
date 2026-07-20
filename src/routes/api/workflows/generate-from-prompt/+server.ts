import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { ModelCompletionPort } from "$lib/server/application/ports";

const SYSTEM_PROMPT = `You are a workflow generator. Given a user's description, generate a CNCF Serverless Workflow 1.0 definition with nodes and edges for a visual workflow builder.

Available SW 1.0 node types:
- start: The entry point of the workflow
- end: The termination point of the workflow
- call: Invokes an external function or service (taskConfig: { function, arguments })
- agent: Invokes dapr-agent-py through durable/run (taskConfig: durable/run body with prompt, agentConfig, agentGraph, optional agentConfig.mcpServers)
- set: Sets workflow variables (taskConfig: { variables: { key: value } })
- switch: Conditional branching (taskConfig: { conditions: [{ name, condition, then }] })
- wait: Waits for a duration or event (taskConfig: { duration, event })
- emit: Emits an event (taskConfig: { event: { type, source, data } })
- listen: Listens for an event (taskConfig: { event: { type, source } })
- for: Iterates over a collection (taskConfig: { each, in, do })
- fork: Parallel execution branches (taskConfig: { branches: [{ name, steps }] })
- try: Error handling with try/catch (taskConfig: { try, catch })
- run: Runs a subprocess or container (taskConfig: { command, args })
- raise: Raises an error (taskConfig: { error: { status, type, title } })
- do: Groups a sequence of steps (taskConfig: { steps: [] })

Node structure:
{
  "id": "unique-string-id",
  "type": "<node-type>",
  "position": { "x": number, "y": number },
  "data": {
    "label": "Human-readable label",
    "type": "<node-type>",
    "taskType": "<node-type>",
    "taskConfig": { ... },
    "status": "idle",
    "enabled": true
  }
}

Edge structure:
{
  "id": "source-id->target-id",
  "source": "source-node-id",
  "target": "target-node-id",
  "sourceHandle": "optional-handle-name"
}

Rules:
1. Always include a "start" node and an "end" node
2. Lay out nodes vertically with ~150px spacing in y
3. Center nodes around x=250
4. Connect all nodes with edges in proper execution order
5. Use descriptive labels
6. For switch nodes, use sourceHandle to indicate which branch an edge comes from

Respond with ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "name": "Workflow Name",
  "description": "Brief description",
  "nodes": [...],
  "edges": [...]
}`;

async function callKimi(
  prompt: string,
  modelCompletion: Pick<ModelCompletionPort, "complete">,
) {
  return modelCompletion.complete({
    maxOutputTokens: 4096,
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  });
}

function extractJson(text: string): Record<string, unknown> {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract JSON from markdown code blocks
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      return JSON.parse(match[1].trim());
    }
    // Try to find JSON object in the text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error("Could not extract valid JSON from LLM response");
  }
}

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json();
  const { prompt, name, complexity } = body;

  if (!prompt || typeof prompt !== "string") {
    return error(400, "Missing or invalid prompt");
  }

  const modelCompletion = getApplicationAdapters().modelCompletion;
  const kimiAvailable = modelCompletion.isAvailable();

  if (!kimiAvailable) {
    return error(
      503,
      "KIMI_API_KEY is not configured",
    );
  }

  const enrichedPrompt = [
    `Generate a workflow for: ${prompt}`,
    name ? `Workflow name: ${name}` : "",
    complexity ? `Complexity level: ${complexity}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const responseText = await callKimi(enrichedPrompt, modelCompletion);

    const result = extractJson(responseText);

    // Validate basic structure
    if (!Array.isArray(result.nodes) || !Array.isArray(result.edges)) {
      return error(500, "LLM response missing nodes or edges arrays");
    }

    return json({
      name: result.name || name || "AI Generated Workflow",
      description: result.description || "",
      nodes: result.nodes,
      edges: result.edges,
    });
  } catch (err) {
    console.error("AI generation failed:", err);
    return error(
      500,
      `AI generation failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
};
