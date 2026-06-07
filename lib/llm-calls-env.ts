import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";

/** Shared OpenRouter credentials. */
export const openRouterApiKey =
  process.env.OPENROUTER_API_KEY ||
  process.env.LLM_CALLS_API_KEY;

export const openRouterDefaultModel =
  process.env.LLM_CALLS_MODEL ||
  "google/gemini-2.5-flash";

export type ModelMessage = {
  role: "user" | "assistant" | "system";
  content: string | OpenRouterContentPart[];
};

type OpenRouterContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string | Buffer | ArrayBuffer }
  | Record<string, unknown>;

type OpenRouterModelOptions = {
  apiKey?: string;
  model: string;
  messages?: ModelMessage[];
  prompt?: string;
  schema: z.ZodTypeAny;
  system?: string;
  temperature?: number;
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  maxRetries?: number;
};

export function getOpenAIClient(apiKey?: string) {
  const resolvedKey =
    apiKey ||
    process.env.OPENROUTER_API_KEY ||
    process.env.LLM_CALLS_API_KEY ||
    openRouterApiKey;
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: resolvedKey || "",
    defaultHeaders: {
      "HTTP-Referer": "https://iamnotadoctor.localhost",
      "X-OpenRouter-Title": "iamnotadoctor",
    },
  });
}

export function getOpenRouterModel(modelName?: string): string {
  return (
    modelName ||
    process.env.LLM_CALLS_MODEL ||
    openRouterDefaultModel
  );
}

function toOpenAIContentPart(part: OpenRouterContentPart) {
  if (part.type !== "image") return part;

  const img = part.image;
  let base64 = "";
  if (Buffer.isBuffer(img)) {
    base64 = img.toString("base64");
  } else if (img instanceof ArrayBuffer) {
    base64 = Buffer.from(img).toString("base64");
  } else if (typeof img === "string") {
    base64 = img;
  }

  return {
    type: "image_url",
    image_url: {
      url: base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`,
    },
  };
}

function formatMessages(messages: ModelMessage[], system?: string): ChatCompletionMessageParam[] {
  const formattedMessages: ChatCompletionMessageParam[] = [];
  if (system) {
    formattedMessages.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    formattedMessages.push({
      role: msg.role,
      content: Array.isArray(msg.content) ? msg.content.map(toOpenAIContentPart) : msg.content,
    } as ChatCompletionMessageParam);
  }

  return formattedMessages;
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function schemaInstruction(schema: z.ZodTypeAny) {
  const jsonSchema = z.toJSONSchema(schema);
  return `Return only valid JSON matching this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
}

export async function generateObject<T extends z.ZodTypeAny>({
  apiKey,
  model,
  messages,
  prompt,
  schema,
  system,
  temperature,
  abortSignal,
  maxOutputTokens,
  maxRetries = 1,
}: OpenRouterModelOptions & { schema: T }): Promise<{ object: z.infer<T> }> {
  const client = getOpenAIClient(apiKey);
  const resolvedMessages = messages || (prompt ? [{ role: "user" as const, content: prompt }] : []);
  const formattedMessages = formatMessages(resolvedMessages, system);
  const jsonSchema = z.toJSONSchema(schema);
  const attempts = Math.max(1, maxRetries + 1);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const messagesForAttempt =
      attempt === 0
        ? formattedMessages
        : [
            ...formattedMessages,
            {
              role: "user",
              content: `The previous response failed validation: ${
                lastError instanceof Error ? lastError.message : String(lastError)
              }\n\n${schemaInstruction(schema)}`,
            } as ChatCompletionMessageParam,
          ];

    try {
      const response = await client.chat.completions.create(
        {
          model,
          messages: messagesForAttempt,
          ...(typeof temperature === "number" ? { temperature } : {}),
          ...(typeof maxOutputTokens === "number" ? { max_tokens: maxOutputTokens } : {}),
          provider: {
            require_parameters: true,
          },
          plugins: [{ id: "response-healing" }],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "structured_response",
              strict: true,
              schema: jsonSchema,
            },
          },
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        {
          signal: abortSignal,
        }
      );

      const text = response.choices[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("Empty structured response from model");
      }

      return { object: schema.parse(parseJsonObject(text)) };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
