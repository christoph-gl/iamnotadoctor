import { BikeSample } from "./trainer-client";

export type SessionMetrics = {
  tss: number;
  iff: number;
  durationSeconds: number;
  avgPower?: number;
  avgHr?: number;
  avgCadence?: number;
};

export type RideLlmSummary = {
  headline: string;
  summary: string;
  keyObservations: string[];
  heartRateZoneAssessment: string;
  riderCommentsReflection?: string;
  trainingLoadAssessment: string;
  dataQualityNotes: string[];
  suggestedNextFocus: string[];
  memoryCandidate: string;
};

export type RideSession = {
  id: string;
  workoutName: string;
  timestamp: number;
  samples: BikeSample[];
  metrics: SessionMetrics;
  riderComments?: string;
  llmSummary?: RideLlmSummary;
  llmSummaryStatus?: "skipped" | "generated" | "failed";
  llmSummaryError?: string;
};

export type RideSessionSummary = Omit<RideSession, "samples"> & {
  sampleCount: number;
};

export async function saveRideSession(session: RideSession): Promise<RideSession> {
  if (typeof window === "undefined") return session;
  try {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session),
    });
    if (!res.ok) throw new Error("Failed to save session");
    const data = await res.json();
    const savedSession = data.session && typeof data.session === "object"
      ? data.session as RideSession
      : session;

    const sessions = getLocalRideSessions();
    sessions.unshift(savedSession); // Newest first
    localStorage.setItem("ride_history", JSON.stringify(sessions));
    return savedSession;
  } catch (e) {
    console.error("Failed to save ride session via API:", e);
  }

  const sessions = getLocalRideSessions();
  sessions.unshift(session); // Newest first
  localStorage.setItem("ride_history", JSON.stringify(sessions));
  return session;
}

export function getLocalRideSessions(): RideSession[] {
  if (typeof window === "undefined") return [];
  try {
    const data = localStorage.getItem("ride_history");
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export async function getSavedRideSessions(): Promise<RideSession[]> {
  if (typeof window === "undefined") return [];
  try {
    const res = await fetch("/api/sessions?includeSamples=true");
    if (!res.ok) throw new Error("Failed to fetch sessions");
    const sessions = await res.json();
    if (Array.isArray(sessions) && sessions.length > 0) {
      return sessions;
    }

    const localSessions = getLocalRideSessions();
    if (localSessions.length > 0) {
      await Promise.all(localSessions.map((session) => saveRideSession(session)));
      return localSessions;
    }

    return [];
  } catch (e) {
    console.error("Failed to load ride sessions via API:", e);
    return getLocalRideSessions();
  }
}

export async function deleteRideSession(id: string) {
  if (typeof window === "undefined") return;
  try {
    await fetch(`/api/sessions?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  } catch (e) {
    console.error("Failed to delete ride session via API:", e);
  }

  const sessions = getLocalRideSessions();
  const filtered = sessions.filter(s => s.id !== id);
  localStorage.setItem("ride_history", JSON.stringify(filtered));
}

export function calculateActualMetrics(samples: BikeSample[], ftp: number): SessionMetrics {
  if (samples.length === 0) return { tss: 0, iff: 0, durationSeconds: 0 };
  
  const durationSeconds = samples.length; // Assuming roughly 1 sample per second
  let powerSum = 0;
  let hrSum = 0;
  let cadenceSum = 0;
  let powerCount = 0;
  let hrCount = 0;
  let cadenceCount = 0;

  for (const s of samples) {
    if (s.powerW !== undefined) {
      powerSum += s.powerW;
      powerCount++;
    }
    if (s.heartRateBpm !== undefined) {
      hrSum += s.heartRateBpm;
      hrCount++;
    }
    if (s.cadenceRpm !== undefined) {
      cadenceSum += s.cadenceRpm;
      cadenceCount++;
    }
  }

  // NP Calculation
  let rollingSum4 = 0;
  let count = 0;
  for (let i = 29; i < samples.length; i++) {
    let sum30 = 0;
    for (let j = 0; j < 30; j++) {
      sum30 += samples[i - j].powerW || 0;
    }
    const avg30 = sum30 / 30;
    rollingSum4 += Math.pow(avg30, 4);
    count++;
  }
  
  const np = count > 0 ? Math.pow(rollingSum4 / count, 0.25) : (powerSum / (powerCount || 1));
  const iff = ftp > 0 ? np / ftp : 0;
  const tss = ftp > 0 ? (durationSeconds * np * iff) / (ftp * 36) : 0;

  return {
    tss,
    iff,
    durationSeconds,
    avgPower: powerCount > 0 ? Math.round(powerSum / powerCount) : undefined,
    avgHr: hrCount > 0 ? Math.round(hrSum / hrCount) : undefined,
    avgCadence: cadenceCount > 0 ? Math.round(cadenceSum / cadenceCount) : undefined
  };
}
