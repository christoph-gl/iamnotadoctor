import {
  generateObject,
  type ModelMessage,
  getOpenRouterModel,
  openRouterApiKey,
  openRouterDefaultModel,
} from "@/lib/llm-calls-env";
import { z } from "zod";
import { NextResponse } from "next/server";
import type { LiveCoachCommand } from "@/lib/live-coach-command";
import { makeLiveCoachCommandId } from "@/lib/live-coach-command";

export const dynamic = "force-dynamic";

const liveCoachApiKey = process.env.LIVE_COACH_API_KEY || openRouterApiKey;

const liveCoachModelName =
  process.env.LIVE_COACH_MODEL || openRouterDefaultModel;

const liveCoachModel = getOpenRouterModel(liveCoachModelName);

const liveCoachTimeoutMs = Math.min(
  30_000,
  Math.max(1_000, Number(process.env.LIVE_COACH_TIMEOUT_MS || 8_000))
);
const adaptiveCoachTimeoutMs = Math.min(
  30_000,
  Math.max(liveCoachTimeoutMs, Number(process.env.ADAPTIVE_COACH_TIMEOUT_MS || 15_000))
);
const adaptiveVoiceCoachTimeoutMs = Math.min(
  90_000,
  Math.max(
    adaptiveCoachTimeoutMs,
    Number(process.env.ADAPTIVE_VOICE_COACH_TIMEOUT_MS || 45_000)
  )
);

const RiderCueSchema = z
  .string()
  .min(1)
  .max(500)
  .describe("One rider-facing coaching comment, at most 2-3 short sentences. Never repeat a sentence or phrase.");

const ActionReasonSchema = z
  .string()
  .max(120)
  .optional()
  .describe("Brief internal reason for the chosen action.");

const LiveCoachActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("none"),
    reason: ActionReasonSchema.describe("Brief internal reason for taking no action."),
  }),
  z.object({
    action: z.literal("send_message"),
    text: RiderCueSchema.describe("Short rider-facing cue to display when action is send_message."),
    reason: ActionReasonSchema,
    speak: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("set_erg_watts"),
    watts: z
      .number()
      .describe("ERG target watts to apply immediately when action is set_erg_watts."),
    text: RiderCueSchema.optional().describe("Short rider-facing explanation to display when this changes trainer load."),
    reason: ActionReasonSchema,
  }),
  z.object({
    action: z.literal("set_resistance"),
    percent: z
      .number()
      .describe("Resistance percent from 0 to 100 when action is set_resistance."),
    text: RiderCueSchema.optional().describe("Short rider-facing explanation to display when this changes trainer load."),
    reason: ActionReasonSchema,
  }),
  z.object({
    action: z.literal("set_workout_plan"),
    leadSeconds: z
      .number()
      .optional()
      .describe("Delay before a workout-plan splice takes effect."),
    blocks: z
      .array(
        z.object({
          durationSeconds: z.number(),
          targetPower: z.number(),
        })
      )
      .min(1)
      .describe("Upcoming workout blocks that replace the current remaining workout plan."),
    text: RiderCueSchema.optional().describe("Short rider-facing explanation to display when this changes the adaptive plan."),
    reason: ActionReasonSchema,
  }),
  z.object({
    action: z.literal("update_adaptive_ride"),
    label: z.string().max(80).optional(),
    durationMinutes: z.number().optional(),
    feedbackIntervalMinutes: z.number().optional(),
    prompt: z
      .string()
      .max(500)
      .optional()
      .describe("Updated adaptive ride goal for future coach checks."),
    riderText: z
      .string()
      .max(500)
      .optional()
      .describe("Compact summary of the rider's latest adaptive instruction."),
    blocks: z
      .array(
        z.object({
          durationSeconds: z.number(),
          targetPower: z.number(),
        })
      )
      .optional()
      .describe("Optional immediate plan blocks to apply after updating the adaptive goal."),
    text: RiderCueSchema.optional().describe("Short rider-facing confirmation."),
    reason: ActionReasonSchema,
  }),
]);

