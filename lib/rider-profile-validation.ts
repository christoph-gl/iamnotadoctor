import type { RiderProfile } from "./profile";

export type RiderProfilePatch = Partial<
  Omit<RiderProfile, "fourDP" | "colors" | "hrZones">
> & {
  fourDP?: Partial<RiderProfile["fourDP"]>;
  colors?: Partial<RiderProfile["colors"]>;
  hrZones?: RiderProfile["hrZones"];
};

const MEMORY_SUMMARY_MAX_LENGTH = 4000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableNumberInRange(
  value: unknown,
  min: number,
  max: number
): value is number | null {
  return value === null || (isFiniteNumber(value) && value >= min && value <= max);
}

function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function mergeRiderProfilePatch(
  current: RiderProfile,
  patch: RiderProfilePatch
): RiderProfile {
  return {
    ...current,
    ...patch,
    fourDP: {
      ...current.fourDP,
      ...(patch.fourDP ?? {}),
    },
    colors: {
      ...current.colors,
      ...(patch.colors ?? {}),
    },
    hrZones: patch.hrZones ?? current.hrZones,
    memorySummary:
      typeof patch.memorySummary === "string"
        ? patch.memorySummary.trim()
        : current.memorySummary,
  };
}

export function validateRiderProfile(profile: RiderProfile): string | null {
  const { fourDP } = profile;

  if (
    !isFiniteNumber(fourDP?.nm) ||
    !isFiniteNumber(fourDP?.ac) ||
    !isFiniteNumber(fourDP?.map) ||
    !isFiniteNumber(fourDP?.ftp)
  ) {
    return "4DP values must be finite numbers";
  }

  if (fourDP.nm < 50 || fourDP.nm > 3000) return "NM must be between 50 and 3000";
  if (fourDP.ac < 50 || fourDP.ac > 1500) return "AC must be between 50 and 1500";
  if (fourDP.map < 50 || fourDP.map > 1000) return "MAP must be between 50 and 1000";
  if (fourDP.ftp < 50 || fourDP.ftp > 800) return "FTP must be between 50 and 800";
  if (!isFiniteNumber(profile.cTHR) || profile.cTHR < 60 || profile.cTHR > 240) {
    return "cTHR must be between 60 and 240";
  }
  if (!nullableNumberInRange(profile.age, 1, 120)) {
    return "Age must be null or between 1 and 120";
  }
  if (!nullableNumberInRange(profile.weightKg, 20, 250)) {
    return "Weight must be null or between 20 and 250 kg";
  }
  if (profile.gender !== null && typeof profile.gender !== "string") {
    return "Gender must be a string or null";
  }
  if (!Array.isArray(profile.hrZones) || profile.hrZones.length === 0) {
    return "HR zones must be a non-empty array";
  }

  for (const zone of profile.hrZones) {
    if (
      typeof zone.id !== "string" ||
      typeof zone.name !== "string" ||
      typeof zone.percentageRange !== "string" ||
      !isFiniteNumber(zone.minBpm) ||
      !isFiniteNumber(zone.maxBpm) ||
      zone.minBpm < 0 ||
      zone.maxBpm > 300 ||
      zone.minBpm > zone.maxBpm ||
      !isValidHexColor(zone.color)
    ) {
      return "HR zones must include valid id, name, BPM range, and color fields";
    }
  }

  if (
    !profile.colors ||
    !isValidHexColor(profile.colors.nm) ||
    !isValidHexColor(profile.colors.ac) ||
    !isValidHexColor(profile.colors.map) ||
    !isValidHexColor(profile.colors.ftp)
  ) {
    return "4DP colors must be hex colors";
  }

  if (
    typeof profile.memorySummary !== "string" ||
    profile.memorySummary.length > MEMORY_SUMMARY_MAX_LENGTH
  ) {
    return `Memory summary must be a string under ${MEMORY_SUMMARY_MAX_LENGTH} characters`;
  }

  return null;
}

export function normalizeMemorySummary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim().slice(0, MEMORY_SUMMARY_MAX_LENGTH);
}
