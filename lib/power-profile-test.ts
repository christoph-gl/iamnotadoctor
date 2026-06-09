import type { RiderProfile } from "./profile";

export type PowerProfileMetric = keyof RiderProfile["fourDP"];

export type PowerProfileEstimate = {
  metric: PowerProfileMetric;
  label: string;
  durationLabel: string;
  oldValue: number;
  newValue: number;
};

type PowerSample = {
  elapsedSeconds: number;
  power?: number;
};

const TEST_WINDOWS: Array<{
  metric: PowerProfileMetric;
  label: string;
  durationLabel: string;
  startSeconds: number;
  durationSeconds: number;
}> = [
  { metric: "nm", label: "NM", durationLabel: "5 sec", startSeconds: 20 * 60, durationSeconds: 5 },
  { metric: "ac", label: "AC", durationLabel: "1 min", startSeconds: 25 * 60, durationSeconds: 60 },
  { metric: "map", label: "MAP", durationLabel: "5 min", startSeconds: 34 * 60, durationSeconds: 5 * 60 },
  { metric: "ftp", label: "FTP", durationLabel: "20 min", startSeconds: 49 * 60, durationSeconds: 20 * 60 },
];

export const POWER_PROFILE_RESULTS_READY_SECONDS = 69 * 60;

export function calculatePowerProfileEstimates(
  samples: PowerSample[],
  profile: RiderProfile
): PowerProfileEstimate[] | null {
  const estimates = TEST_WINDOWS.map((window) => {
    const powers = samples
      .filter(
        (sample) =>
          sample.elapsedSeconds >= window.startSeconds &&
          sample.elapsedSeconds < window.startSeconds + window.durationSeconds &&
          typeof sample.power === "number" &&
          Number.isFinite(sample.power) &&
          sample.power > 0
      )
      .map((sample) => sample.power as number);

    if (powers.length < Math.ceil(window.durationSeconds * 0.8)) return null;

    return {
      metric: window.metric,
      label: window.label,
      durationLabel: window.durationLabel,
      oldValue: profile.fourDP[window.metric],
      newValue: Math.round(powers.reduce((total, value) => total + value, 0) / powers.length),
    };
  });

  return estimates.every((estimate): estimate is PowerProfileEstimate => estimate !== null)
    ? estimates
    : null;
}
