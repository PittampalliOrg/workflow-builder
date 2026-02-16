/**
 * Tests for voice tools.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createVoiceTools,
  type VoiceProviderLike,
} from "../src/mastra/voice-tools.js";

describe("createVoiceTools", () => {
  it("should create text_to_speech tool", async () => {
    const voice: VoiceProviderLike = {
      speak: vi.fn().mockResolvedValue(Buffer.from("audio-data")),
    };

    const tools = createVoiceTools(voice);

    expect(tools["text_to_speech"]).toBeDefined();
    expect(tools["text_to_speech"].description).toContain("text to speech");

    const result = (await tools["text_to_speech"].execute({
      text: "Hello world",
      speaker: "en-US",
    })) as any;

    expect(result.audio_base64).toBe(Buffer.from("audio-data").toString("base64"));
    expect(result.format).toBe("audio/mpeg");
    expect(result.text_length).toBe(11);
    expect(voice.speak).toHaveBeenCalledWith("Hello world", { speaker: "en-US" });
  });

  it("should create speech_to_text tool", async () => {
    const voice: VoiceProviderLike = {
      listen: vi.fn().mockResolvedValue("transcribed text"),
    };

    const tools = createVoiceTools(voice);

    expect(tools["speech_to_text"]).toBeDefined();

    const audioBase64 = Buffer.from("fake-audio").toString("base64");
    const result = (await tools["speech_to_text"].execute({
      audio_base64: audioBase64,
      language: "en",
    })) as any;

    expect(result.text).toBe("transcribed text");
    expect(voice.listen).toHaveBeenCalledWith(
      expect.any(Buffer),
      { language: "en" },
    );
  });

  it("should create list_speakers tool", async () => {
    const speakers = [
      { id: "v1", name: "Alice" },
      { id: "v2", name: "Bob" },
    ];
    const voice: VoiceProviderLike = {
      getSpeakers: vi.fn().mockResolvedValue(speakers),
    };

    const tools = createVoiceTools(voice);

    expect(tools["list_speakers"]).toBeDefined();

    const result = (await tools["list_speakers"].execute({})) as any;
    expect(result.speakers).toEqual(speakers);
  });

  it("should only create tools for available methods", () => {
    const voiceSpeak: VoiceProviderLike = {
      speak: vi.fn(),
    };
    const tools = createVoiceTools(voiceSpeak);

    expect(tools["text_to_speech"]).toBeDefined();
    expect(tools["speech_to_text"]).toBeUndefined();
    expect(tools["list_speakers"]).toBeUndefined();
  });

  it("should return empty record for empty provider", () => {
    const tools = createVoiceTools({});
    expect(Object.keys(tools)).toHaveLength(0);
  });
});
