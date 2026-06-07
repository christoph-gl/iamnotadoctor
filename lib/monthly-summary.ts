import { generateObject, getOpenRouterModel, openRouterApiKey, openRouterDefaultModel } from "./llm-calls-env";
import { z } from "zod";
import type { RiderProfile } from "./profile";
import type { RideSession } from "./sessions";

export type MonthlyTrainingSummary = {
  headline: string;
  summary: string;
  trainingPattern: string;
  heartRateZonePattern: string;
  progressSignals: string[];
  concernsOrUnknowns: string[];
  nextMonthFocus: string[];
  riderMemoryUpdate: string;
};

const monthlySummaryApiKey =
  process.env.MONTHLY_SUMMARY_API_KEY ||
  process.env.RIDE_SUMMARY_API_KEY ||
  openRouterApiKey;

const monthlySummaryModelName =
  process.env.MONTHLY_SUMMARY_MODEL ||
  process.env.RIDE_SUMMARY_MODEL ||
  openRouterDefaultModel;

const monthlySummaryModel = getOpenRouterModel(monthlySummaryModelName);

const MonthlySummarySchema = z.object({
  headline: z.string().max(100),
  summary: z.string().max(1000),
  trainingPattern: z.string().max(700),
  heartRateZonePattern: z.string().max(700),
  progressSignals: z.array(z.string().max(180)).min(1).max(6),
  concernsOrUnknowns: z.array(z.string().max(180)).min(1).max(6),
  nextMonthFocus: z.array(z.string().max(180)).min(1).max(6),
  riderMemoryUpdate: z.string().max(700),
});

function getMonthBounds(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error("month must use YYYY-MM");

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const start = new Date(year, monthIndex, 1).getTime();
  const end = new Date(year, monthIndex + 1, 1).getTime();
  return { start, end };
}

export function sessionsForMonth(sessions: RideSession[], month: string) {
  const { start, end } = getMonthBounds(month);
  return sessions.filter((session) => session.timestamp >= start && session.timestamp < end);
}

function round(value: number, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildMonthlyPayload(
  month: string,
  sessions: RideSession[],
  riderProfile: RiderProfile
) {
  const totals = sessions.reduce(
    (acc, session) => ({
      durationSeconds: acc.durationSeconds + (session.metrics.durationSeconds || 0),
      tss: acc.tss + (session.metrics.tss || 0),
      powerWeightedSeconds:
        acc.powerWeightedSeconds +
        (session.metrics.avgPower || 0) * (session.metrics.durationSeconds || 0),
      hrWeightedSeconds:
        acc.hrWeightedSeconds +
        (session.metrics.avgHr || 0) * (session.metrics.durationSeconds || 0),
    }),
    { durationSeconds: 0, tss: 0, powerWeightedSeconds: 0, hrWeightedSeconds: 0 }
  );

  return {
    month,
    riderProfile: {
      ftp: riderProfile.fourDP.ftp,
      map: riderProfile.fourDP.map,
      cTHR: riderProfile.cTHR,
      hrZones: riderProfile.hrZones.map((zone) => ({
        name: zone.name,
        rangeBpm: `${zone.minBpm}-${zone.maxBpm}`,
        percentageRange: zone.percentageRange,
      })),
      existingMemorySummary: riderProfile.memorySummary || null,
    },
    totals: {
      rideCount: sessions.length,
      durationMinutes: round(totals.durationSeconds / 60, 1),
      tss: round(totals.tss, 1),
      avgPowerWeighted: totals.durationSeconds
        ? round(totals.powerWeightedSeconds / totals.durationSeconds, 1)
        : null,
      avgHeartRateWeighted: totals.durationSeconds
        ? round(totals.hrWeightedSeconds / totals.durationSeconds, 1)
        : null,
    },
    rides: sessions.map((session) => ({
      id: session.id,
      workoutName: session.workoutName,
      dateIso: new Date(session.timestamp).toISOString(),
      metrics: {
        durationSeconds: session.metrics.durationSeconds,
        tss: round(session.metrics.tss || 0, 1),
        iff: round(session.metrics.iff || 0, 3),
        avgPower: session.metrics.avgPower ?? null,
        avgHr: session.metrics.avgHr ?? null,
        avgCadence: session.metrics.avgCadence ?? null,
      },
      riderComments: session.riderComments || null,
      rideSummary: session.llmSummary
        ? {
            headline: session.llmSummary.headline,
            keyObservations: session.llmSummary.keyObservations,
            heartRateZoneAssessment: session.llmSummary.heartRateZoneAssessment,
            suggestedNextFocus: session.llmSummary.suggestedNextFocus,
            memoryCandidate: session.llmSummary.memoryCandidate,
          }
        : null,
    })),
  };
}

export async function summarizeMonth(
  month: string,
  sessions: RideSession[],
  riderProfile: RiderProfile
): Promise<{ summary: MonthlyTrainingSummary; model: string }> {
  const monthSessions = sessionsForMonth(sessions, month);
  if (monthSessions.length === 0) {
    throw new Error(`No rides found for ${month}`);
  }
  if (!monthlySummaryApiKey) {
    throw new Error(
      "MONTHLY_SUMMARY_API_KEY, RIDE_SUMMARY_API_KEY, OPENROUTER_API_KEY, or LLM_CALLS_API_KEY is not configured"
    );
  }



  const payload = buildMonthlyPayload(month, monthSessions, riderProfile);
  const result = await generateObject({
    model: monthlySummaryModel,
    apiKey: monthlySummaryApiKey,
    messages: [
      {
        role: "user",
        content: `You are the monthly training analyst for a local indoor cycling app.

Task:
- Summarize the month from saved ride summaries and ride metrics.
- Explain training pattern, heart-rate-zone pattern, progress signals, and unknowns.
- Suggest practical next-month tracking and training focus.
- Produce one rider-memory update that compresses durable learning from the month.

Rules:
- Do not infer fitness changes from too little data; state uncertainty.
- Prefer ride summaries and rider comments over raw averages when explaining why.
- Keep the result concise and useful for future coaching prompts.

Monthly payload:
${JSON.stringify(payload, null, 2)}`,
      },
    ],
    schema: MonthlySummarySchema,
  });

  return { summary: result.object, model: monthlySummaryModelName };
}
