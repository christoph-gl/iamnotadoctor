import { RIDER_PROFILE, type RiderProfile } from "./profile";

export type WorkoutBlock = {
  durationSeconds: number;
  targetPower: number;
};

/**
 * A point in the workout where the voice coach speaks.
 * - focus: a brief for the AI coach, which writes and speaks one line about it
 *   using live telemetry (e.g. "Effort 3 of 6 starts in 15 s: 1 min at 335 W").
 * - message: a fixed line spoken as written, without an AI call. Use it for
 *   scripted protocols such as fitness tests, where timing must be exact.
 */
export type CoachCue = {
  atSeconds: number;
  focus?: string;
  message?: string;
};

export type Workout = {
  id: string;
  name: string;
  description: string;
  blocks: WorkoutBlock[];
  kind?: "fitness-test";
  trainerMode?: "erg" | "resistance";
  resistanceLevel?: number;
  coachInstructions?: string;
  /** Custom voice coach cue points. Without them the app derives cues from the blocks. */
  coachCues?: CoachCue[];
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
export const POWER_PROFILE_TEST_ID = "power-profile-test";

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

export function isPowerProfileTest(workout: Workout) {
  return workout.id === POWER_PROFILE_TEST_ID || workout.kind === "fitness-test";
}

const m = (minutes: number, seconds = 0) => minutes * 60 + seconds;

// Scripted lines for the power profile test. The trainer stays in resistance
// mode, so the rider sets power with gears and cadence; the measured windows
// are 20:00 (5 s), 25:00 (1 min), 34:00 (5 min) and 49:00 (20 min), see
// lib/power-profile-test.ts. "Go" cues come 2 s early to cover speech latency.
const POWER_PROFILE_TEST_CUES: CoachCue[] = [
  { atSeconds: 0, message: "Power profile test. The trainer stays in resistance mode, so you set the power with your gears and cadence, not the chart. Start easy and build gradually over the next 15 minutes." },
  { atSeconds: m(5), message: "Keep building gently. Shift up one gear or raise your cadence a little each minute. You should still be able to talk." },
  { atSeconds: m(10), message: "Warm-up is two thirds done. Stay relaxed around 90 rpm and breathe calmly." },
  { atSeconds: m(15), message: "Warm-up done. Five easy minutes to get ready. Drink now, and pick your sprint gear: heavy, but one you can still spin up fast." },
  { atSeconds: m(19, 30), message: "Sprint in 30 seconds. Shift into your sprint gear and let the cadence drop so you can jump on it." },
  { atSeconds: m(19, 48), message: "10 seconds. Hands on the drops, get ready." },
  { atSeconds: m(19, 58), message: "Go! All out for 5 seconds!" },
  { atSeconds: m(20, 6), message: "Stop. Shift down and spin easy. Next is the 1-minute effort at 25 minutes." },
  { atSeconds: m(24), message: "One-minute effort in one minute. Pick a gear you can push very hard for a full minute." },
  { atSeconds: m(24, 45), message: "15 seconds. Start hard, but do not sprint the first seconds." },
  { atSeconds: m(24, 58), message: "Go! One minute, as hard as you can hold." },
  { atSeconds: m(25, 30), message: "Halfway. Hold it, keep the cadence up." },
  { atSeconds: m(25, 48), message: "10 seconds. Empty the tank." },
  { atSeconds: m(26, 2), message: "Done. Shift down and spin easy. Eight minutes of recovery." },
  { atSeconds: m(30), message: "Keep recovering. The 5-minute effort starts at 34 minutes. Drink and breathe." },
  { atSeconds: m(33), message: "Five-minute effort in one minute. Choose a gear and cadence you can hold for five minutes. Even pacing, no sprint start." },
  { atSeconds: m(33, 45), message: "15 seconds. Settle in for a steady start." },
  { atSeconds: m(33, 58), message: "Go! Five minutes, hard but even." },
  { atSeconds: m(35), message: "One minute done. Keep it steady and do not fade." },
  { atSeconds: m(36, 30), message: "Halfway. Hold your gear and cadence." },
  { atSeconds: m(38), message: "One minute to go. Lift it if you have anything left." },
  { atSeconds: m(38, 48), message: "10 seconds. Finish strong." },
  { atSeconds: m(39, 2), message: "Done. Easy spinning now, ten minutes of recovery before the 20-minute effort." },
  { atSeconds: m(44), message: "Five more minutes of recovery. Drink and stay loose. The 20-minute effort sets your FTP, so plan a pace you can hold the whole way." },
  { atSeconds: m(48), message: "20-minute effort in one minute. Pick a gear you can hold for all 20 minutes, and start a little conservative." },
  { atSeconds: m(48, 58), message: "Go! 20 minutes, steady and controlled." },
  { atSeconds: m(54), message: "Five minutes in. Breathing should be hard but controlled. Hold the same gear and cadence." },
  { atSeconds: m(59), message: "Halfway. If you feel good, hold this pace. No surges." },
  { atSeconds: m(64), message: "Five minutes left. Start lifting gradually if you can." },
  { atSeconds: m(67), message: "Two minutes to go. Give what you have left." },
  { atSeconds: m(68, 30), message: "30 seconds. Empty the tank." },
  { atSeconds: m(69, 2), message: "Test done. Shift down and spin easy for the cooldown. Your results are ready on screen." },
  { atSeconds: m(74), message: "Keep it easy. Five minutes of cooldown left." },
];

const POWER_PROFILE_TEST: Workout = {
  id: POWER_PROFILE_TEST_ID,
  name: "Power Profile Test",
  description:
    "A 79-minute resistance-mode test with maximal 5-second, 1-minute, 5-minute, and 20-minute efforts to estimate NM, AC, MAP, and FTP.",
  kind: "fitness-test",
  trainerMode: "resistance",
  resistanceLevel: 20,
  coachInstructions:
    "This is a maximal power-profile assessment, not a normal ERG workout. The trainer is in resistance mode. Coach the rider through the protocol: progressive warm-up, easy preparation, all-out 5-second NM sprint at 20:00, maximal sustainable 1-minute AC effort at 25:00, maximal sustainable 5-minute MAP effort at 34:00, and best sustainable 20-minute FTP effort at 49:00. During recovery, prioritize actual recovery. Before each test effort, explain pacing and timing briefly. Never tell the rider to match the chart watts; the measured power determines the result.",
  coachCues: POWER_PROFILE_TEST_CUES,
  blocks: [
    ...Array.from({ length: 15 }, (_, index) => ({
      durationSeconds: 60,
      targetPower: 80 + Math.round((60 * index) / 14),
    })),
    { durationSeconds: 300, targetPower: 120 },
    { durationSeconds: 5, targetPower: 821 },
    { durationSeconds: 295, targetPower: 100 },
    { durationSeconds: 60, targetPower: 335 },
    { durationSeconds: 480, targetPower: 100 },
    { durationSeconds: 300, targetPower: 216 },
    { durationSeconds: 600, targetPower: 100 },
    { durationSeconds: 1200, targetPower: 172 },
    ...Array.from({ length: 10 }, (_, index) => ({
      durationSeconds: 60,
      targetPower: 100 - Math.round((30 * index) / 9),
    })),
  ],
};

export function spliceUpcomingBlocks(
  current: Workout,
  elapsedSeconds: number,
  leadSeconds: number,
  upcoming: WorkoutBlock[],
  replaceDurationSeconds?: number
): Workout {
  const splicePoint = Math.max(elapsedSeconds + Math.max(leadSeconds, 0), 0);
  const kept: WorkoutBlock[] = [];
  const following: WorkoutBlock[] = [];
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

  if (typeof replaceDurationSeconds === "number" && replaceDurationSeconds > 0) {
    const resumePoint = splicePoint + replaceDurationSeconds;
    acc = 0;

    for (const block of current.blocks) {
      const blockStart = acc;
      const blockEnd = acc + block.durationSeconds;
      acc = blockEnd;

      if (blockEnd <= resumePoint) continue;
      if (blockStart < resumePoint) {
        following.push({ ...block, durationSeconds: blockEnd - resumePoint });
      } else {
        following.push(block);
      }
    }
  }

  return { ...current, blocks: [...kept, ...upcoming, ...following] };
}

export const WORKOUTS: Workout[] = [
  {
    id: "the-shovel-simulated",
    name: "The Shovel (Simulated)",
    description: "A challenging set of Anaerobic Capacity efforts mimicking your profile screenshot.",
    coachCues: [
      { atSeconds: 0, focus: "Ride start: six 1-minute AC efforts after a warm-up and primer; outline the session and how to warm up." },
      { atSeconds: m(6, 45), focus: "One minute at FTP (172 W) starts in 15 s, the last warm-up step. Smooth and steady." },
      { atSeconds: m(9, 45), focus: "Primer in 15 s: 30 s at MAP then 30 s at AC to open the legs. Not a full effort." },
      { atSeconds: m(13, 45), focus: "AC effort 1 of 6 starts in 15 s: 1 min at 335 W. Explain how to pace a 1-minute effort without fading." },
      { atSeconds: m(16, 45), focus: "AC effort 2 of 6 starts in 15 s: 1 min at 335 W. One pacing cue." },
      { atSeconds: m(19, 45), focus: "AC effort 3 of 6 starts in 15 s: 1 min at 335 W. Halfway through the set; check how recovery is going." },
      { atSeconds: m(22, 45), focus: "AC effort 4 of 6 starts in 15 s: 1 min at 335 W. Focus on form when it hurts." },
      { atSeconds: m(25, 45), focus: "AC effort 5 of 6 starts in 15 s: 1 min at 335 W. Keep the cadence high." },
      { atSeconds: m(28, 45), focus: "Last AC effort, 6 of 6, starts in 15 s: 1 min at 335 W. Finish strong." },
      { atSeconds: m(30, 5), focus: "Cooldown starts: wrap up the session and tell the rider to spin easy." },
    ],
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
    coachCues: [
      { atSeconds: 0, focus: "Ride start: three 10-minute sweet spot intervals at 160 W; outline the session and the warm-up." },
      { atSeconds: m(9, 45), focus: "Interval 1 of 3 starts in 15 s: 10 min at 160 W. Settle into a steady cadence and controlled breathing." },
      { atSeconds: m(15), focus: "Halfway through interval 1 of 3. Check posture and cadence." },
      { atSeconds: m(20, 5), focus: "Recovery after interval 1 of 3: three easy minutes, drink." },
      { atSeconds: m(22, 45), focus: "Interval 2 of 3 starts in 15 s: 10 min at 160 W. Same pacing as the first." },
      { atSeconds: m(28), focus: "Halfway through interval 2 of 3. Comment on heart-rate drift compared with interval 1." },
      { atSeconds: m(33, 5), focus: "Recovery after interval 2 of 3: three easy minutes, drink." },
      { atSeconds: m(35, 45), focus: "Interval 3 of 3 starts in 15 s: 10 min at 160 W. Last one, stay steady." },
      { atSeconds: m(41), focus: "Halfway through the last interval. Encourage and keep form." },
      { atSeconds: m(46, 5), focus: "Cooldown starts: wrap up the session and tell the rider to spin easy." },
    ],
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
  },
  POWER_PROFILE_TEST,
];
