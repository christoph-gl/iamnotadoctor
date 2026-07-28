import { z } from "zod";
import type { BikeSample } from "./trainer-client";
import type { RiderProfile } from "./profile";
import type { RideLlmSummary, RideSession } from "./sessions";
import { generateObject, getOpenRouterModel, openRouterApiKey, openRouterDefaultModel } from "./llm-calls-env";

type NumericSampleKey = "powerW" | "cadenceRpm" | "speedKph" | "resistance" | "heartRateBpm";

export type RideSummaryInput = {
  session: RideSession;
  riderProfile: RiderProfile;
};

const rideSummaryApiKey =
  process.env.RIDE_SUMMARY_API_KEY ||
  process.env.LIVE_COACH_API_KEY ||
  openRouterApiKey;

const rideSummaryModelName =
  process.env.RIDE_SUMMARY_MODEL ||
  process.env.LIVE_COACH_MODEL ||
  openRouterDefaultModel;

const rideSummaryModel = getOpenRouterModel(rideSummaryModelName);

const RideSummarySchema = z.object({
  headline: z.string().max(90),
  summary: z.string().max(900),
  keyObservations: z.array(z.string().max(180)).min(2).max(6),
  heartRateZoneAssessment: z.string().max(600),
  riderCommentsReflection: z.string().max(400).optional(),
  trainingLoadAssessment: z.string().max(500),
  dataQualityNotes: z.array(z.string().max(160)).min(1).max(5),
  suggestedNextFocus: z.array(z.string().max(160)).min(1).max(5),
  memoryCandidate: z
    .string()
    .max(500)
    .describe("One compact, durable rider-memory update if this ride teaches something useful."),
});

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number | null | undefined, digits = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function values(samples: BikeSample[], key: NumericSampleKey) {
  return samples
    .map((sample) => numberOrNull(sample[key]))
    .filter((value): value is number => value !== null);
}

function percentile(input: number[], p: number) {
  if (input.length === 0) return null;
  const sorted = [...input].sort((a, b) => a - b);
  const index = ((sorted.length - 1) * p) / 100;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] * (high - index) + sorted[high] * (index - low);
}

function average(input: number[]) {
  if (input.length === 0) return null;
  return input.reduce((sum, value) => sum + value, 0) / input.length;
}

function summarizeSeries(samples: BikeSample[], key: NumericSampleKey) {
  const series = values(samples, key);
  return {
    count: series.length,
    missing: samples.length - series.length,
    min: round(series.length ? Math.min(...series) : null, 1),
    max: round(series.length ? Math.max(...series) : null, 1),
    avg: round(average(series), 1),
    median: round(percentile(series, 50), 1),
    p10: round(percentile(series, 10), 1),
    p90: round(percentile(series, 90), 1),
  };
}

function zoneDistribution(
  samples: BikeSample[],
  zones: RiderProfile["hrZones"],
  durationSeconds: number
) {
  return zones.map((zone) => {
    const seconds = samples.filter(
      (sample) =>
        typeof sample.heartRateBpm === "number" &&
        sample.heartRateBpm >= zone.minBpm &&
        sample.heartRateBpm <= zone.maxBpm
    ).length;

    return {
      name: zone.name,
      rangeBpm: `${zone.minBpm}-${zone.maxBpm}`,
      seconds,
      percent: round(durationSeconds > 0 ? (seconds / durationSeconds) * 100 : 0, 1),
    };
  });
}

function powerDistribution(samples: BikeSample[], ftp: number, durationSeconds: number) {
  const zones = [
    { name: "off_or_coasting", min: -Infinity, max: 0 },
    { name: "recovery_lt_55_pct_ftp", min: 1, max: ftp * 0.55 },
    { name: "endurance_55_75_pct_ftp", min: ftp * 0.55, max: ftp * 0.75 },
    { name: "tempo_75_90_pct_ftp", min: ftp * 0.75, max: ftp * 0.9 },
    { name: "threshold_90_105_pct_ftp", min: ftp * 0.9, max: ftp * 1.05 },
    { name: "vo2_105_120_pct_ftp", min: ftp * 1.05, max: ftp * 1.2 },
    { name: "anaerobic_gt_120_pct_ftp", min: ftp * 1.2, max: Infinity },
  ];

  return zones.map((zone) => {
    const seconds = samples.filter((sample) => {
      if (typeof sample.powerW !== "number") return false;
      if (zone.name === "recovery_lt_55_pct_ftp") {
        return sample.powerW >= zone.min && sample.powerW <= zone.max;
      }
      return sample.powerW > zone.min && sample.powerW <= zone.max;
    }).length;

    return {
      name: zone.name,
      seconds,
      percent: round(durationSeconds > 0 ? (seconds / durationSeconds) * 100 : 0, 1),
    };
  });
}

function splitAverages(samples: BikeSample[]) {
  const midpoint = Math.floor(samples.length / 2);
  const sections = [
    { name: "first_half", samples: samples.slice(0, midpoint) },
    { name: "second_half", samples: samples.slice(midpoint) },
    { name: "first_third", samples: samples.slice(0, Math.floor(samples.length / 3)) },
    { name: "last_third", samples: samples.slice(-Math.floor(samples.length / 3)) },
  ];

  return sections.map((section) => ({
    name: section.name,
    avgPowerW: round(average(values(section.samples, "powerW")), 1),
    avgHeartRateBpm: round(average(values(section.samples, "heartRateBpm")), 1),
    avgCadenceRpm: round(average(values(section.samples, "cadenceRpm")), 1),
  }));
}