const WorkoutPlanEditSchema = z.object({
  leadSeconds: z
    .number()
    .optional()
    .describe("Delay before the workout-plan splice takes effect."),
  blocks: z
    .array(
      z.object({
        durationSeconds: z.number(),
        targetPower: z.number(),
      })
    )
    .describe("Upcoming workout blocks that replace the current remaining workout plan."),
  reason: ActionReasonSchema.describe("Brief internal reason for the workout edit."),
});

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function toCommand(action: z.infer<typeof LiveCoachActionSchema>): LiveCoachCommand | null {
  const reason = action.reason?.trim() || "Live coach check";

  if (action.action === "send_message") {
    const text = action.text?.trim();
    if (!text) return null;
    return {
      id: makeLiveCoachCommandId(),
      type: "send_message",
      text,
      speak: action.speak,
      reason,
    };
  }

  if (action.action === "set_erg_watts" && typeof action.watts === "number") {
    return {
      id: makeLiveCoachCommandId(),
      type: "set_erg_watts",
      watts: clampNumber(action.watts, 50, 500),
      reason,
    };
  }

  if (action.action === "set_resistance" && typeof action.percent === "number") {
    return {
      id: makeLiveCoachCommandId(),
      type: "set_resistance",
      percent: clampNumber(action.percent, 0, 100),
      reason,
    };
  }

  if (action.action === "set_workout_plan" && action.blocks?.length) {
    const blocks = action.blocks.slice(0, 30).map((block) => ({
      durationSeconds: clampNumber(block.durationSeconds, 30, 600),
      targetPower: clampNumber(block.targetPower, 50, 500),
    }));

    return {
      id: makeLiveCoachCommandId(),
      type: "set_workout_plan",
      horizonSeconds: Math.min(
        30 * 60,
        Math.max(
          60,
          blocks.reduce((total, block) => total + block.durationSeconds, 0)
        )
      ),
      leadSeconds: clampNumber(action.leadSeconds ?? 5, 0, 60),
      blocks,
      reason,
    };
  }

  if (action.action === "update_adaptive_ride") {
    return null;
  }

  return null;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const record = getRecord(current);
    const message =
      current instanceof Error
        ? current.message
        : typeof record?.message === "string"
          ? record.message
          : "";
    const name =
      current instanceof Error
        ? current.name
        : typeof record?.name === "string"
          ? record.name
          : "";

    if (
      name === "TimeoutError" ||
      name === "AbortError" ||
      (typeof record?.code === "string" && record.code === "ABORT_ERR") ||
      (typeof record?.code === "number" && record.code === 20) ||
      message.toLowerCase().includes("timeout") ||
      message.toLowerCase().includes("aborted") ||
      message.toLowerCase().includes("aborted due to timeout")
    ) {
      return true;
    }

    current = record?.cause;
    if (!current) return false;
  }

  return false;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeRiderCue(value: unknown) {
  if (typeof value !== "string") return undefined;

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;

  const maxLength = 500;
  if (normalized.length <= maxLength) return normalized;

  const clipped = normalized.slice(0, maxLength);
  const sentenceEnd = Math.max(
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("!"),
    clipped.lastIndexOf("?")
  );

  return (sentenceEnd > 120 ? clipped.slice(0, sentenceEnd + 1) : clipped).trim();
}

function sanitizeLiveCoachAction(action: z.infer<typeof LiveCoachActionSchema>) {
  if ("text" in action) {
    const text = sanitizeRiderCue(action.text);
    if (text) return { ...action, text };
  }

  return action;
}

function enableSpeechForFixedTrack(
  action: z.infer<typeof LiveCoachActionSchema>,
  intent: "adaptive_plan" | "adaptive_instruction" | "periodic_ride_check" | "ride_start_summary" | "coach_check"
) {
  if (
    (intent === "ride_start_summary" || intent === "periodic_ride_check") &&
    action.action === "send_message"
  ) {
    return { ...action, speak: true };
  }

  return action;
}

function planEditToAction(plan: z.infer<typeof WorkoutPlanEditSchema>) {
  return {
    action: "set_workout_plan" as const,
    leadSeconds: plan.leadSeconds ?? 0,
    blocks: plan.blocks,
    reason: plan.reason || "Workout plan edited by live coach.",
  };
}

function compactNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function compactString(value: unknown, maxLength = 220) {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function compactConversationHistory(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-6)
    .map((turn) => {
      const record = getRecord(turn);
      if (!record) return null;
      const role = record.role === "assistant" ? "assistant" : "user";
      return {
        role,
        text: compactString(record.text, 180),
        command: compactString(record.command, 80),
        execution:
          record.execution === "applied" ||
          record.execution === "failed" ||
          record.execution === "none"
            ? record.execution
            : undefined,
      };
    })
    .filter(Boolean);
}

function compactWorkout(value: unknown) {
  const workout = getRecord(value);
  if (!workout) return null;
  const blocks = Array.isArray(workout.remainingBlocks)
    ? workout.remainingBlocks
        .slice(0, 30)
        .map((block) => {
          const record = getRecord(block);
          if (!record) return null;
          return {
            offsetSeconds: compactNumber(record.offsetSeconds),
            durationSeconds: compactNumber(record.durationSeconds),
            targetPower: compactNumber(record.targetPower),
            isCurrent: Boolean(record.isCurrent),
          };
        })
        .filter(Boolean)
    : [];

  return {
    workoutName: compactString(workout.workoutName, 120),
    isPlaying: Boolean(workout.isPlaying),
    elapsedSeconds: compactNumber(workout.elapsedSeconds),
    remainingSeconds: compactNumber(workout.remainingSeconds),
    currentTargetPower: compactNumber(workout.currentTargetPower),
    currentBlockDurationSeconds: compactNumber(workout.currentBlockDurationSeconds),
    currentBlockElapsedSeconds: compactNumber(workout.currentBlockElapsedSeconds),
    remainingBlocks: blocks,
    truncated: Boolean(workout.truncated),
  };
}

function compactSnapshot(value: unknown) {
  const snapshot = getRecord(value);
  if (!snapshot) return null;
  const latestSample = getRecord(snapshot.latestSample);
  const riderProfile = getRecord(snapshot.riderProfile);
  const fourDP = getRecord(riderProfile?.fourDP);
  const rolling = getRecord(snapshot.rolling);
  const adaptiveRideIntent = getRecord(snapshot.adaptiveRideIntent);
  const rollingSnapshots = Array.isArray(rolling?.snapshots)
    ? rolling.snapshots
        .slice(-20)
        .map((item) => {
          const record = getRecord(item);
          if (!record) return null;
          return {
            offsetSeconds: compactNumber(record.offsetSeconds),
            durationSeconds: compactNumber(record.durationSeconds),
            avgPowerW: compactNumber(record.avgPowerW),
            avgCadenceRpm: compactNumber(record.avgCadenceRpm),
            avgHeartRateBpm: compactNumber(record.avgHeartRateBpm),
            targetPower: compactNumber(record.targetPower),
            hrZone: compactString(record.hrZone, 80),
          };
        })
        .filter(Boolean)
    : [];
  const rideSoFar = getRecord(rolling?.rideSoFar);

  return {
    generatedAtIso: compactString(snapshot.generatedAtIso, 40),
    connectionState: compactString(snapshot.connectionState, 40),
    hrConnectionState: compactString(snapshot.hrConnectionState, 40),
    activeTrainerMode: snapshot.activeTrainerMode ?? null,
    adaptivePlanHorizonSeconds: compactNumber(snapshot.adaptivePlanHorizonSeconds),
    adaptiveRideIntent: adaptiveRideIntent
      ? {
          presetId: compactString(adaptiveRideIntent.presetId, 40),
          label: compactString(adaptiveRideIntent.label, 80),
          durationMinutes: compactNumber(adaptiveRideIntent.durationMinutes),
          feedbackIntervalMinutes: compactNumber(adaptiveRideIntent.feedbackIntervalMinutes),
          prompt: compactString(adaptiveRideIntent.prompt, 500),
          riderText: compactString(adaptiveRideIntent.riderText, 500),
        }
      : null,
    workoutName: compactString(snapshot.workoutName, 120),
    latestSample: latestSample
      ? {
          powerW: compactNumber(latestSample.powerW),
          cadenceRpm: compactNumber(latestSample.cadenceRpm),
          heartRateBpm: compactNumber(latestSample.heartRateBpm),
        }
      : null,
    rolling: rolling
      ? {
          sampleWindowSeconds: compactNumber(rolling.sampleWindowSeconds),
          rideSoFar: rideSoFar
            ? {
                elapsedSeconds: compactNumber(rideSoFar.elapsedSeconds),
                avgPowerW: compactNumber(rideSoFar.avgPowerW),
                avgCadenceRpm: compactNumber(rideSoFar.avgCadenceRpm),
                avgHeartRateBpm: compactNumber(rideSoFar.avgHeartRateBpm),
              }
            : null,
          snapshots: rollingSnapshots,
        }
      : null,
    currentHrZone: snapshot.currentHrZone ?? null,
    riderProfile: riderProfile
      ? {
          ftp: compactNumber(fourDP?.ftp ?? riderProfile.ftp),
          map: compactNumber(fourDP?.map ?? riderProfile.map),
          ac: compactNumber(fourDP?.ac ?? riderProfile.ac),
          nm: compactNumber(fourDP?.nm ?? riderProfile.nm),
          cTHR: compactNumber(riderProfile.cTHR),
          age: compactNumber(riderProfile.age),
          weightKg: compactNumber(riderProfile.weightKg),
          gender: compactString(riderProfile.gender, 40),
          hrZones: Array.isArray(riderProfile.hrZones)
            ? riderProfile.hrZones
                .map((zone) => {
                  const record = getRecord(zone);
                  if (!record) return null;
                  return {
                    id: compactString(record.id, 20),
                    name: compactString(record.name, 80),
                    percentageRange: compactString(record.percentageRange, 40),
                    minBpm: compactNumber(record.minBpm),
                    maxBpm: compactNumber(record.maxBpm),
                  };
                })
                .filter(Boolean)
            : [],
          memorySummary: compactString(riderProfile.memorySummary, 260),
        }
      : null,
    lastAgentEntry: snapshot.lastAgentEntry ?? null,
    remainingWorkout: compactWorkout(snapshot.remainingWorkout),
  };
}

