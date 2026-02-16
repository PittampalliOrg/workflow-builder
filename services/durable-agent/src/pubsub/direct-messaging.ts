/**
 * Direct agent-to-agent messaging via Dapr Pub/Sub.
 * Mirrors Python dapr_agents/workflow/utils/pubsub.py send_message_to_agent().
 */

import { DaprClient } from "@dapr/dapr";
import type { AgentTaskResponse } from "../types/trigger.js";

/**
 * Metadata entry for a registered agent.
 */
export interface AgentRegistryEntry {
  pubsub?: {
    agent_topic?: string;
    name?: string;
    broadcast_topic?: string;
  };
  agent?: {
    type?: string;
    appid?: string;
    role?: string;
    goal?: string;
    statestore?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Send a direct message to a specific agent using its registry metadata.
 */
export async function sendMessageToAgent(
  client: DaprClient,
  source: string,
  targetAgent: string,
  message: AgentTaskResponse,
  agentsMetadata: Record<string, AgentRegistryEntry>,
): Promise<void> {
  const meta = agentsMetadata[targetAgent];
  if (!meta) {
    console.warn(
      `[direct-msg] Target '${targetAgent}' not in registry; skipping.`,
    );
    return;
  }

  const topic = meta.pubsub?.agent_topic;
  const pubsubName = meta.pubsub?.name;
  if (!topic || !pubsubName) {
    console.warn(
      `[direct-msg] Agent '${targetAgent}' missing pubsub config; skipping.`,
    );
    return;
  }

  const payload = {
    ...message,
    role: "user",
    name: source,
  };

  try {
    await client.pubsub.publish(pubsubName, topic, payload, {
      metadata: {
        "cloudevent.type": "AgentTaskResponse",
        "cloudevent.source": source,
      },
    } as any);
    console.log(
      `[direct-msg] ${source} -> ${targetAgent} on topic '${topic}'`,
    );
  } catch (err) {
    console.error(`[direct-msg] Failed to send to ${targetAgent}: ${err}`);
    throw err;
  }
}
