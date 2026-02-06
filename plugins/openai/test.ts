import OpenAI from "openai";

export async function testOpenAI(credentials: Record<string, string>) {
  try {
    const apiKey = credentials.OPENAI_API_KEY;

    if (!apiKey) {
      return {
        success: false,
        error: "OPENAI_API_KEY is required",
      };
    }

    // Test the API key by listing models
    const client = new OpenAI({ apiKey });
    await client.models.list();

    return {
      success: true,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
