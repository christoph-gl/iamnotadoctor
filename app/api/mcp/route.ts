import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  deleteRideSessionById,
  getRideSessionById,
  getRiderProfileFromDb,
  listMonthlySummaries,
  listRideSessionSummaries,
  listRideSessions,
  upsertMonthlySummary,
  upsertRiderProfile,
} from "@/lib/db";
import { summarizeMonth } from "@/lib/monthly-summary";
import {
  mergeRiderProfilePatch,
  normalizeMemorySummary,
  validateRiderProfile,
} from "@/lib/rider-profile-validation";
import type { RideSessionSummary } from "@/lib/sessions";
import { getTrainerBridgeStatus, sendTrainerCommand, type TrainerBridgeCommandInput } from "@/lib/trainer-bridge";
import { normalizeCoachCues, resolveCoachCues } from "@/lib/coach-cues";
import { buildWorkout } from "@/lib/workout-builder";
import { readWorkoutLibrary, removeWorkout, safeWorkoutId, writeWorkout } from "@/lib/workout-store";
import { calculateWorkoutMetrics, WORKOUTS, type CoachCue, type Workout } from "@/lib/workouts";

export const dynamic = "force-dynamic";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function parseDate(value: string | undefined, endOfDay = false) {
  if (!value) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}` : value);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

const dateRange = {
  from: z.string().optional().describe("Inclusive start, ISO date (YYYY-MM-DD) or datetime"),
  to: z.string().optional().describe("Inclusive end, ISO date (YYYY-MM-DD) or datetime"),
};

function filterRides(
  rides: RideSessionSummary[],
  { from, to, workoutName }: { from?: string; to?: string; workoutName?: string }
) {
  const fromMs = parseDate(from);
  const toMs = parseDate(to, true);
  if (fromMs === undefined || toMs === undefined) return null;
  const needle = workoutName?.trim().toLowerCase();
  return rides.filter(
    (ride) =>
      (fromMs === null || ride.timestamp >= fromMs) &&
      (toMs === null || ride.timestamp <= toMs) &&
      (!needle || ride.workoutName.toLowerCase().includes(needle))
  );
}

function compactRide(ride: RideSessionSummary, includeLlmSummary: boolean) {
  return {
    id: ride.id,
    date: new Date(ride.timestamp).toISOString(),
    workoutName: ride.workoutName,
    durationMinutes: Math.round(ride.metrics.durationSeconds / 6) / 10,
    tss: Math.round(ride.metrics.tss),
    intensityFactor: Number(ride.metrics.iff.toFixed(3)),
    avgPower: ride.metrics.avgPower ?? null,
    avgHr: ride.metrics.avgHr ?? null,
    avgCadence: ride.metrics.avgCadence ?? null,
    sampleCount: ride.sampleCount,
    riderComments: ride.riderComments ?? null,
    llmSummaryStatus: ride.llmSummaryStatus ?? null,
    ...(includeLlmSummary
      ? { llmSummary: ride.llmSummary ?? null }
      : { headline: ride.llmSummary?.headline ?? null }),
  };
}

function periodKey(timestamp: number, groupBy: "week" | "month") {
  const date = new Date(timestamp);
  if (groupBy === "month") {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }
  // ISO week, e.g. 2026-W44
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function aggregate(rides: RideSessionSummary[]) {
  const weighted = (pick: (ride: RideSessionSummary) => number | undefined) => {
    let sum = 0;
    let seconds = 0;
    for (const ride of rides) {
      const value = pick(ride);
      if (value === undefined) continue;
      sum += value * ride.metrics.durationSeconds;
      seconds += ride.metrics.durationSeconds;
    }
    return seconds > 0 ? Math.round(sum / seconds) : null;
  };
  const totalSeconds = rides.reduce((acc, ride) => acc + ride.metrics.durationSeconds, 0);
  return {
    rides: rides.length,
    totalHours: Math.round((totalSeconds / 3600) * 10) / 10,
    totalTss: Math.round(rides.reduce((acc, ride) => acc + ride.metrics.tss, 0)),
    maxTss: Math.round(Math.max(0, ...rides.map((ride) => ride.metrics.tss))),
    avgIntensityFactor:
      rides.length > 0
        ? Number((rides.reduce((acc, ride) => acc + ride.metrics.iff, 0) / rides.length).toFixed(3))
        : null,
    avgPower: weighted((ride) => ride.metrics.avgPower),
    avgHr: weighted((ride) => ride.metrics.avgHr),
  };
}

function workoutSummary(workout: Workout, ftp: number) {
  const metrics = calculateWorkoutMetrics(workout, ftp);
  const cues = resolveCoachCues(workout, ftp);
  return {
    id: workout.id,
    name: workout.name,
    description: workout.description,
    durationMinutes: Math.round(workout.blocks.reduce((acc, block) => acc + block.durationSeconds, 0) / 6) / 10,
    blockCount: workout.blocks.length,
    trainerMode: workout.trainerMode ?? "erg",
    tss: Math.round(metrics.tss),
    intensityFactor: Number(metrics.iff.toFixed(3)),
    coachCueCount: cues.cues.length,
    coachCueSource: cues.source,
  };
}

function workoutDurationSeconds(blocks: Workout["blocks"]) {
  return blocks.reduce((total, block) => total + block.durationSeconds, 0);
}

/** Validated cues, or an error message when the client sent some but none survived. */
function cleanCues(cues: CoachCue[] | undefined, blocks: Workout["blocks"]) {
  if (!cues) return { cues: undefined };
  const cleaned = normalizeCoachCues(cues, workoutDurationSeconds(blocks));
  if (cues.length > 0 && cleaned.length === 0) {
    return { error: "No valid coach cues: each needs atSeconds and a focus or message." };
  }
  return { cues: cleaned.length > 0 ? cleaned : undefined };
}

const workoutBlocks = z
  .array(
    z.object({
      durationSeconds: z.number().int().min(5).max(4 * 3600),
      targetPower: z.number().int().min(0).max(1500).describe("ERG target in watts"),
    })
  )
  .min(1)
  .max(200);

const coachCues = z
  .array(
    z.object({
      atSeconds: z.number().int().min(0).describe("Seconds from the workout start"),
      focus: z
        .string()
        .max(300)
        .optional()
        .describe(
          'Brief for the in-app AI coach, which turns it into one spoken line with live telemetry, e.g. "Rep 3 of 6 starts in 15 s: 1 min at 335 W. One pacing cue."'
        ),
      message: z
        .string()
        .max(300)
        .optional()
        .describe("Fixed line spoken word for word without an AI call. For scripted protocols where timing must be exact."),
    })
  )
  .max(120)
  .describe(
    "Voice coach cue points: where the coach speaks. Place them where a coach would talk: about every 15-20 min on steady Z2/endurance, ~15 s before each effort, halfway through efforts of 4 min or more, at recoveries and the cooldown. Keep them 45 s or more apart. Omit to let the app derive cues from the blocks."
  );

// Sent to every MCP client on initialize; the full operating rules are in
// .agents/skills/iamnotadoctor-local-coach/dist/agent-skill.md.
const MCP_INSTRUCTIONS = `iamnotadoctor is a smart-trainer cycling app. The app tab in the rider's browser owns Bluetooth, the workout player and live coaching; these tools read ride history and the rider profile, manage workouts, and relay trainer commands to that tab.

