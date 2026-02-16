/**
 * Voice Tools — TTS/STT as agent tools.
 *
 * Creates text_to_speech, speech_to_text, and list_speakers tools
 * from a Mastra voice provider. Audio encoded as base64 for Dapr activity
 * JSON serialization.
 */

import type { DurableAgentTool } from "../types/tool.js";

/**
 * Structural interface matching a Mastra voice provider.
 */
export interface VoiceProviderLike {
  speak?(
    text: string,
    options?: { speaker?: string },
  ): Promise<ReadableStream<Uint8Array> | Buffer | ArrayBuffer>;
  listen?(
    audio: ReadableStream<Uint8Array> | Buffer | ArrayBuffer,
    options?: { language?: string },
  ): Promise<string>;
  getSpeakers?(): Promise<Array<{ id: string; name: string }>>;
}

/**
 * Collect a readable stream into a Buffer.
 */
async function streamToBuffer(
  stream: ReadableStream<Uint8Array> | Buffer | ArrayBuffer,
): Promise<Buffer> {
  if (Buffer.isBuffer(stream)) return stream;
  if (stream instanceof ArrayBuffer) return Buffer.from(stream);

  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Create voice-related tools from a Mastra voice provider.
 *
 * @param voice - A Mastra-compatible voice provider
 * @returns Record of voice tools (text_to_speech, speech_to_text, list_speakers)
 */
export function createVoiceTools(
  voice: VoiceProviderLike,
): Record<string, DurableAgentTool> {
  const tools: Record<string, DurableAgentTool> = {};

  if (voice.speak) {
    const speakFn = voice.speak.bind(voice);
    tools["text_to_speech"] = {
      description:
        "Convert text to speech audio. Returns base64-encoded audio data.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to convert to speech" },
          speaker: {
            type: "string",
            description: "Optional speaker/voice ID",
          },
        },
        required: ["text"],
      },
      execute: async (args: Record<string, unknown>) => {
        const text = String(args.text ?? "");
        const speaker = args.speaker ? String(args.speaker) : undefined;
        const audioStream = await speakFn(text, { speaker });
        const buffer = await streamToBuffer(audioStream);
        return {
          audio_base64: buffer.toString("base64"),
          format: "audio/mpeg",
          text_length: text.length,
        };
      },
    };
  }

  if (voice.listen) {
    const listenFn = voice.listen.bind(voice);
    tools["speech_to_text"] = {
      description:
        "Convert speech audio to text. Accepts base64-encoded audio data.",
      inputSchema: {
        type: "object",
        properties: {
          audio_base64: {
            type: "string",
            description: "Base64-encoded audio data",
          },
          language: {
            type: "string",
            description: "Optional language code (e.g., 'en')",
          },
        },
        required: ["audio_base64"],
      },
      execute: async (args: Record<string, unknown>) => {
        const audioBase64 = String(args.audio_base64 ?? "");
        const language = args.language ? String(args.language) : undefined;
        const buffer = Buffer.from(audioBase64, "base64");
        const text = await listenFn(buffer, { language });
        return { text };
      },
    };
  }

  if (voice.getSpeakers) {
    const getSpeakersFn = voice.getSpeakers.bind(voice);
    tools["list_speakers"] = {
      description: "List available voice speakers/voices.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      execute: async () => {
        const speakers = await getSpeakersFn();
        return { speakers };
      },
    };
  }

  if (Object.keys(tools).length > 0) {
    console.log(
      `[voice-tools] Created ${Object.keys(tools).length} voice tool(s): ${Object.keys(tools).join(", ")}`,
    );
  }

  return tools;
}
