import { generateObject, getOpenRouterModel, openRouterApiKey, openRouterDefaultModel } from "@/lib/llm-calls-env";
import { z } from "zod";
import { getRiderProfileFromDb, listRideSessions } from "@/lib/db";
import { deriveCoachCues, normalizeCoachCues } from "@/lib/coach-cues";
import { calculateWorkoutMetrics, type Workout, type WorkoutBlock } from "@/lib/workouts";

const workoutBuilderApiKey =
  process.env.WORKOUT_BUILDER_API_KEY ||
  process.env.RIDE_SUMMARY_API_KEY ||
  process.env.LIVE_COACH_API_KEY ||
  openRouterApiKey;

const workoutBuilderModelName =
  process.env.WORKOUT_BUILDER_MODEL ||
  process.env.RIDE_SUMMARY_MODEL ||
  process.env.LIVE_COACH_MODEL ||
  openRouterDefaultModel;

const workoutBuilderModel = getOpenRouterModel(workoutBuilderModelName);

const WorkoutBuilderSchema = z.object({
  name: z.string().max(80),
  description: z.string().max(500),
  rationale: z.string().max(900),
  blocks: z
    .array(
      z.object({
        durationSeconds: z.number(),
        targetPower: z.number(),
        purpose: z.string().max(120),
      })
    )
    .min(1)
    // Checked after parsing, not sent as maxItems: Gemini rejects that keyword with a 400.
    .refine((blocks) => blocks.length <= 80, "Use at most 80 blocks"),
  coachCues: z.array(
    z.object({
      atSeconds: z.number(),
      focus: z.string().max(300),
    })
  ),
});

function compactSession(session: ReturnType<typeof listRideSessions>[number]) {
  return {
    id: session.id,
    dateIso: new Date(session.timestamp).toISOString(),
    workoutName: session.workoutName,
    metrics: {
      durationMinutes: Math.round((session.metrics.durationSeconds || 0) / 60),
      tss: Math.round(session.metrics.tss || 0),
      iff: Number((session.metrics.iff || 0).toFixed(3)),
      avgPower: session.metrics.avgPower ?? null,
      avgHr: session.metrics.avgHr ?? null,
      avgCadence: session.metrics.avgCadence ?? null,
    },
    riderComments: session.riderComments || null,
    llmEvaluation: session.llmSummary
      ? {
          headline: session.llmSummary.headline,
          summary: session.llmSummary.summary,
          keyObservations: session.llmSummary.keyObservations,
          heartRateZoneAssessment: session.llmSummary.heartRateZoneAssessment,
          trainingLoadAssessment: session.llmSummary.trainingLoadAssessment,
          suggestedNextFocus: session.llmSummary.suggestedNextFocus,
          memoryCandidate: session.llmSummary.memoryCandidate,
        }
      : null,
  };
}

function clampBlock(block: z.infer<typeof WorkoutBuilderSchema>["blocks"][number], map: number): WorkoutBlock {
  return {
    durationSeconds: Math.min(
      30 * 60,
      Math.max(15, Math.round(block.durationSeconds || 0))
    ),
    targetPower: Math.min(
      Math.max(120, Math.round(map * 1.25)),
      Math.max(40, Math.round(block.targetPower || 0))
    ),
  };
}

function mergeAdjacentBlocks(blocks: WorkoutBlock[]) {
  const merged: WorkoutBlock[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (previous && previous.targetPower === block.targetPower) {
      previous.durationSeconds += block.durationSeconds;
    } else {
      merged.push({ ...block });
    }
  }
  return merged;
}

function localDateTimeParts() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    local: new Intl.DateTimeFormat("en-GB", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: "Europe/Berlin",
    }).format(now),
    timeZone: "Europe/Berlin",
  };
}

export async function buildWorkout(instructions: string) {
  if (!workoutBuilderApiKey) {
    throw new Error(
      "WORKOUT_BUILDER_API_KEY, OPENROUTER_API_KEY, or LLM_CALLS_API_KEY is not configured"
    );
  }

  const riderProfile = getRiderProfileFromDb();
  const recentSessions = listRideSessions().slice(0, 5).map(compactSession);
  const now = localDateTimeParts();
  const payload = {
    now,
    riderRequest: instructions,
    riderProfile: {
      fourDP: riderProfile.fourDP,
      cTHR: riderProfile.cTHR,
      age: riderProfile.age,
      weightKg: riderProfile.weightKg,
      gender: riderProfile.gender,
      hrZones: riderProfile.hrZones.map((zone) => ({
        name: zone.name,
        rangeBpm: `${zone.minBpm}-${zone.maxBpm}`,
        percentageRange: zone.percentageRange,
      })),
      memorySummary: riderProfile.memorySummary || null,
    },
    recentRides: recentSessions,
  };

  const result = await generateObject({
    model: workoutBuilderModel,
    apiKey: workoutBuilderApiKey,
    debugLabel: "workout-builder",
    messages: [
      {
        role: "user",
        content: `You are a cycling workout builder for a smart trainer ERG-mode app.

Task:
- Create one workout for today from the rider's request.
- Use the rider's power profile to choose safe target watts.
- Use the last 5 ride evaluations, dates, and current date/time to avoid stacking inappropriate intensity.
- Prefer endurance/recovery when the request says endurance, easy, aerobic, or when recent ride summaries show high HR strain.
- Output ERG blocks only: durationSeconds and targetPower.
- Also output coachCues: the moments the in-app voice coach speaks, as atSeconds from the workout start plus a short focus that briefs the coach (what is happening, what to emphasize).

Rules:
- Respect requested duration if provided. If vague, choose 30-60 minutes.
- Include warmup and cooldown unless the ride is very short.
- For endurance rides, keep most work around 55-75% threshold power and avoid surprise intervals.
- Use P300/P60/P5-style efforts sparingly and only when requested or sensible from recent context.
- Do not prescribe medical advice.
- The final workout should be practical to ride indoors today.

Coach cue rules:
- Always one cue at 0 (ride start).
- Long steady/Z2 riding: few cues, about every 15-20 minutes (heart-rate drift, cadence, fueling, posture).
- Intervals: about 15 s before each effort (name it, e.g. "Rep 3 of 6 starts in 15 s: 1 min at 335 W"), halfway through efforts of 4 min or more, at the start of longer recoveries and of the cooldown.
- Sets of short reps (under about 1 min with short rests): announce the set, check in every few minutes and call the last rep instead of cueing every rep.
- Keep cues at least 45 s apart.

Planning payload:
${JSON.stringify(payload, null, 2)}`,
      },
    ],
    schema: WorkoutBuilderSchema,
  });

  const blocks = mergeAdjacentBlocks(
    result.object.blocks.map((block) => clampBlock(block, riderProfile.fourDP.map))
  );
  const durationSeconds = blocks.reduce((total, block) => total + block.durationSeconds, 0);
  const modelCues = normalizeCoachCues(result.object.coachCues, durationSeconds);
  const workout: Workout = {
    id: `ai-built-${Date.now()}`,
    name: result.object.name,
    description: result.object.description,
    blocks,
    coachCues: modelCues.length > 0 ? modelCues : deriveCoachCues(blocks, riderProfile.fourDP.ftp),
  };
  const metrics = calculateWorkoutMetrics(workout, riderProfile.fourDP.ftp);

  return {
    workout,
    rationale: result.object.rationale,
    metrics,
    model: workoutBuilderModelName,
    context: {
      now,
      recentRideCount: recentSessions.length,
    },
  };
}
