/**
 * Broadcast messaging via Dapr Pub/Sub.
 * Mirrors Python dapr_agents/workflow/utils/pubsub.py broadcast_message().
 */

import { DaprClient } from "@dapr/dapr";
import type { BroadcastMessage } from "../types/trigger.js";

/**
 * Broadcast a message to all agents via the broadcast topic.
 */
export async function broadcastMessage(
  client: DaprClient,
  pubsubName: string,
  broadcastTopic: string,
  source: string,
  message: BroadcastMessage,
): Promise<void> {
  const payload = {
    ...message,
    role: "user",
    name: source,
  };

  try {
    await client.pubsub.publish(pubsubName, broadcastTopic, payload, {
      metadata: {
        "cloudevent.type": "BroadcastMessage",
        "cloudevent.source": source,
      },
    } as any);
    console.log(
      `[broadcast] ${source} published to topic '${broadcastTopic}'`,
    );
  } catch (err) {
    console.error(`[broadcast] Failed to publish: ${err}`);
    throw err;
  }
}
