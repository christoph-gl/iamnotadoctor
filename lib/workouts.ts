import { RIDER_PROFILE, type RiderProfile } from "./profile";

export type WorkoutBlock = {
  durationSeconds: number;
  targetPower: number;
};

export type Workout = {
  id: string;
  name: string;
  description: string;
  blocks: WorkoutBlock[];
};

export type LLMWorkoutBlock = {
  duration_seconds: number;
  zone: string;
  intensity_percent: number;
  reference_metric: "FTP" | "MAP" | "AC" | "NM";
};

export type LLMWorkout = {
  name: string;
  total_duration_minutes: number;
  blocks: LLMWorkoutBlock[];
};

export function parseLLMWorkout(
  llmJson: LLMWorkout,
  riderProfile: RiderProfile = RIDER_PROFILE
): Workout {
  return {
    id: "imported-" + Date.now(),
    name: llmJson.name || "Imported Workout",
    description: "Imported via AI extraction",
    blocks: llmJson.blocks.map((block) => {
      let basePower = riderProfile.fourDP.ftp;
      if (block.reference_metric === "MAP") basePower = riderProfile.fourDP.map;
      if (block.reference_metric === "AC") basePower = riderProfile.fourDP.ac;
      if (block.reference_metric === "NM") basePower = riderProfile.fourDP.nm;

      return {
        durationSeconds: block.duration_seconds,
        targetPower: Math.round(basePower * (block.intensity_percent / 100)),
      };
    }),
  };
}

export function parseZwoWorkout(
  xmlString: string,
  riderProfile: RiderProfile = RIDER_PROFILE
): Workout {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlString, "text/xml");
  
  const nameNode = xmlDoc.querySelector("name") || xmlDoc.querySelector("Name");
  const descNode = xmlDoc.querySelector("description") || xmlDoc.querySelector("Description");
  
  const name = nameNode ? nameNode.textContent || "ZWO Workout" : "ZWO Workout";
  const description = descNode ? descNode.textContent || "Imported from ZWO file" : "Imported from ZWO file";
  
  const workoutNode = xmlDoc.querySelector("workout") || xmlDoc.querySelector("Workout") || xmlDoc.querySelector("workout_file");
  const workoutNodes = workoutNode?.children;
  const blocks: WorkoutBlock[] = [];
  
  const getAttr = (node: Element, name: string) => {
    return node.getAttribute(name) || node.getAttribute(name.toLowerCase()) || "0";
  };
  const hasAttr = (node: Element, name: string) => {
    return node.hasAttribute(name) || node.hasAttribute(name.toLowerCase());
  };

  if (workoutNodes) {
    for (let i = 0; i < workoutNodes.length; i++) {
      const node = workoutNodes[i];
      const tag = node.tagName.toLowerCase();
      
      if (tag === "steadystate" || tag === "warmup" || tag === "cooldown" || tag === "freeride") {
        const duration = parseFloat(getAttr(node, "Duration"));
        let powerRatio = parseFloat(getAttr(node, "Power"));
        
        if (hasAttr(node, "PowerLow") && hasAttr(node, "PowerHigh")) {
          const powerLow = parseFloat(getAttr(node, "PowerLow"));
          const powerHigh = parseFloat(getAttr(node, "PowerHigh"));
          powerRatio = (powerLow + powerHigh) / 2; // simplified ramp
        }
        
        blocks.push({
          durationSeconds: duration,
          targetPower: Math.round(riderProfile.fourDP.ftp * powerRatio)
        });
      } else if (tag === "intervalst") {
        const repeat = parseInt(getAttr(node, "Repeat") || "1", 10);
        const onDuration = parseFloat(getAttr(node, "OnDuration"));
        const onPower = parseFloat(getAttr(node, "OnPower"));
        const offDuration = parseFloat(getAttr(node, "OffDuration"));
        const offPower = parseFloat(getAttr(node, "OffPower"));
        
        for (let r = 0; r < repeat; r++) {
          blocks.push({
            durationSeconds: onDuration,
            targetPower: Math.round(riderProfile.fourDP.ftp * onPower)
          });
          if (offDuration > 0) {
            blocks.push({
              durationSeconds: offDuration,
              targetPower: Math.round(riderProfile.fourDP.ftp * offPower)
            });
          }
        }
      }
    }
  }

  return {
    id: "imported-zwo-" + Date.now(),
    name,
    description,
    blocks
  };
}

export function calculateWorkoutMetrics(workout: Workout, ftp: number) {
  const totalSeconds = workout.blocks.reduce((acc, b) => acc + b.durationSeconds, 0);
  if (totalSeconds === 0) return { np: 0, iff: 0, tss: 0 };

  const secData: number[] = [];
  for (const b of workout.blocks) {
    for (let i = 0; i < b.durationSeconds; i++) {
      secData.push(b.targetPower);
    }
  }
  
  let rollingSum4 = 0;
  let count = 0;
  for (let i = 29; i < secData.length; i++) {
    let sum30 = 0;
    for (let j = 0; j < 30; j++) {
      sum30 += secData[i - j];
    }
    const avg30 = sum30 / 30;
    rollingSum4 += Math.pow(avg30, 4);
    count++;
  }
  
  const np = count > 0 ? Math.pow(rollingSum4 / count, 0.25) : 0;
  const iff = ftp > 0 ? np / ftp : 0;
  const tss = ftp > 0 ? (totalSeconds * np * iff) / (ftp * 36) : 0;

  return { np, iff, tss };
}

