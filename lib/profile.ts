export type RiderProfile = {
  fourDP: {
    nm: number;
    ac: number;
    map: number;
    ftp: number;
  };
  cTHR: number;
  age: number | null;
  weightKg: number | null;
  gender: string | null;
  hrZones: {
    id: string;
    name: string;
    percentageRange: string;
    minBpm: number;
    maxBpm: number;
    color: string;
  }[];
  colors: {
    nm: string;
    ac: string;
    map: string;
    ftp: string;
  };
  memorySummary: string;
};

export const DEFAULT_RIDER_PROFILE: RiderProfile = {
  fourDP: {
    nm: 821, // Neuromuscular Power (5s)
    ac: 335, // Anaerobic Capacity (1m)
    map: 216, // Maximal Aerobic Power (5m)
    ftp: 172, // Functional Threshold Power (20m)
  },
  age: null,
  weightKg: null,
  gender: null,
  cTHR: 165, // Cycling Threshold Heart Rate
  hrZones: [
    { id: "z1", name: "Z1 Recovery", percentageRange: "< 70%", minBpm: 0, maxBpm: 115, color: "#9e9e9e" },
    { id: "z2", name: "Z2 Endurance", percentageRange: "70 - 87%", minBpm: 116, maxBpm: 144, color: "#03a9f4" },
    { id: "z3", name: "Z3 Tempo", percentageRange: "88 - 95%", minBpm: 145, maxBpm: 157, color: "#4caf50" },
    { id: "z4", name: "Z4 Threshold", percentageRange: "96 - 100%", minBpm: 158, maxBpm: 165, color: "#ff9800" },
    { id: "z5", name: "Z5 Max", percentageRange: "> 100%", minBpm: 166, maxBpm: 300, color: "#e91e63" },
  ],
  colors: {
    nm: "#e91e63", // Pink
    ac: "#ff9800", // Orange
    map: "#ffc107", // Yellow
    ftp: "#03a9f4", // Blue
  },
  memorySummary: "",
};

export const RIDER_PROFILE = DEFAULT_RIDER_PROFILE;

export async function getRiderProfile(): Promise<RiderProfile> {
  if (typeof window === "undefined") return DEFAULT_RIDER_PROFILE;

  try {
    const res = await fetch("/api/rider");
    if (!res.ok) throw new Error("Failed to fetch rider profile");
    return await res.json();
  } catch (e) {
    console.error("Failed to load rider profile:", e);
    return DEFAULT_RIDER_PROFILE;
  }
}

export async function saveRiderProfile(profile: RiderProfile) {
  if (typeof window === "undefined") return;

  try {
    await fetch("/api/rider", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
  } catch (e) {
    console.error("Failed to save rider profile:", e);
  }
}
