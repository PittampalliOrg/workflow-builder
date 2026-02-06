import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import { OpenAIIcon } from "./icon";

const openaiPlugin: IntegrationPlugin = {
  type: "openai",
  label: "OpenAI",
  description: "Generate text and images using OpenAI models",

  icon: OpenAIIcon,

  formFields: [
    {
      id: "openaiApiKey",
      label: "API Key",
      type: "password",
      placeholder: "sk-...",
      configKey: "apiKey",
      envVar: "OPENAI_API_KEY",
      helpText: "Get your API key from ",
      helpLink: {
        text: "platform.openai.com",
        url: "https://platform.openai.com/api-keys",
      },
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testOpenAI } = await import("./test");
      return testOpenAI;
    },
  },

  dependencies: {
    "@ai-sdk/openai": "^1.0.0",
    ai: "^5.0.86",
    openai: "^6.8.0",
    zod: "^4.1.12",
  },

  actions: [
    {
      slug: "generate-text",
      label: "Generate Text",
      description: "Generate text using OpenAI models",
      category: "OpenAI",
      stepFunction: "generateTextStep",
      stepImportPath: "generate-text",
      configFields: [
        {
          key: "aiFormat",
          label: "Output Format",
          type: "select",
          defaultValue: "text",
          options: [
            { value: "text", label: "Text" },
            { value: "object", label: "Object" },
          ],
        },
        {
          key: "aiModel",
          label: "Model",
          type: "select",
          defaultValue: "gpt-4o",
          options: [
            { value: "gpt-4o", label: "GPT-4o" },
            { value: "gpt-4o-mini", label: "GPT-4o Mini" },
            { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
            { value: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
            { value: "o1", label: "o1" },
            { value: "o1-mini", label: "o1 Mini" },
          ],
        },
        {
          key: "aiPrompt",
          label: "Prompt",
          type: "template-textarea",
          placeholder:
            "Enter your prompt here. Use {{NodeName.field}} to reference previous outputs.",
          rows: 4,
          example: "Summarize the following text: {{Scrape.markdown}}",
          required: true,
        },
        {
          key: "aiSchema",
          label: "Schema",
          type: "schema-builder",
          showWhen: { field: "aiFormat", equals: "object" },
        },
      ],
    },
    {
      slug: "generate-image",
      label: "Generate Image",
      description: "Generate images using DALL-E",
      category: "OpenAI",
      stepFunction: "generateImageStep",
      stepImportPath: "generate-image",
      outputFields: [{ field: "base64", description: "Base64-encoded image data" }],
      outputConfig: { type: "image", field: "base64" },
      configFields: [
        {
          key: "imageModel",
          label: "Model",
          type: "select",
          defaultValue: "dall-e-3",
          options: [
            { value: "dall-e-3", label: "DALL-E 3" },
            { value: "dall-e-2", label: "DALL-E 2" },
          ],
        },
        {
          key: "imagePrompt",
          label: "Prompt",
          type: "template-textarea",
          placeholder:
            "Describe the image you want to generate. Use {{NodeName.field}} to reference previous outputs.",
          rows: 4,
          example: "A serene mountain landscape at sunset",
          required: true,
        },
        {
          key: "imageSize",
          label: "Size",
          type: "select",
          defaultValue: "1024x1024",
          options: [
            { value: "1024x1024", label: "1024x1024" },
            { value: "1792x1024", label: "1792x1024 (wide)" },
            { value: "1024x1792", label: "1024x1792 (tall)" },
          ],
        },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(openaiPlugin);

export default openaiPlugin;