export async function saveWorkout(workout: Workout) {
  if (typeof window === "undefined") return;
  try {
    await fetch("/api/workouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workout)
    });
  } catch (e) {
    console.error("Failed to save workout via API:", e);
    alert("Warning: Could not save workout to local file.");
  }
}

export async function updateWorkout(workout: Workout) {
  if (typeof window === "undefined") return;
  try {
    await fetch("/api/workouts", {
      method: "POST", // POST overwrites if ID exists
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workout)
    });
  } catch (e) {
    console.error("Failed to update workout via API:", e);
    alert("Warning: Could not save workout changes to local file.");
  }
}

export async function deleteWorkout(id: string) {
  if (typeof window === "undefined") return;
  try {
    const res = await fetch(`/api/workouts?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || "Failed to delete workout");
    }
  } catch (e) {
    console.error("Failed to delete workout via API:", e);
    alert(e instanceof Error ? e.message : "Warning: Could not delete workout.");
    throw e;
  }
}

export async function getSavedWorkouts(): Promise<Workout[]> {
  if (typeof window === "undefined") return [];
  try {
    const res = await fetch("/api/workouts");
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    console.error("Failed to fetch workouts from API:", e);
    return [];
  }
}

export async function getWorkoutLibrary(): Promise<{
  savedWorkouts: Workout[];
  deletedWorkoutIds: string[];
}> {
  if (typeof window === "undefined") return { savedWorkouts: [], deletedWorkoutIds: [] };
  try {
    const res = await fetch("/api/workouts?includeDeleted=true");
    if (!res.ok) return { savedWorkouts: [], deletedWorkoutIds: [] };
    const data = await res.json();
    return {
      savedWorkouts: Array.isArray(data?.workouts) ? data.workouts : [],
      deletedWorkoutIds: Array.isArray(data?.deletedWorkoutIds)
        ? data.deletedWorkoutIds.filter((id: unknown): id is string => typeof id === "string")
        : [],
    };
  } catch (e) {
    console.error("Failed to fetch workout library from API:", e);
    return { savedWorkouts: [], deletedWorkoutIds: [] };
  }
}

export const ADAPTIVE_FREERIDE_ID = "adaptive-freeride";

export const ADAPTIVE_FREERIDE: Workout = {
  id: ADAPTIVE_FREERIDE_ID,
  name: "Adaptive Freeride",
  description:
    "LLM-coached freeride starting at 80 W. The in-app live coach refreshes the plan every 2 minutes from live telemetry.",
  blocks: [{ durationSeconds: 60 * 60, targetPower: 80 }],
};

export function isAdaptiveFreeride(workout: Workout) {
  return workout.id === ADAPTIVE_FREERIDE_ID;
}

export function spliceUpcomingBlocks(
  current: Workout,
  elapsedSeconds: number,
  leadSeconds: number,
  upcoming: WorkoutBlock[]
): Workout {
  const splicePoint = Math.max(elapsedSeconds + Math.max(leadSeconds, 0), 0);
  const kept: WorkoutBlock[] = [];
  let acc = 0;

  for (const b of current.blocks) {
    const end = acc + b.durationSeconds;
    if (end <= splicePoint) {
      kept.push(b);
      acc = end;
      continue;
    }
    if (acc < splicePoint) {
      kept.push({ ...b, durationSeconds: splicePoint - acc });
      acc = splicePoint;
    }
    break;
  }

  return { ...current, blocks: [...kept, ...upcoming] };
}

export const WORKOUTS: Workout[] = [
  {
    id: "the-shovel-simulated",
    name: "The Shovel (Simulated)",
    description: "A challenging set of Anaerobic Capacity efforts mimicking your profile screenshot.",
    blocks: [
      // Warmup
      { durationSeconds: 300, targetPower: 110 },
      { durationSeconds: 60, targetPower: 130 },
      { durationSeconds: 60, targetPower: 150 },
      { durationSeconds: 60, targetPower: 172 }, // FTP
      { durationSeconds: 120, targetPower: 120 },
      // Primer
      { durationSeconds: 30, targetPower: 216 }, // MAP
      { durationSeconds: 30, targetPower: 335 }, // AC
      { durationSeconds: 180, targetPower: 110 },
      // Main Intervals
      { durationSeconds: 60, targetPower: 335 }, { durationSeconds: 120, targetPower: 110 },
      { durationSeconds: 60, targetPower: 335 }, { durationSeconds: 120, targetPower: 110 },
      { durationSeconds: 60, targetPower: 335 }, { durationSeconds: 120, targetPower: 110 },
      { durationSeconds: 60, targetPower: 335 }, { durationSeconds: 120, targetPower: 110 },
      { durationSeconds: 60, targetPower: 335 }, { durationSeconds: 120, targetPower: 110 },
      { durationSeconds: 60, targetPower: 335 }, { durationSeconds: 120, targetPower: 110 },
      // Cooldown
      { durationSeconds: 300, targetPower: 100 },
    ]
  },
  {
    id: "sweet-spot-3x10",
    name: "Sweet Spot 3x10",
    description: "Build muscular endurance with 3x 10-minute intervals just below threshold.",
    blocks: [
      { durationSeconds: 300, targetPower: 100 },
      { durationSeconds: 300, targetPower: 130 },
      // Interval 1
      { durationSeconds: 600, targetPower: 160 },
      { durationSeconds: 180, targetPower: 100 },
      // Interval 2
      { durationSeconds: 600, targetPower: 160 },
      { durationSeconds: 180, targetPower: 100 },
      // Interval 3
      { durationSeconds: 600, targetPower: 160 },
      { durationSeconds: 300, targetPower: 100 },
    ]
  }
];
