/**
 * Send Slack message step
 */
import type { SlackCredentials } from "../types.js";

const SLACK_API_URL = "https://slack.com/api";

type SlackPostMessageResponse = {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
};

export type SendMessageInput = {
  slackChannel: string;
  slackMessage: string;
};

export type SendMessageResult =
  | { success: true; ts: string; channel: string }
  | { success: false; error: string };

export async function sendMessageStep(
  input: SendMessageInput,
  credentials: SlackCredentials
): Promise<SendMessageResult> {
  const apiKey = credentials.SLACK_API_KEY || credentials.SLACK_BOT_TOKEN;

  if (!apiKey) {
    return {
      success: false,
      error:
        "SLACK_API_KEY is not configured. Please add it in Project Integrations.",
    };
  }

  try {
    const response = await fetch(`${SLACK_API_URL}/chat.postMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        channel: input.slackChannel,
        text: input.slackMessage,
      }),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: Failed to send Slack message`,
      };
    }

    const result = (await response.json()) as SlackPostMessageResponse;

    if (!result.ok) {
      return {
        success: false,
        error: result.error || "Failed to send Slack message",
      };
    }

    return {
      success: true,
      ts: result.ts || "",
      channel: result.channel || "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to send Slack message: ${message}`,
    };
  }
}