function decoupling(samples: BikeSample[]) {
  const midpoint = Math.floor(samples.length / 2);
  const stableSamples = samples.filter(
    (sample) => typeof sample.powerW === "number" && sample.powerW > 0 && typeof sample.heartRateBpm === "number"
  );
  const first = stableSamples.filter((sample) => samples.indexOf(sample) < midpoint);
  const second = stableSamples.filter((sample) => samples.indexOf(sample) >= midpoint);
  const firstRatio = average(values(first, "powerW")) && average(values(first, "heartRateBpm"))
    ? (average(values(first, "powerW")) as number) / (average(values(first, "heartRateBpm")) as number)
    : null;
  const secondRatio = average(values(second, "powerW")) && average(values(second, "heartRateBpm"))
    ? (average(values(second, "powerW")) as number) / (average(values(second, "heartRateBpm")) as number)
    : null;

  return {
    firstHalfPowerPerBpm: round(firstRatio, 3),
    secondHalfPowerPerBpm: round(secondRatio, 3),
    percentChange: round(
      firstRatio && secondRatio ? ((secondRatio - firstRatio) / firstRatio) * 100 : null,
      1
    ),
  };
}

function dataQuality(samples: BikeSample[]) {
  const timestamps = samples
    .map((sample) => numberOrNull(sample.timestamp))
    .filter((value): value is number => value !== null);
  const gaps = timestamps
    .slice(1)
    .map((timestamp, index) => (timestamp - timestamps[index]) / 1000);

  return {
    sampleCount: samples.length,
    averageSampleGapSeconds: round(average(gaps), 3),
    maxSampleGapSeconds: round(gaps.length ? Math.max(...gaps) : null, 3),
    gapsOverTwoSeconds: gaps.filter((gap) => gap > 2).length,
    missingPowerSeconds: samples.length - values(samples, "powerW").length,
    missingHeartRateSeconds: samples.length - values(samples, "heartRateBpm").length,
    missingCadenceSeconds: samples.length - values(samples, "cadenceRpm").length,
  };
}

export function buildRideSummaryPayload({ session, riderProfile }: RideSummaryInput) {
  const durationSeconds = session.metrics.durationSeconds || session.samples.length;

  return {
    session: {
      id: session.id,
      workoutName: session.workoutName,
      startedAtIso: new Date(
        session.samples[0]?.timestamp ?? session.timestamp
      ).toISOString(),
      savedAtIso: new Date(session.timestamp).toISOString(),
      riderComments: session.riderComments?.trim() || null,
      metrics: {
        ...session.metrics,
        iff: round(session.metrics.iff, 3),
        tss: round(session.metrics.tss, 1),
      },
    },
    riderProfile: {
      ftp: riderProfile.fourDP.ftp,
      map: riderProfile.fourDP.map,
      ac: riderProfile.fourDP.ac,
      nm: riderProfile.fourDP.nm,
      cTHR: riderProfile.cTHR,
      weightKg: riderProfile.weightKg,
      age: riderProfile.age,
      hrZones: riderProfile.hrZones.map((zone) => ({
        name: zone.name,
        rangeBpm: `${zone.minBpm}-${zone.maxBpm}`,
        percentageRange: zone.percentageRange,
      })),
      existingMemorySummary: riderProfile.memorySummary || null,
    },
    distributions: {
      heartRateZones: zoneDistribution(session.samples, riderProfile.hrZones, durationSeconds),
      powerZones: powerDistribution(session.samples, riderProfile.fourDP.ftp, durationSeconds),
    },
    series: {
      powerW: summarizeSeries(session.samples, "powerW"),
      heartRateBpm: summarizeSeries(session.samples, "heartRateBpm"),
      cadenceRpm: summarizeSeries(session.samples, "cadenceRpm"),
      speedKph: summarizeSeries(session.samples, "speedKph"),
      resistance: summarizeSeries(session.samples, "resistance"),
    },
    splits: splitAverages(session.samples),
    aerobicDecoupling: decoupling(session.samples),
    dataQuality: dataQuality(session.samples),
  };
}

export function buildRideSummaryPrompt(payload: ReturnType<typeof buildRideSummaryPayload>) {
  return `You are the post-ride analyst for a local indoor cycling app.

Task:
- Summarize one completed ride for the rider.
- Compare the ride against the stored rider profile and heart-rate zones.
- Use the rider's free-text comments as subjective context, but do not let them override telemetry.
- Identify what this ride teaches, what should be tracked better next time, and what is probably noise.
- Produce a durable memory candidate only if it would still be useful weeks later.

Rules:
- Be specific with numbers from the payload.
- Do not diagnose medical issues.
- Do not recommend changing HR zones from one ride alone; say when repeated evidence or a threshold test would be needed.
- Treat indoor speed as low-value unless simulation mode is clearly relevant.
- Keep the tone concise, practical, and coach-like.
- If data quality is weak, say so plainly and reduce confidence.

Ride analysis payload:
${JSON.stringify(payload, null, 2)}`;
}

export async function summarizeRideSession(
  input: RideSummaryInput
): Promise<{ summary?: RideLlmSummary; status: "skipped" | "generated" | "failed"; error?: string }> {
  if (!rideSummaryApiKey) {
    return {
      status: "skipped",
      error: "RIDE_SUMMARY_API_KEY, OPENROUTER_API_KEY, or LLM_CALLS_API_KEY is not configured",
    };
  }



  try {
    const payload = buildRideSummaryPayload(input);
    const result = await generateObject({
      model: rideSummaryModel,
      apiKey: rideSummaryApiKey,
      debugLabel: "ride-summary",
      messages: [{ role: "user", content: buildRideSummaryPrompt(payload) }],
      schema: RideSummarySchema,
    });

    return { status: "generated", summary: result.object };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to summarize ride session:", error);
    return { status: "failed", error: message };
  }
}