Setting up a ride ("45 min endurance today"): call get_trainer_status, then build_workout with the rider's words. It saves the workout and loads it into the open tab (not started). Tell the rider the name, duration, TSS/IF and rationale. If loaded.ok is false, ask them to open the app and connect the trainer; the workout is in the library (load_workout with its id). Call start_workout only when the rider says they are ready.

Voice coach cue points: every workout can carry coachCues, the moments where the in-app voice coach speaks. The app uses them by default; the rider can switch to fixed intervals (every 1-15 min) instead. When you create a workout (save_workout, load_workout with blocks) set coachCues yourself, and use set_coach_cues to add or change them on an existing workout. Place them where a coach would talk, not on a timer: sparse on long steady Z2 rides (about every 15-20 min, plus start and cooldown), dense on intervals (about 15 s before each effort, halfway through efforts of 4 min or more, the start of a recovery, the last rep of a set). For sets of short reps (under about 1 min with short rests) announce the set, check in every few minutes and call the last rep, rather than every rep. Keep cues 45 s or more apart. A cue's focus briefs the AI coach on what this moment is about; message is a fixed line spoken word for word, for scripted protocols like fitness tests. Workouts without cues get cues derived from their blocks. build_workout adds cues itself.

Rules: control the trainer only when the rider asks, one request at a time, never in a loop. You cannot connect Bluetooth. Confirm with the rider before finish_ride, discard_ride, delete_ride and delete_workout, and before writing update_rider_memory. Use get_ride_stats for load questions instead of summing rides. No medical advice.`;

async function runTrainerCommand(command: TrainerBridgeCommandInput, successMessage: string) {
  const result = await sendTrainerCommand(command);
  if (!result.ok) return fail(result.message ?? "Command failed.");
  return json({ ok: true, message: successMessage, ...getTrainerBridgeStatus() });
}

const handler = createMcpHandler(
  (server) => {
    // --- Rider profile ---------------------------------------------------

    server.registerTool(
      "get_rider_profile",
      {
        title: "Get rider profile",
        description:
          "Current rider profile: 4DP power values (nm=P5, ac=P60, map=P300, ftp), cTHR, HR zones, age, weight, gender and memorySummary.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => json(getRiderProfileFromDb())
    );

    server.registerTool(
      "update_rider_profile",
      {
        title: "Update rider profile",
        description:
          "Merge field updates into the rider profile. Only send fields the rider explicitly provided or approved.",
        inputSchema: z.object({
          fourDP: z
            .object({
              nm: z.number().optional(),
              ac: z.number().optional(),
              map: z.number().optional(),
              ftp: z.number().optional(),
            })
            .optional(),
          cTHR: z.number().optional(),
          age: z.number().nullable().optional(),
          weightKg: z.number().nullable().optional(),
          gender: z.enum(["male", "female"]).nullable().optional(),
          memorySummary: z.string().optional(),
        }),
        annotations: { idempotentHint: true },
      },
      async (patch) => {
        const profile = mergeRiderProfilePatch(getRiderProfileFromDb(), patch);
        const error = validateRiderProfile(profile);
        if (error) return fail(error);
        upsertRiderProfile(profile);
        return json(getRiderProfileFromDb());
      }
    );

    server.registerTool(
      "update_rider_memory",
      {
        title: "Update rider memory",
        description:
          "Replace only the rider's memorySummary (qualitative fitness context, goals, constraints). Ask the rider before writing.",
        inputSchema: z.object({ memorySummary: z.string() }),
        annotations: { idempotentHint: true },
      },
      async ({ memorySummary }) => {
        const normalized = normalizeMemorySummary(memorySummary);
        if (normalized === null) return fail("memorySummary must be a string");
        const profile = { ...getRiderProfileFromDb(), memorySummary: normalized };
        const error = validateRiderProfile(profile);
        if (error) return fail(error);
        upsertRiderProfile(profile);
        return json({ memorySummary: profile.memorySummary });
      }
    );

    // --- Ride history ------------------------------------------------------

    server.registerTool(
      "list_rides",
      {
        title: "List past rides",
        description:
          "Saved rides, newest first, with metrics and the app's LLM ride evaluation headline. Filter by date range or workout name.",
        inputSchema: z.object({
          ...dateRange,
          workoutName: z.string().optional().describe("Case-insensitive substring match"),
          limit: z.number().int().min(1).max(200).default(20),
          offset: z.number().int().min(0).default(0),
          includeLlmSummary: z.boolean().default(false).describe("Include the full LLM ride evaluation"),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ limit, offset, includeLlmSummary, ...filters }) => {
        const rides = filterRides(listRideSessionSummaries(), filters);
        if (!rides) return fail("Invalid from/to date.");
        return json({
          total: rides.length,
          offset,
          rides: rides.slice(offset, offset + limit).map((ride) => compactRide(ride, includeLlmSummary)),
        });
      }
    );

    server.registerTool(
      "get_ride",
      {
        title: "Get ride details",
        description:
          "One saved ride with metrics, rider comments and full LLM evaluation. Optionally include telemetry samples, downsampled to keep the response small.",
        inputSchema: z.object({
          id: z.string(),
          includeSamples: z.boolean().default(false),
          sampleEverySeconds: z.number().int().min(1).max(600).default(10),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ id, includeSamples, sampleEverySeconds }) => {
        const ride = getRideSessionById(id);
        if (!ride) return fail(`Ride ${id} not found.`);
        const { samples, ...rest } = ride;
        return json({
          ...rest,
          date: new Date(ride.timestamp).toISOString(),
          sampleCount: samples.length,
          ...(includeSamples
            ? {
                sampleEverySeconds,
                samples: samples
                  .filter((_, index) => index % sampleEverySeconds === 0)
                  .map((sample) => ({
                    t: Math.round((sample.timestamp - samples[0].timestamp) / 1000),
                    powerW: sample.powerW ?? null,
                    cadenceRpm: sample.cadenceRpm ?? null,
                    heartRateBpm: sample.heartRateBpm ?? null,
                    speedKph: sample.speedKph ?? null,
                  })),
              }
            : {}),
        });
      }
    );

    server.registerTool(
      "get_ride_stats",
      {
        title: "Ride statistics",
        description:
          "Aggregate training load over saved rides: count, hours, TSS, average IF, duration-weighted average power and HR. Optionally grouped by ISO week or month.",
        inputSchema: z.object({
          ...dateRange,
          workoutName: z.string().optional(),
          groupBy: z.enum(["none", "week", "month"]).default("none"),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ groupBy, ...filters }) => {
        const rides = filterRides(listRideSessionSummaries(), filters);
        if (!rides) return fail("Invalid from/to date.");
        if (groupBy === "none") return json(aggregate(rides));
        const groups = new Map<string, RideSessionSummary[]>();
        for (const ride of rides) {
          const key = periodKey(ride.timestamp, groupBy);
          groups.set(key, [...(groups.get(key) ?? []), ride]);
        }
        return json({
          overall: aggregate(rides),
          periods: [...groups.entries()]
            .sort(([a], [b]) => b.localeCompare(a))
            .map(([period, periodRides]) => ({ period, ...aggregate(periodRides) })),
        });
      }
    );

    server.registerTool(
      "delete_ride",
      {
        title: "Delete ride",
        description: "Permanently delete a saved ride and its samples. Confirm with the rider first.",
        inputSchema: z.object({ id: z.string() }),
        annotations: { destructiveHint: true },
      },
      async ({ id }) => {
        if (!getRideSessionById(id)) return fail(`Ride ${id} not found.`);
        deleteRideSessionById(id);
        return json({ deleted: id });
      }
    );

    server.registerTool(
      "list_monthly_summaries",
      {
        title: "List monthly summaries",
        description: "Stored LLM monthly training rollups, newest first.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => json(listMonthlySummaries())
    );

    server.registerTool(
      "generate_monthly_summary",
      {
        title: "Generate monthly summary",
        description: "Run the in-app LLM over one month of rides and store the rollup. Requires an LLM API key.",
        inputSchema: z.object({
          month: z.string().regex(/^\d{4}-\d{2}$/).describe("YYYY-MM"),
        }),
      },
      async ({ month }) => {
        try {
          const result = await summarizeMonth(month, listRideSessions(), getRiderProfileFromDb());
          upsertMonthlySummary(month, result.summary, result.model);
          return json({ month, ...result });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      }
    );

    // --- Workout library -------------------------------------------------

    server.registerTool(
      "list_workouts",
      {
        title: "List workouts",
        description: "Workout library (built-in and saved) with duration and estimated TSS/IF for the current FTP.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => {
        const { ftp } = getRiderProfileFromDb().fourDP;
        return json((await readWorkoutLibrary()).map((workout) => workoutSummary(workout, ftp)));
      }
    );

    server.registerTool(
      "get_workout",
      {
        title: "Get workout",
        description:
          "Full workout definition including every ERG block and its voice coach cue points (coachCueSource 'auto' means they are derived from the blocks, not stored).",
        inputSchema: z.object({ id: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        const workout = (await readWorkoutLibrary()).find((candidate) => candidate.id === id);
        if (!workout) return fail(`Workout ${id} not found.`);
        const ftp = getRiderProfileFromDb().fourDP.ftp;
        const resolved = resolveCoachCues(workout, ftp);
        return json({ ...workout, ...workoutSummary(workout, ftp), coachCues: resolved.cues });
      }
    );

    server.registerTool(
      "build_workout",
      {
        title: "Build workout with AI",
        description:
          "Build an ERG workout from rider instructions using the rider profile and the last five rides, the same as the app's Build button. By default it is saved to the library and loaded into the open app tab, ready for the rider to press Play; without an open tab the rider finds it in the library. Requires an LLM API key.",
        inputSchema: z.object({
          instructions: z.string().min(1).describe('e.g. "45 min endurance, legs are tired"'),
          save: z.boolean().default(true).describe("Save the workout to the library"),
          load: z
            .boolean()
            .default(true)
            .describe("Load it into the app tab's player (not started) if a tab is open"),
        }),
      },
      async ({ instructions, save, load }) => {
        try {
          const result = await buildWorkout(instructions);
          if (save) await writeWorkout(result.workout);
          let loaded: { ok: boolean; message?: string } = { ok: false, message: "Not requested." };
          if (load) {
            const command = await sendTrainerCommand({ type: "load_workout", workout: result.workout });
            loaded = { ok: command.ok, message: command.ok ? `Loaded "${result.workout.name}".` : command.message };
          }
          return json({ ...result, saved: save, loaded });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      }
    );

    server.registerTool(
      "save_workout",
      {
        title: "Save workout",
        description:
          "Save a workout to the library (creates or overwrites by id). Include coachCues so the voice coach speaks at the moments that matter for this workout.",
        inputSchema: z.object({
          id: z.string().optional().describe("Letters, digits, - and _ only. Generated when omitted."),
          name: z.string().min(1).max(80),
          description: z.string().max(500).default(""),
          blocks: workoutBlocks,
          coachCues: coachCues.optional(),
        }),
        annotations: { idempotentHint: true },
      },
      async ({ id, name, description, blocks, coachCues: cues }) => {
        const workoutId = id ?? `mcp-${Date.now()}`;
        if (!safeWorkoutId(workoutId)) return fail("Invalid workout id.");
        const cleaned = cleanCues(cues, blocks);
        if (cleaned.error) return fail(cleaned.error);
        const workout: Workout = {
          id: workoutId,
          name,
          description,
          blocks,
          ...(cleaned.cues ? { coachCues: cleaned.cues } : {}),
        };
        await writeWorkout(workout);
        return json(workoutSummary(workout, getRiderProfileFromDb().fourDP.ftp));
      }
    );

    server.registerTool(
      "set_coach_cues",
      {
        title: "Set voice coach cue points",
        description:
          "Add, replace or clear the voice coach cue points of a saved workout. Read the workout with get_workout first to place cues on its blocks. Send an empty list to clear them (the app then derives cues from the blocks). Built-in workouts cannot be changed.",
        inputSchema: z.object({
          id: z.string(),
          coachCues,
        }),
        annotations: { idempotentHint: true },
      },
      async ({ id, coachCues: cues }) => {
        if (!safeWorkoutId(id)) return fail("Invalid workout id.");
        if (WORKOUTS.some((builtIn) => builtIn.id === id)) {
          return fail("Built-in workouts have their cue points in the app code and cannot be changed here.");
        }
        const workout = (await readWorkoutLibrary()).find((candidate) => candidate.id === id);
        if (!workout) return fail(`Workout ${id} not found.`);
        const cleaned = cleanCues(cues, workout.blocks);
        if (cleaned.error) return fail(cleaned.error);
        const updated: Workout = { ...workout, coachCues: cleaned.cues };
        if (!updated.coachCues) delete updated.coachCues;
        await writeWorkout(updated);
        const ftp = getRiderProfileFromDb().fourDP.ftp;
        return json({ ...workoutSummary(updated, ftp), coachCues: resolveCoachCues(updated, ftp).cues });
      }
    );

    server.registerTool(
      "delete_workout",
      {
        title: "Delete workout",
        description: "Remove a workout from the library. Confirm with the rider first.",
        inputSchema: z.object({ id: z.string() }),
        annotations: { destructiveHint: true },
      },
      async ({ id }) => {
        if (!safeWorkoutId(id)) return fail("Invalid workout id.");
        await removeWorkout(id);
        return json({ deleted: id });
      }
    );

    // --- Live trainer (relayed through the open app tab) -------------------

    server.registerTool(
      "get_trainer_status",
      {
        title: "Trainer status",
        description:
          "Live state from the open app tab: trainer/HRM connection, current power, cadence, heart rate, trainer mode, and the loaded workout's progress.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => json(getTrainerBridgeStatus())
    );

    server.registerTool(
      "set_erg_power",
      {
        title: "Set ERG power",
        description:
          "Switch the trainer to ERG mode at a target wattage. While a workout plays, this overrides the target until the next workout step.",
        inputSchema: z.object({ watts: z.number().int().min(50).max(1000) }),
      },
      async ({ watts }) => runTrainerCommand({ type: "set_erg_power", watts }, `ERG target set to ${watts} W.`)
    );

    server.registerTool(
      "set_resistance",
      {
        title: "Set resistance",
        description: "Switch the trainer to resistance mode at a level from 0 to 100 percent.",
        inputSchema: z.object({ level: z.number().int().min(0).max(100) }),
      },
      async ({ level }) => runTrainerCommand({ type: "set_resistance", level }, `Resistance set to ${level}%.`)
    );

    server.registerTool(
      "load_workout",
      {
        title: "Load workout",
        description:
          "Load a workout into the app's player, either from the library by id or from ad-hoc ERG blocks. Does not start it.",
        inputSchema: z.object({
          id: z.string().optional().describe("Library workout id"),
          name: z.string().max(80).optional().describe("Name for ad-hoc blocks"),
          blocks: workoutBlocks.optional().describe("Ad-hoc ERG blocks instead of a library id"),
          coachCues: coachCues.optional().describe("Cue points for ad-hoc blocks"),
        }),
      },
      async ({ id, name, blocks, coachCues: cues }) => {
        let workout: Workout | undefined;
        if (id) {
          workout = (await readWorkoutLibrary()).find((candidate) => candidate.id === id);
          if (!workout) return fail(`Workout ${id} not found.`);
        } else if (blocks) {
          const cleaned = cleanCues(cues, blocks);
          if (cleaned.error) return fail(cleaned.error);
          workout = {
            id: `mcp-adhoc-${Date.now()}`,
            name: name ?? "MCP Workout",
            description: "",
            blocks,
            ...(cleaned.cues ? { coachCues: cleaned.cues } : {}),
          };
        } else {
          return fail("Pass either id or blocks.");
        }
        return runTrainerCommand({ type: "load_workout", workout }, `Loaded "${workout.name}".`);
      }
    );

    server.registerTool(
      "start_workout",
      {
        title: "Start or resume workout",
        description: "Press Play on the loaded workout. The trainer must be connected in the app tab.",
        inputSchema: z.object({}),
      },
      async () => runTrainerCommand({ type: "play_workout" }, "Workout playing.")
    );

    server.registerTool(
      "pause_workout",
      {
        title: "Pause workout",
        description: "Pause the workout timeline. The trainer keeps its last target.",
        inputSchema: z.object({}),
      },
      async () => runTrainerCommand({ type: "pause_workout" }, "Workout paused.")
    );

    server.registerTool(
      "seek_workout",
      {
        title: "Seek workout",
        description: "Jump the workout timeline to a position in seconds from the start.",
        inputSchema: z.object({ seconds: z.number().int().min(0) }),
      },
      async ({ seconds }) => runTrainerCommand({ type: "seek_workout", seconds }, `Moved to ${seconds}s.`)
    );

    server.registerTool(
      "finish_ride",
      {
        title: "Finish and save ride",
        description:
          "End the current ride and save it (the app adds its LLM ride evaluation). Optional rider comments are stored with it.",
        inputSchema: z.object({ comments: z.string().max(2000).optional() }),
      },
      async ({ comments }) =>
        runTrainerCommand({ type: "finish_ride", comments }, "Ride finished; the app is saving it now.")
    );

    server.registerTool(
      "discard_ride",
      {
        title: "Discard ride",
        description: "Reset the workout timer without saving the ride. Confirm with the rider first.",
        inputSchema: z.object({}),
        annotations: { destructiveHint: true },
      },
      async () => runTrainerCommand({ type: "discard_ride" }, "Ride discarded.")
    );
  },
  {
    serverInfo: { name: "iamnotadoctor", version: "0.6.0" },
    instructions: MCP_INSTRUCTIONS,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
