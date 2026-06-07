import { NextResponse } from "next/server";
import { getOpenAIClient, openRouterApiKey as sharedOpenRouterApiKey } from "@/lib/llm-calls-env";

export const dynamic = "force-dynamic";

const ttsApiKey =
  process.env.OPENROUTER_API_KEY ||
  process.env.GROK_TTS_API_KEY ||
  sharedOpenRouterApiKey;

const ttsModel = process.env.GROK_TTS_MODEL || "x-ai/grok-voice-tts-1.0";

function defaultVoiceForModel(model: string) {
  if (model.startsWith("x-ai/grok-voice-tts")) return "sal";
  if (model.startsWith("openai/")) return "alloy";
  return "alloy";
}

function resolveVoiceForModel(model: string, voice: string | undefined) {
  if (!voice) return defaultVoiceForModel(model);
  if (!model.startsWith("x-ai/grok-voice-tts")) return voice;

  const grokVoices = new Set(["eve", "ara", "rex", "sal", "leo"]);
  return grokVoices.has(voice) ? voice : "sal";
}

const ttsVoice = resolveVoiceForModel(ttsModel, process.env.GROK_TTS_VOICE_ID);

const ttsTimeoutMs = Math.min(
  30_000,
  Math.max(2_000, Number(process.env.GROK_TTS_TIMEOUT_MS || 20_000))
);

function sanitizeForSpeech(text: string) {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/\b(\d+(?:\.\d+)?)\s*W\b/g, "$1 watt")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

export async function POST(request: Request) {
  if (!ttsApiKey) {
    return NextResponse.json(
      { error: "No OpenRouter API key configured. Set OPENROUTER_API_KEY." },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = sanitizeForSpeech(typeof body?.text === "string" ? body.text : "");

  if (!text) {
    return NextResponse.json({ error: "Text is required." }, { status: 400 });
  }

  try {
    const response = await getOpenAIClient(ttsApiKey).audio.speech.create({
      model: ttsModel,
      input: text,
      voice: ttsVoice,
      response_format: "mp3",
    }, {
      signal: AbortSignal.timeout(ttsTimeoutMs),
    });
    const audio = await response.arrayBuffer();

    return new Response(audio, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[coach-tts] Failed to generate speech:", error);
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: message,
        model: ttsModel,
        voice: ttsVoice,
        providerStatus: status,
      },
      { status: 502 }
    );
  }
}
