import type { CoachCue, WorkoutBlock } from "./workouts";

/** Cues closer together than this are merged; the coach needs time to speak. */
export const MIN_CUE_GAP_SECONDS = 45;
/** Longest silence on steady riding before a check-in is added. */
const STEADY_CHECK_IN_SECONDS = 15 * 60;
/** How long before an effort the coach announces it. */
const EFFORT_LEAD_SECONDS = 15;
/** Share of FTP from which a block counts as an effort. */
const EFFORT_FTP_RATIO = 0.88;
/** Efforts with less easy riding than this between them form one set. */
const SET_REST_SECONDS = 2 * 60;
/** Reps that repeat at least this often get their own cue; faster ones are cued per set. */
const PER_REP_CYCLE_SECONDS = 150;
/** Check-in spacing inside a long set of short reps. */
const SET_CHECK_IN_SECONDS = 5 * 60;

const MAX_CUES = 120;
const MAX_TEXT = 300;

function totalSeconds(blocks: WorkoutBlock[]) {
  return blocks.reduce((total, block) => total + block.durationSeconds, 0);
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? `${minutes} min` : `${Math.floor(minutes)} min ${seconds % 60} s`;
}

function cleanText(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return text || undefined;
}

/**
 * Validates cues from a client, a file or an LLM: drops malformed entries,
 * clamps to the workout's length, sorts by time and drops cues that come
 * too soon after the previous one.
 */
export function normalizeCoachCues(value: unknown, durationSeconds: number): CoachCue[] {
  if (!Array.isArray(value)) return [];
  const cues = value
    .map((entry): CoachCue | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const at = Number(record.atSeconds);
      if (!Number.isFinite(at)) return null;
      const focus = cleanText(record.focus);
      const message = cleanText(record.message);
      if (!focus && !message) return null;
      const atSeconds = Math.max(0, Math.min(Math.max(durationSeconds - 1, 0), Math.round(at)));
      return { atSeconds, ...(focus ? { focus } : {}), ...(message ? { message } : {}) };
    })
    .filter((cue): cue is CoachCue => cue !== null)
    .sort((a, b) => a.atSeconds - b.atSeconds);

  const kept: CoachCue[] = [];
  for (const cue of cues) {
    const previous = kept[kept.length - 1];
    // Scripted lines (message) are kept even when close together: they are
    // spoken locally without an AI call, e.g. a "go" right after a countdown.
    if (previous && !cue.message && cue.atSeconds - previous.atSeconds < MIN_CUE_GAP_SECONDS) continue;
    kept.push(cue);
    if (kept.length >= MAX_CUES) break;
  }
  return kept;
}

type Candidate = CoachCue & { priority: number };

/**
 * Fallback cue points for a workout that has none: announce each effort
 * shortly before it starts, check in halfway through long efforts and at
 * the start of recoveries and the cooldown, and otherwise speak about every
 * 15 minutes on steady riding.
 */