function isLikelyWorkoutPlanEdit(riderText: string, snapshot: ReturnType<typeof compactSnapshot>) {
  if (!riderText.trim() || !snapshot?.remainingWorkout?.remainingBlocks.length) return false;
  const text = riderText.toLowerCase();
  const hasPlanScope =
    /\b(workout|ride|plan|track|remaining|rest|whole|all|next|more|again)\b/.test(text);
  const hasPlanVerb =
    /\b(reduce|decrease|lower|drop|cut|increase|raise|add|harder|easier|compress|shorten|extend|stretch|intensity|effort|power|watts?)\b/.test(
      text
    );
  return hasPlanScope && hasPlanVerb;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const body = (await request.json()) as Record<string, unknown>;

  const snapshot = body?.snapshot ?? null;
  const intent =
    body?.intent === "adaptive_plan" ||
    body?.intent === "adaptive_instruction" ||
    body?.intent === "periodic_ride_check" ||
    body?.intent === "ride_start_summary"
      ? body.intent
      : "coach_check";
  const riderText = typeof body?.riderText === "string" ? body.riderText : "";
  const audioBase64 =
    typeof body?.audioBase64 === "string" && body.audioBase64.length <= 8_000_000
      ? body.audioBase64
      : "";
  const audioFormat =
    typeof body?.audioFormat === "string" ? body.audioFormat.toLowerCase() : "";
  const conversationHistory = compactConversationHistory(body?.conversationHistory);
  const compactedSnapshot = compactSnapshot(snapshot);

  if (!liveCoachApiKey) {
    return NextResponse.json(
      {
        error:
          "No live coach API key configured. Set LIVE_COACH_API_KEY, OPENROUTER_API_KEY, or LLM_CALLS_API_KEY.",
      },
      { status: 503 }
    );
  }

  try {
    if (isLikelyWorkoutPlanEdit(riderText, compactedSnapshot)) {
      const result = await generateObject({
        model: liveCoachModel,
        apiKey: liveCoachApiKey,
        debugLabel: "live-coach/workout-plan-edit",
        abortSignal: AbortSignal.timeout(liveCoachTimeoutMs),
        maxRetries: 1,
        temperature: 0.2,
        maxOutputTokens: 1_800,
        schema: WorkoutPlanEditSchema,
        system: `You edit the remaining workout track for a smart trainer web app.
Return only the replacement remaining workout blocks.
Use the current remainingWorkout.remainingBlocks as the source plan.
Preserve block order unless the rider asks to compress, shorten, extend, or otherwise reshape duration.
For "reduce/decrease/lower/cut intensity/effort/power 10%" multiply each current remaining targetPower by 0.9 and keep durations.
For "reduce/decrease/lower/cut 10% more" apply another 0.9 multiplier to the current remaining blocks you receive now.
For "increase/raise/add/harder 10%" multiply by 1.1 and keep durations.
"More", "again", and "another" refer to the previous rider request in conversationHistory, but the math must be applied to the current remaining blocks.
For compression to N minutes, scale durations to N*60 seconds while preserving relative proportions; keep each block at least 30 seconds.
Use leadSeconds 0 for rider-requested edits.
At most 30 blocks. At most 30 minutes total. Keep whole watts.`,
        prompt: JSON.stringify({
          riderText,
          conversationHistory,
          remainingWorkout: compactedSnapshot?.remainingWorkout,
        }),
      });

      const action = planEditToAction(result.object);
      const command = toCommand(action);

      return NextResponse.json({
        model: liveCoachModelName,
        mode: "workout_plan_edit",
        durationMs: Date.now() - startedAt,
        action,
        command,
      });
    }

    const adaptiveInstructionContent: ModelMessage["content"] = [
      {
        type: "text",
        text: JSON.stringify({
          intent,
          executionContract: {
            returnedActionWillBeAppliedByBrowser: true,
            sendMessageDoesNotChangeTrainerLoad: true,
            setErgWattsChangesTrainerLoad: true,
            setResistanceChangesTrainerLoad: true,
            setWorkoutPlanChangesUpcomingWorkoutTargets: true,
          },
          conversationHistory,
          riderText: riderText || null,
          audioInstruction:
            intent === "adaptive_instruction" && audioBase64
              ? "Listen to the attached audio instruction and use it as the rider's latest request."
              : null,
          snapshot: compactedSnapshot,
        }),
      },
    ];

    if (intent === "adaptive_instruction" && audioBase64 && audioFormat) {
      adaptiveInstructionContent.push({
        type: "input_audio",
        input_audio: {
          data: audioBase64,
          format: audioFormat,
        },
      });
    }

    const userContent: ModelMessage[] = [
      {
        role: "user",
        content: adaptiveInstructionContent,
      },
    ];

    const result = await generateObject({
      model: liveCoachModel,
      apiKey: liveCoachApiKey,
      debugLabel: "live-coach",
      abortSignal: AbortSignal.timeout(
        intent === "adaptive_instruction"
          ? adaptiveVoiceCoachTimeoutMs
          : intent === "adaptive_plan"
            ? adaptiveCoachTimeoutMs
            : liveCoachTimeoutMs
      ),
      maxRetries: 1,
      temperature:
        intent === "periodic_ride_check"
          ? 0.55
          : intent === "adaptive_instruction"
            ? 0.4
            : 0.2,
      maxOutputTokens:
        intent === "adaptive_plan" || intent === "adaptive_instruction" ? 1_200 : 800,
      schema: LiveCoachActionSchema,
      system: `You are the low-latency live ride coach inside a smart trainer web app.

CRITICAL OUTPUT RULES — apply to EVERY response:
• The text field must be 1 to 3 short sentences. Never exceed 3 sentences.
• Never repeat a sentence, clause, or phrase — even rephrased. Say it once, then stop.
• Do not pad with encouragement filler. One brief motivational remark is fine; two is the absolute limit.
• Never end mid-sentence. End on a complete sentence.
• Do not mention APIs, agents, hooks, JSON, or implementation details.

Return one structured action only. This structured action is executed by the browser as the trainer-control tool call.
Available executable actions:
- set_erg_watts: immediately changes ERG target watts.
- set_resistance: immediately changes trainer resistance percent.
- set_workout_plan: replaces the upcoming workout track after leadSeconds.
- send_message: rider-facing text only; it does not change trainer load.
When action is send_message, include a non-empty text field with the exact rider-facing words to display.
Do not use send_message when the rider clearly asks to change watts or resistance and the snapshot says the trainer is connected.
For coach_check without a specific rider request, prefer one concise rider-facing comment unless telemetry clearly calls for ERG or resistance adjustment.
For ride_start_summary during a preplanned workout, return send_message only and set speak true. Give a coach-like opening in 2 to 3 short sentences: name the workout, summarize the target-power pattern, and give one thing to watch for early. Do not merely welcome the rider. Do not return set_workout_plan, set_erg_watts, or set_resistance for ride_start_summary.
For periodic_ride_check during a preplanned workout, return send_message only and set speak true. Use rider profile, heart-rate zones, rolling snapshots, ride-so-far averages, and remainingWorkout to give one coach-like comment about how the ride is going and what to focus on next. Rotate focus across power, cadence, heart-rate trend, workout progress, the next block, breathing, posture, fueling, and pacing. Do not repeat the topic or phrasing from conversationHistory. Do not return set_workout_plan, set_erg_watts, or set_resistance for periodic_ride_check.
When rider text is included, treat it as the latest chat message from the rider.
Use set_workout_plan for requests that mention the workout, track, plan, remaining work, rest of workout, next N minutes, compressing duration, stretching duration, or scaling effort over time.
snapshot.remainingWorkout.remainingBlocks is the source of truth for the remaining track. It starts at the rider's current point with offsetSeconds 0 and includes durationSeconds and targetPower for each block. Use currentBlockDurationSeconds and currentBlockElapsedSeconds to understand heart rate lag/drift and pacing.
For "decrease effort 10%", preserve durations and multiply each targetPower by 0.9, rounded to whole watts.
For "increase effort 10%", preserve durations and multiply each targetPower by 1.1.
For "compress to N minutes", preserve block order and relative proportions, scale total duration, keep every block at least 30 seconds.
set_workout_plan accepts at most 30 blocks and 30 minutes total. Use leadSeconds 0 to 5 for rider-requested changes.
If intent is adaptive_plan, use snapshot.adaptiveRideIntent as the ride goal. Return set_workout_plan with 5 to 10 blocks. Include exactly one text field (1-2 sentences) saying what changed or held steady and why. Keep reason under 120 characters.
If intent is adaptive_instruction, treat riderText (or the attached audio) as the rider's spoken instruction. Return update_adaptive_ride. Update durationMinutes, feedbackIntervalMinutes, prompt, or riderText as appropriate. Include 5 to 10 immediate blocks when the instruction should change the plan now. The text field must be a single sentence confirming what changed — nothing more.
If the rider reports pain, dizziness, chest pain, or wants to stop, lower intensity or stop escalating and send a safety-first cue.`,
      messages: userContent,
    });

    const action = enableSpeechForFixedTrack(
      sanitizeLiveCoachAction(result.object),
      intent
    );
    const command = toCommand(action);

    return NextResponse.json({
      model: liveCoachModelName,
      mode: "live_coach",
      durationMs: Date.now() - startedAt,
      action,
      command,
    });
  } catch (error) {
    const message = getErrorMessage(error);

    if (isTimeoutError(error)) {
      console.warn(
        `[live-coach] Timed out after ${Date.now() - startedAt}ms; no command applied.`
      );
      return NextResponse.json({
        model: liveCoachModelName,
        degraded: true,
        durationMs: Date.now() - startedAt,
        error: "Live coach timed out.",
        action: { action: "none", reason: "Live coach timed out; no local command fallback." },
        command: null,
      });
    }

    console.error("[live-coach] Failed to generate live coach action:", error);
    return NextResponse.json(
      {
        model: liveCoachModelName,
        degraded: true,
        durationMs: Date.now() - startedAt,
        error: message,
        action: { action: "none", reason: "Live coach failed; no local command fallback." },
        command: null,
      },
      { status: 200 }
    );
  }
}