export function deriveCoachCues(blocks: WorkoutBlock[], ftp: number): CoachCue[] {
  const duration = totalSeconds(blocks);
  if (duration <= 0) return [];
  const safeFtp = ftp > 0 ? ftp : 200;
  const isEffort = (block: WorkoutBlock | undefined) =>
    !!block && block.targetPower >= safeFtp * EFFORT_FTP_RATIO;

  // Merge consecutive effort blocks (and consecutive easy blocks) into segments.
  type Segment = { start: number; duration: number; effort: boolean; peak: number; avg: number };
  const segments: Segment[] = [];
  let t = 0;
  for (const block of blocks) {
    const effort = isEffort(block);
    const last = segments[segments.length - 1];
    if (last && last.effort === effort) {
      last.avg = (last.avg * last.duration + block.targetPower * block.durationSeconds) / (last.duration + block.durationSeconds);
      last.duration += block.durationSeconds;
      last.peak = Math.max(last.peak, block.targetPower);
    } else {
      segments.push({ start: t, duration: block.durationSeconds, effort, peak: block.targetPower, avg: block.targetPower });
    }
    t += block.durationSeconds;
  }

  // Group efforts separated by short recoveries into sets (e.g. 8 x 45 s / 60 s).
  type EffortSet = { reps: Segment[]; after: Segment | undefined; isLast: boolean };
  const sets: EffortSet[] = [];
  segments.forEach((segment, index) => {
    if (!segment.effort) return;
    const current = sets[sets.length - 1];
    const gapBefore = segments[index - 1];
    if (current && current.after === gapBefore && gapBefore && gapBefore.duration < SET_REST_SECONDS) {
      current.reps.push(segment);
    } else {
      sets.push({ reps: [segment], after: undefined, isLast: false });
    }
    sets[sets.length - 1].after = segments[index + 1];
  });
  if (sets.length) sets[sets.length - 1].isLast = true;

  const describe = (segment: Segment) =>
    `${formatDuration(segment.duration)} around ${Math.round(segment.avg)} W (${Math.round((segment.avg / safeFtp) * 100)}% FTP)`;

  const candidates: Candidate[] = [
    {
      atSeconds: 0,
      priority: 5,
      focus: sets.length
        ? `Ride start: ${sets.length} interval block${sets.length === 1 ? "" : "s"} ahead; outline the session and how to warm up.`
        : "Ride start: steady ride; outline the session and the effort level to hold.",
    },
  ];
  const before = (segment: Segment) => Math.max(0, segment.start - EFFORT_LEAD_SECONDS);

  sets.forEach((set, setIndex) => {
    const setLabel = sets.length > 1 ? ` of set ${setIndex + 1} of ${sets.length}` : "";
    const n = set.reps.length;
    const first = set.reps[0];
    const last = set.reps[n - 1];
    const cycle = n > 1 ? (last.start - first.start) / (n - 1) : Infinity;

    if (cycle >= PER_REP_CYCLE_SECONDS) {
      // Long reps: announce each one, and check in halfway through long efforts.
      set.reps.forEach((rep, repIndex) => {
        const label = n === 1 ? `Effort ${setIndex + 1} of ${sets.length}` : `Rep ${repIndex + 1} of ${n}${setLabel}`;
        candidates.push({
          atSeconds: before(rep),
          priority: 4,
          focus: `${label} starts in ${EFFORT_LEAD_SECONDS} s: ${describe(rep)}. Prepare the rider and give one pacing cue.`,
        });
        if (rep.duration >= 4 * 60) {
          candidates.push({
            atSeconds: rep.start + Math.round(rep.duration / 2),
            priority: 2,
            focus: `Halfway through ${label.toLowerCase()}. Check form, breathing and pacing.`,
          });
        }
      });
    } else {
      // Short reps: announce the set, check in mid-set and before the last rep.
      const rest = segments[segments.indexOf(first) + 1];
      candidates.push({
        atSeconds: before(first),
        priority: 4,
        focus: `Set ${setIndex + 1} of ${sets.length} starts in ${EFFORT_LEAD_SECONDS} s: ${n} reps, the first ${describe(first)}${rest ? `, about ${formatDuration(rest.duration)} easy between` : ""}. Explain the set and how to pace it.`,
      });
      // Long sets get a check-in at a rep start about every 5 minutes.
      let lastCheck = first.start;
      set.reps.forEach((rep, repIndex) => {
        if (repIndex === 0 || repIndex === n - 1) return;
        if (rep.start - lastCheck < SET_CHECK_IN_SECONDS || last.start - rep.start < 2 * 60) return;
        lastCheck = rep.start;
        candidates.push({
          atSeconds: rep.start + 3,
          priority: 2,
          focus: `Rep ${repIndex + 1} of ${n}${setLabel}: ${describe(rep)}. Encourage and check form.`,
        });
      });
      if (n >= 3) {
        candidates.push({
          atSeconds: before(last),
          priority: 3,
          focus: `Last rep${setLabel} starts in ${EFFORT_LEAD_SECONDS} s: ${describe(last)}. Finish the set strong.`,
        });
      }
    }

    const after = set.after;
    if (!after) return;
    const isCooldown = set.isLast && segments.indexOf(after) === segments.length - 1 && after.duration <= 20 * 60;
    if (isCooldown) {
      candidates.push({
        atSeconds: after.start + 5,
        priority: 3,
        focus: "Cooldown starts: wrap up the session and tell the rider to spin easy.",
      });
    } else if (after.duration >= 90 && last.start + last.duration - first.start >= 2 * 60) {
      candidates.push({
        atSeconds: after.start + 5,
        priority: 1,
        focus: `Recovery after ${n > 1 ? `set ${setIndex + 1}` : `effort ${setIndex + 1}`} of ${sets.length}: recover fully before the next one.`,
      });
    }
  });

  // Highest priority first; skip any cue that crowds an accepted one.
  const accepted: Candidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.priority - a.priority || a.atSeconds - b.atSeconds)) {
    if (candidate.atSeconds >= duration) continue;
    if (accepted.some((cue) => Math.abs(cue.atSeconds - candidate.atSeconds) < MIN_CUE_GAP_SECONDS)) continue;
    accepted.push(candidate);
  }
  accepted.sort((a, b) => a.atSeconds - b.atSeconds);

  // Fill long silences (steady riding) with evenly spaced check-ins, at most ~15 min apart.
  const filled: CoachCue[] = [];
  const stopAt = duration - 5 * 60;
  accepted.forEach((candidate, i) => {
    const cue: CoachCue = { atSeconds: candidate.atSeconds, focus: candidate.focus };
    filled.push(cue);
    const nextAt = accepted[i + 1]?.atSeconds ?? stopAt;
    const gap = nextAt - cue.atSeconds;
    const count = Math.floor(gap / STEADY_CHECK_IN_SECONDS);
    for (let k = 1; k <= count; k += 1) {
      filled.push({
        atSeconds: cue.atSeconds + Math.round((gap * k) / (count + 1)),
        focus: "Steady-riding check-in: comment on heart-rate drift, cadence, fueling or posture.",
      });
    }
  });
  return filled;
}

/** The cues the player uses: the workout's own, or derived ones when it has none. */
export function resolveCoachCues(
  workout: { blocks: WorkoutBlock[]; coachCues?: CoachCue[] },
  ftp: number
): { cues: CoachCue[]; source: "workout" | "auto" } {
  const duration = totalSeconds(workout.blocks);
  const own = normalizeCoachCues(workout.coachCues, duration);
  if (own.length > 0) return { cues: own, source: "workout" };
  return { cues: deriveCoachCues(workout.blocks, ftp), source: "auto" };
}
