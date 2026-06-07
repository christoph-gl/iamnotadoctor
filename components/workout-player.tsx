"use client";

import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from "react";
import {
  WORKOUTS,
  Workout,
  WorkoutBlock,
  parseLLMWorkout,
  saveWorkout,
  deleteWorkout,
  getWorkoutLibrary,
  updateWorkout,
  parseZwoWorkout,
  calculateWorkoutMetrics,
  ADAPTIVE_FREERIDE,
  isAdaptiveFreeride,
  spliceUpcomingBlocks,
} from "@/lib/workouts";
import { WorkoutChart } from "./workout-chart";
import { Button } from "./ui/button";
import { Mic, Trash2 } from "lucide-react";
import { RIDER_PROFILE, type RiderProfile } from "@/lib/profile";
import { audioService } from "@/lib/audio";
import type { LiveCoachCommand } from "@/lib/live-coach-command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export type WorkoutPlayerHandle = {
  applyPlanCommand: (blocks: WorkoutBlock[], leadSeconds?: number) => void;
  applyErgOverrideUntilNextStep: (watts: number) => void;
  getRemainingWorkoutSnapshot: () => RemainingWorkoutSnapshot;
};

type WorkoutPlayerProps = {
  onPowerTargetChange: (watts: number) => void;
  onStopSession: (workoutName: string, riderComments?: string) => void;
  onWorkoutChange?: (workout: Workout) => void;
  manualControlMode?: "erg" | "resistance";
  disabled: boolean;
  power?: number;
  cadence?: number;
  heartRate?: number;
  currentHrZone?: RiderProfile["hrZones"][number];
  activeTrainerMode:
    | { type: "none" }
    | { type: "erg"; watts: number }
    | { type: "resistance"; level: number };
  riderProfile?: RiderProfile;
};

type WakeLockCapableNavigator = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<{ release: () => Promise<void> }>;
  };
};

type AdaptiveVoiceAudio = {
  base64: string;
  format: string;
  mimeType: string;
};

type TelemetrySnapshot = {
  offsetSeconds: number;
  durationSeconds: number;
  avgPowerW: number | null;
  avgCadenceRpm: number | null;
  avgHeartRateBpm: number | null;
  targetPower: number | null;
  hrZone: string | null;
};

function averageNullable(values: Array<number | undefined>) {
  const present = values.filter((value): value is number => typeof value === "number");
  if (present.length === 0) return null;
  return Math.round(present.reduce((total, value) => total + value, 0) / present.length);
}

type RemainingWorkoutSnapshot = {
  workoutId: string;
  workoutName: string;
  isPlaying: boolean;
  elapsedSeconds: number;
  totalDurationSeconds: number;
  remainingSeconds: number;
  currentTargetPower: number | null;
  currentBlockDurationSeconds: number | null;
  currentBlockElapsedSeconds: number | null;
  remainingBlocks: Array<{
    offsetSeconds: number;
    durationSeconds: number;
    targetPower: number;
    isCurrent: boolean;
  }>;
  truncated: boolean;
};

type AdaptiveRideIntent = {
  presetId: string;
  label: string;
  durationMinutes: number;
  feedbackIntervalMinutes: number;
  prompt: string;
  riderText: string;
};

const ADAPTIVE_RIDE_PRESETS: Array<{
  id: string;
  label: string;
  durationMinutes: number;
  prompt: string;
}> = [
  {
    id: "zone-2",
    label: "Zone 2 Ride",
    durationMinutes: 60,
    prompt:
      "Keep the rider in heart-rate Zone 2 for as long as possible. Adjust power gradually based on heart-rate drift, cadence, and perceived stability. Prefer steady endurance over power targets.",
  },
  {
    id: "hiit-45",
    label: "HIIT Ride",
    durationMinutes: 45,
    prompt:
      "Build an interval session with warmup, repeated hard efforts, recoveries, and cooldown. Use current vitals to avoid overreaching if heart rate or cadence suggests fatigue.",
  },
  {
    id: "tempo",
    label: "Tempo Builder",
    durationMinutes: 50,
    prompt:
      "Progress from easy endurance into controlled tempo, then cool down. Keep intensity below threshold unless vitals are unusually stable.",
  },
  {
    id: "recovery",
    label: "Recovery Spin",
    durationMinutes: 35,
    prompt:
      "Keep the ride easy and restorative. Lower power quickly if heart rate rises unexpectedly or cadence becomes unstable.",
  },
];

const DEFAULT_ADAPTIVE_RIDE_INTENT: AdaptiveRideIntent = {
  presetId: ADAPTIVE_RIDE_PRESETS[0].id,
  label: ADAPTIVE_RIDE_PRESETS[0].label,
  durationMinutes: ADAPTIVE_RIDE_PRESETS[0].durationMinutes,
  feedbackIntervalMinutes: 2,
  prompt: ADAPTIVE_RIDE_PRESETS[0].prompt,
  riderText: "",
};

const FIXED_TRACK_COACH_INTERVAL_OPTIONS = [1, 3, 5, 10, 15] as const;
const DEFAULT_FIXED_TRACK_COACH_INTERVAL_MINUTES = 5;
const ADAPTIVE_REWRITE_INTERVAL_OPTIONS = [null, 1, 2, 3, 5, 10, 15] as const;
const DEFAULT_ADAPTIVE_REWRITE_INTERVAL_MINUTES = DEFAULT_ADAPTIVE_RIDE_INTENT.feedbackIntervalMinutes;

function clampAdaptiveFeedbackInterval(minutes: number) {
  return Math.max(1, Math.min(15, Math.round(minutes)));
}

function chooseAdaptiveVoiceMimeType() {
  const preferredTypes = [
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];

  return preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function audioFormatFromMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("mp4")) return "m4a";
  if (normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("webm")) return "webm";
  return "webm";
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read audio."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.readAsDataURL(blob);
  });
}

export const WorkoutPlayer = forwardRef<WorkoutPlayerHandle, WorkoutPlayerProps>(function WorkoutPlayer(
  {
    onPowerTargetChange,
    onStopSession,
    onWorkoutChange,
    manualControlMode = "erg",
    disabled,
    power,
    cadence,
    heartRate,
    currentHrZone,
    activeTrainerMode,
    riderProfile = RIDER_PROFILE,
  },
  ref,
) {
  const [allWorkouts, setAllWorkouts] = useState<Workout[]>(WORKOUTS);
  const [workout, setWorkout] = useState<Workout>(WORKOUTS[0]);

  useEffect(() => {
    if (onWorkoutChange) {
      onWorkoutChange(workout);
    }
  }, [workout, onWorkoutChange]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isFinishOpen, setIsFinishOpen] = useState(false);
  const [finishComments, setFinishComments] = useState("");
  const [isBuilderOpen, setIsBuilderOpen] = useState(false);
  const [builderInstructions, setBuilderInstructions] = useState("");
  const [builderRationale, setBuilderRationale] = useState<string | null>(null);
  const [isAdaptiveSetupOpen, setIsAdaptiveSetupOpen] = useState(false);
  const [adaptiveRideIntent, setAdaptiveRideIntent] = useState<AdaptiveRideIntent>(
    DEFAULT_ADAPTIVE_RIDE_INTENT
  );
  const [adaptiveIntentDraft, setAdaptiveIntentDraft] = useState<AdaptiveRideIntent>(
    DEFAULT_ADAPTIVE_RIDE_INTENT
  );
  const [adaptiveDurationInput, setAdaptiveDurationInput] = useState(
    String(DEFAULT_ADAPTIVE_RIDE_INTENT.durationMinutes)
  );
  const [isBuildingWorkout, setIsBuildingWorkout] = useState(false);
  const [unsavedBuiltWorkoutId, setUnsavedBuiltWorkoutId] = useState<string | null>(null);
  const [isSavingBuiltWorkout, setIsSavingBuiltWorkout] = useState(false);
  const [deletingWorkoutId, setDeletingWorkoutId] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [currentTargetPower, setCurrentTargetPower] = useState<number | null>(null);
  const [actualPowerSamples, setActualPowerSamples] = useState<Array<{ elapsedSeconds: number; power?: number }>>([]);
  const [liveCoachFeedback, setLiveCoachFeedback] = useState<string | null>(null);
  const [liveCoachDetail, setLiveCoachDetail] = useState<string | null>(null);
  const [liveCoachStatus, setLiveCoachStatus] = useState<"idle" | "checking" | "error">("idle");
  const [fixedTrackCoachIntervalMinutes, setFixedTrackCoachIntervalMinutes] = useState(
    DEFAULT_FIXED_TRACK_COACH_INTERVAL_MINUTES
  );
  const [adaptiveRewriteIntervalMinutes, setAdaptiveRewriteIntervalMinutes] = useState<number | null>(
    DEFAULT_ADAPTIVE_REWRITE_INTERVAL_MINUTES
  );
  const [isListeningForAdaptiveInstruction, setIsListeningForAdaptiveInstruction] = useState(false);
  const [adaptiveVoiceRecordingSeconds, setAdaptiveVoiceRecordingSeconds] = useState(0);
  const [upcomingChange, setUpcomingChange] = useState<{ nextTarget: number, currentTarget: number, seconds: number } | null>(null);
  const lastTargetRef = useRef<number | null>(null);
  const elapsedSecondsRef = useRef(0);
  const telemetrySamplesRef = useRef<Array<{
    elapsedSeconds: number;
    power?: number;
    cadence?: number;
    heartRate?: number;
    targetPower: number | null;
    hrZoneName: string | null;
  }>>([]);
  const liveCoachRunningRef = useRef(false);
  const initialLiveCoachRequestedRef = useRef(false);
  const lastLiveCoachCheckSecondRef = useRef(0);
  const lastAdaptivePlanSecondRef = useRef(0);
  const recentLiveCoachFeedbackRef = useRef<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const rideGenerationRef = useRef(0);
  const coachSpeechRequestRef = useRef(0);
  const adaptiveVoiceRecorderRef = useRef<MediaRecorder | null>(null);
  const adaptiveVoiceStreamRef = useRef<MediaStream | null>(null);
  const adaptiveVoiceChunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zwoFileInputRef = useRef<HTMLInputElement>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const adaptive = isAdaptiveFreeride(workout);
  const isResistanceWorkoutMode = manualControlMode === "resistance" || activeTrainerMode.type === "resistance";
  const workoutPlanDuration = workout.blocks.reduce((acc, b) => acc + b.durationSeconds, 0);
  const adaptiveTargetDuration = Math.max(0, Math.round(adaptiveRideIntent.durationMinutes * 60));
  const adaptiveRewriteEnabled = adaptiveRewriteIntervalMinutes !== null;
  const adaptiveFeedbackIntervalSeconds = adaptiveRewriteEnabled
    ? clampAdaptiveFeedbackInterval(adaptiveRewriteIntervalMinutes) * 60
    : null;
  const fixedTrackCoachIntervalSeconds = fixedTrackCoachIntervalMinutes * 60;
  const totalDuration = adaptive ? adaptiveTargetDuration : workoutPlanDuration;

  useEffect(() => {
    elapsedSecondsRef.current = elapsedSeconds;
  }, [elapsedSeconds]);

  const clampPlanWatts = useCallback(
    (watts: number) => {
      const ceiling = Math.max(120, Math.round(riderProfile.fourDP.map * 1.2));
      return Math.max(40, Math.min(watts, ceiling));
    },
    [riderProfile.fourDP.map]
  );

  const applyPlanCommand = useCallback(
    (blocks: WorkoutBlock[], leadSeconds: number = 20) => {
      if (!Array.isArray(blocks) || blocks.length === 0) return;
      const safeBlocks: WorkoutBlock[] = blocks
        .map((b) => ({
          durationSeconds: Math.max(30, Math.round(Number(b.durationSeconds) || 0)),
          targetPower: clampPlanWatts(Math.round(Number(b.targetPower) || 0)),
        }))
        .filter((b) => b.durationSeconds > 0);
      if (safeBlocks.length === 0) return;

      setWorkout((prev) =>
        spliceUpcomingBlocks(prev, elapsedSecondsRef.current, leadSeconds, safeBlocks)
      );
    },
    [clampPlanWatts]
  );

  const mergeAdjacentBlocks = useCallback((blocks: WorkoutBlock[]) => {
    const merged: WorkoutBlock[] = [];
    for (const block of blocks) {
      if (block.durationSeconds <= 0) continue;
      const previous = merged[merged.length - 1];
      if (previous && previous.targetPower === block.targetPower) {
        previous.durationSeconds += block.durationSeconds;
      } else {
        merged.push({ ...block });
      }
    }
    return merged;
  }, []);

  const applyErgOverrideUntilNextStep = useCallback(
    (watts: number) => {
      const overrideWatts = clampPlanWatts(Math.round(Number(watts) || 0));
      const elapsed = Math.max(0, Math.round(elapsedSecondsRef.current));

      setWorkout((prev) => {
        let acc = 0;
        const nextBlocks: WorkoutBlock[] = [];
        let applied = false;

        for (const block of prev.blocks) {
          const blockStart = acc;
          const blockEnd = acc + block.durationSeconds;
          acc = blockEnd;

          if (applied || elapsed >= blockEnd) {
            nextBlocks.push(block);
            continue;
          }

          if (elapsed <= blockStart) {
            nextBlocks.push({ durationSeconds: block.durationSeconds, targetPower: overrideWatts });
            applied = true;
            continue;
          }

          nextBlocks.push({
            durationSeconds: elapsed - blockStart,
            targetPower: block.targetPower,
          });
          nextBlocks.push({
            durationSeconds: blockEnd - elapsed,
            targetPower: overrideWatts,
          });
          applied = true;
        }

        if (!applied) return prev;
        return { ...prev, blocks: mergeAdjacentBlocks(nextBlocks) };
      });

      lastTargetRef.current = overrideWatts;
    },
    [clampPlanWatts, mergeAdjacentBlocks]
  );

  const getRemainingWorkoutSnapshot = useCallback((): RemainingWorkoutSnapshot => {
    const elapsed = Math.max(0, Math.round(elapsedSeconds));
    const planDurationSeconds = workout.blocks.reduce(
      (total, block) => total + block.durationSeconds,
      0
    );
    const adaptiveTargetSeconds = Math.max(0, Math.round(adaptiveRideIntent.durationMinutes * 60));
    const totalDurationSeconds = adaptive
      ? elapsed >= adaptiveTargetSeconds
        ? Math.max(planDurationSeconds, elapsed)
        : adaptiveTargetSeconds
      : planDurationSeconds;
    const remainingBlocks: RemainingWorkoutSnapshot["remainingBlocks"] = [];
    let acc = 0;
    let offsetSeconds = 0;
    let currentTargetPower: number | null = null;
    let currentBlockDurationSeconds: number | null = null;
    let currentBlockElapsedSeconds: number | null = null;

    for (const block of workout.blocks) {
      const blockStart = acc;
      const blockEnd = acc + block.durationSeconds;
      acc = blockEnd;

      if (elapsed >= blockEnd) continue;
      if (blockStart >= totalDurationSeconds) break;

      const remainingStart = Math.max(elapsed, blockStart);
      const remainingEnd = Math.min(blockEnd, totalDurationSeconds);
      const durationSeconds = Math.max(0, remainingEnd - remainingStart);
      if (durationSeconds <= 0) continue;

      const isCurrent = elapsed >= blockStart && elapsed < blockEnd;
      if (isCurrent) {
        currentTargetPower = block.targetPower;
        currentBlockDurationSeconds = block.durationSeconds;
        currentBlockElapsedSeconds = elapsed - blockStart;
      }

      const previous = remainingBlocks[remainingBlocks.length - 1];
      if (previous && previous.targetPower === block.targetPower) {
        previous.durationSeconds += durationSeconds;
      } else {
        remainingBlocks.push({
          offsetSeconds,
          durationSeconds,
          targetPower: block.targetPower,
          isCurrent,
        });
      }
      offsetSeconds += durationSeconds;
    }

    return {
      workoutId: workout.id,
      workoutName: workout.name,
      isPlaying,
      elapsedSeconds: elapsed,
      totalDurationSeconds,
      remainingSeconds: Math.max(0, totalDurationSeconds - elapsed),
      currentTargetPower,
      currentBlockDurationSeconds,
      currentBlockElapsedSeconds,
      remainingBlocks: remainingBlocks.slice(0, 30),
      truncated: remainingBlocks.length > 30,
    };
  }, [adaptive, adaptiveRideIntent.durationMinutes, elapsedSeconds, isPlaying, workout]);

  useImperativeHandle(
    ref,
    () => ({
      applyPlanCommand,
      applyErgOverrideUntilNextStep,
      getRemainingWorkoutSnapshot,
    }),
    [applyErgOverrideUntilNextStep, applyPlanCommand, getRemainingWorkoutSnapshot]
  );

  // Wake Lock implementation
  const requestWakeLock = async () => {
    const wakeNavigator = navigator as WakeLockCapableNavigator;
    if (wakeNavigator.wakeLock) {
      try {
        wakeLockRef.current = await wakeNavigator.wakeLock.request("screen");
        console.log("Wake Lock active");
      } catch (err) {
        console.error(`${(err as Error).name}, ${(err as Error).message}`);
      }
    }
  };

  const releaseWakeLock = async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        console.log("Wake Lock released");
      } catch (err) {
        console.error(`${(err as Error).name}, ${(err as Error).message}`);
      }
    }
  };

  useEffect(() => {
    if (isPlaying) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }

    const handleVisibilityChange = async () => {
      if (wakeLockRef.current !== null && document.visibilityState === "visible") {
        await requestWakeLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      releaseWakeLock();
    };
  }, [isPlaying]);

  useEffect(() => {
    async function loadSaved() {
      const { savedWorkouts, deletedWorkoutIds } = await getWorkoutLibrary();
      const deletedIds = new Set(deletedWorkoutIds);
      const visibleWorkouts = [
        ADAPTIVE_FREERIDE,
        ...WORKOUTS.filter((savedWorkout) => !deletedIds.has(savedWorkout.id)),
        ...savedWorkouts.filter((savedWorkout) => !deletedIds.has(savedWorkout.id)),
      ];
      setAllWorkouts(visibleWorkouts);

      if (!visibleWorkouts.some((savedWorkout) => savedWorkout.id === workout.id)) {
        setWorkout(visibleWorkouts[0] ?? ADAPTIVE_FREERIDE);
      }
    }
    loadSaved();
  }, [workout.id]);

  useEffect(() => {
    return () => {
      if (adaptiveVoiceRecorderRef.current?.state === "recording") {
        adaptiveVoiceRecorderRef.current.stop();
      }
      adaptiveVoiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isPlaying) {
      interval = setInterval(() => {
        setElapsedSeconds(e => e + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isPlaying]);

  useEffect(() => {
    if (!isListeningForAdaptiveInstruction) return;

    setAdaptiveVoiceRecordingSeconds(0);
    const interval = setInterval(() => {
      setAdaptiveVoiceRecordingSeconds((seconds) => seconds + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [isListeningForAdaptiveInstruction]);

  useEffect(() => {
    if (!isPlaying) return;

    if (!adaptive && elapsedSeconds >= totalDuration) {
      setIsPlaying(false);
      setUpcomingChange(null);
      return;
    }

    let timeAcc = 0;
    let newBlockIndex = -1;

    for (let i = 0; i < workout.blocks.length; i++) {
      timeAcc += workout.blocks[i].durationSeconds;
      if (elapsedSeconds < timeAcc) {
        newBlockIndex = i;
        break;
      }
    }

    if (newBlockIndex === -1) {
      if (adaptive) {
        const fallbackTarget = currentTargetPower ?? lastTargetRef.current ?? ADAPTIVE_FREERIDE.blocks[0].targetPower;
        setWorkout((prev) => {
          const planEnd = prev.blocks.reduce((total, block) => total + block.durationSeconds, 0);
          if (elapsedSeconds < planEnd) return prev;
          return {
            ...prev,
            blocks: [
              ...prev.blocks,
              { durationSeconds: 10 * 60, targetPower: fallbackTarget },
            ],
          };
        });
        setUpcomingChange(null);
        return;
      }

      setIsPlaying(false);
      setUpcomingChange(null);
      return;
    }

    // Determine upcoming changes and play notification
    let accTime = 0;
    let foundUpcoming = false;
    for (let i = 0; i < workout.blocks.length; i++) {
      const blockStart = accTime;
      const blockEnd = accTime + workout.blocks[i].durationSeconds;
      accTime = blockEnd;
      
      if (i > newBlockIndex && workout.blocks[i].targetPower !== workout.blocks[newBlockIndex].targetPower) {
        const timeUntilNextChange = blockStart - elapsedSeconds;
        if (timeUntilNextChange > 0 && timeUntilNextChange <= 10) {
          setUpcomingChange({ 
            nextTarget: workout.blocks[i].targetPower, 
            currentTarget: workout.blocks[newBlockIndex].targetPower,
            seconds: timeUntilNextChange 
          });
          foundUpcoming = true;
          if (timeUntilNextChange === 10) {
            audioService.playNotification();
          }
        }
        break;
      }
    }
    if (!foundUpcoming) {
      setUpcomingChange(null);
    }

    const currentTarget = workout.blocks[newBlockIndex].targetPower;
    if (currentTarget !== lastTargetRef.current) {
      // Play change sounds if it's not the initial target setting
      if (lastTargetRef.current !== null) {
        if (currentTarget > lastTargetRef.current) {
          audioService.playAcceleration();
        } else if (currentTarget < lastTargetRef.current) {
          audioService.playDeceleration();
        }
      }
      lastTargetRef.current = currentTarget;
      setCurrentTargetPower(currentTarget);
      onPowerTargetChange(currentTarget);
    }
  }, [adaptive, currentTargetPower, elapsedSeconds, isPlaying, onPowerTargetChange, totalDuration, workout]);

  const handlePlayPause = () => {
    audioService.init();
    if (!isPlaying) {
      // Force immediate update on play
      let timeAcc = 0;
      let newBlockIndex = -1;
      for (let i = 0; i < workout.blocks.length; i++) {
        timeAcc += workout.blocks[i].durationSeconds;
        if (elapsedSeconds < timeAcc) {
          newBlockIndex = i;
          break;
        }
      }
      if (newBlockIndex !== -1) {
        const currentTarget = workout.blocks[newBlockIndex].targetPower;
        lastTargetRef.current = currentTarget;
        setCurrentTargetPower(currentTarget);
        onPowerTargetChange(currentTarget);
      }
    }
    setIsPlaying(!isPlaying);
  };

  const clearRideRuntimeState = () => {
    rideGenerationRef.current += 1;
    coachSpeechRequestRef.current += 1;
    liveCoachRunningRef.current = false;
    telemetrySamplesRef.current = [];
    initialLiveCoachRequestedRef.current = false;
    lastLiveCoachCheckSecondRef.current = 0;
    lastAdaptivePlanSecondRef.current = 0;
    recentLiveCoachFeedbackRef.current = [];
    setLiveCoachStatus("idle");
    setLiveCoachFeedback(null);
    setLiveCoachDetail(null);
  };

  const stopAdaptiveVoiceRecording = () => {
    adaptiveVoiceChunksRef.current = [];
    const recorder = adaptiveVoiceRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
    adaptiveVoiceRecorderRef.current = null;
    adaptiveVoiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    adaptiveVoiceStreamRef.current = null;
    setIsListeningForAdaptiveInstruction(false);
    setAdaptiveVoiceRecordingSeconds(0);
  };

  const handleStop = () => {
    setIsPlaying(false);
    setElapsedSeconds(0);
    setCurrentTargetPower(null);
    setActualPowerSamples([]);
    setUpcomingChange(null);
    lastTargetRef.current = null;
    clearRideRuntimeState();
  };

  const handleDiscardRide = () => {
    stopAdaptiveVoiceRecording();
    setFinishComments("");
    setIsFinishOpen(false);
    handleStop();
  };

  const openAdaptiveSetup = () => {
    setAdaptiveIntentDraft(adaptiveRideIntent);
    setAdaptiveDurationInput(String(adaptiveRideIntent.durationMinutes));
    setIsAdaptiveSetupOpen(true);
  };

  const handleAdaptivePresetSelect = (preset: (typeof ADAPTIVE_RIDE_PRESETS)[number]) => {
    setAdaptiveIntentDraft((current) => ({
      ...current,
      presetId: preset.id,
      label: preset.label,
      durationMinutes: preset.durationMinutes,
      prompt: preset.prompt,
    }));
    setAdaptiveDurationInput(String(preset.durationMinutes));
  };

  const handleLoadAdaptiveRide = () => {
    const parsedDuration = Number(adaptiveDurationInput);
    const safeDuration = Math.max(
      10,
      Math.min(
        240,
        Math.round(
          Number.isFinite(parsedDuration) && parsedDuration > 0
            ? parsedDuration
            : adaptiveIntentDraft.durationMinutes
        )
      )
    );
    const safeFeedbackInterval = clampAdaptiveFeedbackInterval(
      adaptiveRewriteIntervalMinutes ?? adaptiveIntentDraft.feedbackIntervalMinutes
    );
    setAdaptiveRideIntent({
      ...adaptiveIntentDraft,
      durationMinutes: safeDuration,
      feedbackIntervalMinutes: safeFeedbackInterval,
    });
    setAdaptiveDurationInput(String(safeDuration));
    setWorkout({
      ...ADAPTIVE_FREERIDE,
      blocks: [{ durationSeconds: safeDuration * 60, targetPower: ADAPTIVE_FREERIDE.blocks[0].targetPower }],
    });
    setUnsavedBuiltWorkoutId(null);
    setBuilderRationale(null);
    handleStop();
    setIsAdaptiveSetupOpen(false);
    setIsPickerOpen(false);
  };

  const handleFinishSession = () => {
    onStopSession(workout.name, finishComments.trim() || undefined);
    setFinishComments("");
    setIsFinishOpen(false);
    handleStop();
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/extract-workout", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to extract workout");
      }

      const llmWorkout = await res.json();
      const parsedWorkout = parseLLMWorkout(llmWorkout, riderProfile);

      await saveWorkout(parsedWorkout);
      setAllWorkouts(prev => [...prev, parsedWorkout]);
      setWorkout(parsedWorkout);
      setUnsavedBuiltWorkoutId(null);
      setBuilderRationale(null);
      handleStop();
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleZwoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsedWorkout = parseZwoWorkout(text, riderProfile);

      await saveWorkout(parsedWorkout);
      setAllWorkouts(prev => [...prev, parsedWorkout]);
      setWorkout(parsedWorkout);
      setUnsavedBuiltWorkoutId(null);
      setBuilderRationale(null);
      handleStop();
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "Failed to parse ZWO file");
    } finally {
      if (zwoFileInputRef.current) zwoFileInputRef.current.value = "";
    }
  };

  const handleBuildWorkout = async () => {
    const instructions = builderInstructions.trim();
    if (!instructions || isBuildingWorkout) return;

    setIsBuildingWorkout(true);
    setBuilderRationale(null);
    try {
      const res = await fetch("/api/workout-builder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || "Failed to build workout");
      }

      const generatedWorkout = data.workout as Workout;
      setWorkout(generatedWorkout);
      setBuilderRationale(typeof data.rationale === "string" ? data.rationale : null);
      setUnsavedBuiltWorkoutId(generatedWorkout.id);
      setBuilderInstructions("");
      setIsBuilderOpen(false);
      setIsPickerOpen(false);
      handleStop();
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBuildingWorkout(false);
    }
  };

  const handleSaveBuiltWorkout = async () => {
    if (!unsavedBuiltWorkoutId || workout.id !== unsavedBuiltWorkoutId || isSavingBuiltWorkout) return;

    setIsSavingBuiltWorkout(true);
    try {
      await saveWorkout(workout);
      setAllWorkouts((prev) =>
        prev.some((savedWorkout) => savedWorkout.id === workout.id)
          ? prev
          : [...prev, workout]
      );
      setUnsavedBuiltWorkoutId(null);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSavingBuiltWorkout(false);
    }
  };

  const handleDeleteWorkout = async (target: Workout) => {
    if (deletingWorkoutId) return;
    const confirmed = window.confirm(`Delete "${target.name}"?`);
    if (!confirmed) return;

    setDeletingWorkoutId(target.id);
    try {
      await deleteWorkout(target.id);
      const remainingWorkouts = allWorkouts.filter((savedWorkout) => savedWorkout.id !== target.id);
      setAllWorkouts(remainingWorkouts);

      if (workout.id === target.id) {
        const fallback = remainingWorkouts[0] ?? ADAPTIVE_FREERIDE;
        setWorkout(fallback);
        setUnsavedBuiltWorkoutId(null);
        setBuilderRationale(null);
        handleStop();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setDeletingWorkoutId(null);
    }
  };

  const handleSeek = (seconds: number) => {
    setElapsedSeconds(seconds);
    let timeAcc = 0;
    let newBlockIndex = -1;
    for (let i = 0; i < workout.blocks.length; i++) {
      timeAcc += workout.blocks[i].durationSeconds;
      if (seconds < timeAcc) {
        newBlockIndex = i;
        break;
      }
    }
    if (newBlockIndex !== -1) {
      const currentTarget = workout.blocks[newBlockIndex].targetPower;
      lastTargetRef.current = currentTarget;
      setCurrentTargetPower(currentTarget);
      onPowerTargetChange(currentTarget);
    } else {
      handleStop();
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatShortDuration = (seconds: number) => {
    const safeSeconds = Math.max(0, Math.round(seconds));
    const m = Math.floor(safeSeconds / 60);
    const s = safeSeconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const speakCoachText = useCallback(async (text: string) => {
    const requestId = coachSpeechRequestRef.current + 1;
    coachSpeechRequestRef.current = requestId;

    try {
      const response = await fetch("/api/coach/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || "Coach speech failed");
      }

      const audio = await response.arrayBuffer();
      if (coachSpeechRequestRef.current !== requestId) return;
      await audioService.playArrayBuffer(audio);
    } catch (err) {
      console.warn("Coach speech unavailable:", err);
    }
  }, []);

  const buildTelemetrySnapshots = useCallback((): TelemetrySnapshot[] => {
    const samples = telemetrySamplesRef.current;
    if (samples.length === 0) return [];

    const windowSeconds = 30;
    const firstBucket = Math.floor(samples[0].elapsedSeconds / windowSeconds) * windowSeconds;
    const lastBucket = Math.floor(samples[samples.length - 1].elapsedSeconds / windowSeconds) * windowSeconds;
    const snapshots: TelemetrySnapshot[] = [];

    for (let bucketStart = firstBucket; bucketStart <= lastBucket; bucketStart += windowSeconds) {
      const bucketSamples = samples.filter(
        (sample) =>
          sample.elapsedSeconds >= bucketStart &&
          sample.elapsedSeconds < bucketStart + windowSeconds
      );
      if (bucketSamples.length === 0) continue;

      const lastSample = bucketSamples[bucketSamples.length - 1];
      snapshots.push({
        offsetSeconds: bucketStart,
        durationSeconds: Math.min(windowSeconds, bucketSamples.length),
        avgPowerW: averageNullable(bucketSamples.map((sample) => sample.power)),
        avgCadenceRpm: averageNullable(bucketSamples.map((sample) => sample.cadence)),
        avgHeartRateBpm: averageNullable(bucketSamples.map((sample) => sample.heartRate)),
        targetPower: lastSample.targetPower,
        hrZone: lastSample.hrZoneName,
      });
    }

    return snapshots.slice(-20);
  }, []);

  const applyAdaptiveInstructionAction = useCallback(
    (action: unknown) => {
      if (!action || typeof action !== "object") return;
      const update = action as {
        action?: string;
        label?: unknown;
        durationMinutes?: unknown;
        feedbackIntervalMinutes?: unknown;
        prompt?: unknown;
        riderText?: unknown;
        blocks?: WorkoutBlock[];
        leadSeconds?: unknown;
      };

      if (update.action !== "update_adaptive_ride") return;

      setAdaptiveRideIntent((current) => {
        const nextDuration =
          typeof update.durationMinutes === "number" && Number.isFinite(update.durationMinutes)
            ? Math.max(10, Math.min(240, Math.round(update.durationMinutes)))
            : current.durationMinutes;
        const nextFeedbackInterval =
          typeof update.feedbackIntervalMinutes === "number" &&
          Number.isFinite(update.feedbackIntervalMinutes)
            ? clampAdaptiveFeedbackInterval(update.feedbackIntervalMinutes)
            : current.feedbackIntervalMinutes;

        return {
          ...current,
          label: typeof update.label === "string" && update.label.trim() ? update.label.trim() : current.label,
          durationMinutes: nextDuration,
          feedbackIntervalMinutes: nextFeedbackInterval,
          prompt: typeof update.prompt === "string" && update.prompt.trim() ? update.prompt.trim() : current.prompt,
          riderText:
            typeof update.riderText === "string" && update.riderText.trim()
              ? update.riderText.trim()
              : current.riderText,
        };
      });
      if (
        typeof update.feedbackIntervalMinutes === "number" &&
        Number.isFinite(update.feedbackIntervalMinutes)
      ) {
        setAdaptiveRewriteIntervalMinutes(clampAdaptiveFeedbackInterval(update.feedbackIntervalMinutes));
      }

      if (Array.isArray(update.blocks) && update.blocks.length > 0) {
        const leadSeconds =
          typeof update.leadSeconds === "number" && Number.isFinite(update.leadSeconds)
            ? update.leadSeconds
            : 0;
        applyPlanCommand(update.blocks, leadSeconds);
      }
    },
    [applyPlanCommand]
  );

  const applyLiveCoachCommand = useCallback(
    (command: LiveCoachCommand | null | undefined, allowTrainerChanges: boolean) => {
      if (!command || !allowTrainerChanges) return;

      if (command.type === "set_workout_plan") {
        applyPlanCommand(command.blocks, command.leadSeconds ?? 5);
        return;
      }

      if (command.type === "set_erg_watts") {
        applyErgOverrideUntilNextStep(command.watts);
        onPowerTargetChange(command.watts);
        return;
      }

      if (command.type === "set_trainer_mode" && command.mode === "erg") {
        applyErgOverrideUntilNextStep(command.targetWatts);
        onPowerTargetChange(command.targetWatts);
      }
    },
    [applyErgOverrideUntilNextStep, applyPlanCommand, onPowerTargetChange]
  );

  const requestLiveCoachCheck = useCallback(async (
    intent: "ride_start_summary" | "periodic_ride_check" | "adaptive_plan" | "adaptive_instruction",
    riderTextOverride?: string,
    voiceAudio?: AdaptiveVoiceAudio
  ) => {
    if (liveCoachRunningRef.current) return;
    const requestRideGeneration = rideGenerationRef.current;
    liveCoachRunningRef.current = true;
    setLiveCoachStatus("checking");

    try {
      const remainingWorkout = getRemainingWorkoutSnapshot();
      const telemetrySnapshots = buildTelemetrySnapshots();
      const latestSnapshot = telemetrySamplesRef.current[telemetrySamplesRef.current.length - 1] ?? null;
      const snapshotAdaptiveRideIntent =
        intent === "adaptive_plan" || intent === "adaptive_instruction"
          ? {
              ...adaptiveRideIntent,
              riderText: riderTextOverride?.trim() || adaptiveRideIntent.riderText,
            }
          : null;
      // Record the rider's turn in conversation history before sending
      if (riderTextOverride?.trim()) {
        recentLiveCoachFeedbackRef.current = [
          ...recentLiveCoachFeedbackRef.current,
          { role: "user" as const, text: riderTextOverride.trim() },
        ].slice(-8);
      }

      const response = await fetch("/api/coach/live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent,
          conversationHistory: recentLiveCoachFeedbackRef.current,
          riderText: riderTextOverride?.trim() || undefined,
          audioBase64: voiceAudio?.base64,
          audioFormat: voiceAudio?.format,
          audioMimeType: voiceAudio?.mimeType,
          snapshot: {
            generatedAtIso: new Date().toISOString(),
            workoutName: workout.name,
            latestSample: latestSnapshot
              ? {
                  powerW: latestSnapshot.power,
                  cadenceRpm: latestSnapshot.cadence,
                  heartRateBpm: latestSnapshot.heartRate,
                }
              : null,
            currentHrZone: currentHrZone
              ? {
                  id: currentHrZone.id,
                  name: currentHrZone.name,
                  minBpm: currentHrZone.minBpm,
                  maxBpm: currentHrZone.maxBpm,
                }
              : null,
            activeTrainerMode,
            adaptivePlanHorizonSeconds:
              intent === "adaptive_plan" || intent === "adaptive_instruction" ? 10 * 60 : null,
            adaptiveRideIntent: snapshotAdaptiveRideIntent,
            riderProfile: {
              fourDP: riderProfile.fourDP,
              cTHR: riderProfile.cTHR,
              age: riderProfile.age,
              weightKg: riderProfile.weightKg,
              gender: riderProfile.gender,
              hrZones: riderProfile.hrZones.map((zone) => ({
                id: zone.id,
                name: zone.name,
                percentageRange: zone.percentageRange,
                minBpm: zone.minBpm,
                maxBpm: zone.maxBpm,
              })),
              memorySummary: riderProfile.memorySummary || null,
            },
            rolling: {
              sampleWindowSeconds: 30,
              snapshots: telemetrySnapshots,
              rideSoFar: {
                elapsedSeconds,
                avgPowerW: averageNullable(telemetrySamplesRef.current.map((sample) => sample.power)),
                avgCadenceRpm: averageNullable(telemetrySamplesRef.current.map((sample) => sample.cadence)),
                avgHeartRateBpm: averageNullable(telemetrySamplesRef.current.map((sample) => sample.heartRate)),
              },
            },
            remainingWorkout,
          },
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || "Live coach check failed");
      }
      if (requestRideGeneration !== rideGenerationRef.current) return;

      const text =
        typeof data?.action?.text === "string" && data.action.text.trim()
          ? data.action.text.trim()
          : typeof data?.command?.text === "string" && data.command.text.trim()
            ? data.command.text.trim()
            : null;

      if (text) {
        setLiveCoachFeedback(text);
        setLiveCoachDetail(null);
        recentLiveCoachFeedbackRef.current = [
          ...recentLiveCoachFeedbackRef.current,
          { role: "assistant" as const, text },
        ].slice(-8);
        audioService.playCoachMessage();
        void speakCoachText(text);
      }
      if (intent === "adaptive_instruction") {
        applyAdaptiveInstructionAction(data?.action);
      }
      applyLiveCoachCommand(data?.command, intent === "adaptive_plan" || intent === "adaptive_instruction");
      if (text) {
        setLiveCoachDetail(null);
      } else if (typeof data?.action?.reason === "string") {
        setLiveCoachDetail(data.action.reason);
      } else if (typeof data?.command?.reason === "string") {
        setLiveCoachDetail(data.command.reason);
      }
      setLiveCoachStatus("idle");
    } catch (err) {
      if (requestRideGeneration !== rideGenerationRef.current) return;
      console.error(err);
      setLiveCoachStatus("error");
      setLiveCoachDetail(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestRideGeneration === rideGenerationRef.current) {
        liveCoachRunningRef.current = false;
      }
    }
  }, [
    activeTrainerMode,
    adaptiveRideIntent,
    applyAdaptiveInstructionAction,
    applyLiveCoachCommand,
    buildTelemetrySnapshots,
    currentHrZone,
    elapsedSeconds,
    getRemainingWorkoutSnapshot,
    riderProfile,
    speakCoachText,
    workout.name,
  ]);

  const handleAdaptiveRewriteIntervalSelect = (minutes: number | null) => {
    setAdaptiveRewriteIntervalMinutes(minutes);
    if (minutes === null) {
      rideGenerationRef.current += 1;
      coachSpeechRequestRef.current += 1;
      stopAdaptiveVoiceRecording();
      liveCoachRunningRef.current = false;
      lastAdaptivePlanSecondRef.current = elapsedSeconds;
      setLiveCoachStatus("idle");
      setLiveCoachDetail(null);
      return;
    }

    const safeMinutes = clampAdaptiveFeedbackInterval(minutes);
    setAdaptiveRideIntent((current) => ({
      ...current,
      feedbackIntervalMinutes: safeMinutes,
    }));
  };

  const startAdaptiveVoiceInstruction = useCallback(() => {
    if (!adaptive || !adaptiveRewriteEnabled) return;

    if (isListeningForAdaptiveInstruction) {
      adaptiveVoiceRecorderRef.current?.stop();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      alert("Microphone recording is not available in this browser.");
      return;
    }

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = chooseAdaptiveVoiceMimeType();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

        adaptiveVoiceRecorderRef.current = recorder;
        adaptiveVoiceStreamRef.current = stream;
        adaptiveVoiceChunksRef.current = [];

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            adaptiveVoiceChunksRef.current.push(event.data);
          }
        };

        recorder.onerror = () => {
          setIsListeningForAdaptiveInstruction(false);
          setAdaptiveVoiceRecordingSeconds(0);
          setLiveCoachStatus("error");
          setLiveCoachDetail("Voice recording failed.");
          stream.getTracks().forEach((track) => track.stop());
        };

        recorder.onstop = () => {
          setIsListeningForAdaptiveInstruction(false);
          setAdaptiveVoiceRecordingSeconds(0);
          stream.getTracks().forEach((track) => track.stop());
          adaptiveVoiceRecorderRef.current = null;
          adaptiveVoiceStreamRef.current = null;

          const chunks = adaptiveVoiceChunksRef.current;
          adaptiveVoiceChunksRef.current = [];
          if (chunks.length === 0) {
            setLiveCoachStatus("idle");
            setLiveCoachDetail(null);
            return;
          }

          void (async () => {
            try {
              setLiveCoachStatus("checking");
              setLiveCoachFeedback("Voice instruction recorded.");
              setLiveCoachDetail("Sending audio to live coach.");
              const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
              const audioBase64 = await blobToBase64(blob);
              const voiceAudio = {
                base64: audioBase64,
                format: audioFormatFromMimeType(blob.type),
                mimeType: blob.type,
              };

              setAdaptiveRideIntent((current) => ({
                ...current,
                riderText: "Voice instruction",
              }));
              lastAdaptivePlanSecondRef.current = elapsedSeconds;
              void requestLiveCoachCheck("adaptive_instruction", "Voice instruction", voiceAudio);
            } catch (err) {
              setLiveCoachStatus("error");
              setLiveCoachDetail(err instanceof Error ? err.message : String(err));
            }
          })();
        };

        setLiveCoachStatus("checking");
        setLiveCoachFeedback(null);
        setLiveCoachDetail("Recording adaptive instruction. Click the mic again to stop.");
        setIsListeningForAdaptiveInstruction(true);
        setAdaptiveVoiceRecordingSeconds(0);
        recorder.start();
      } catch (err) {
        setIsListeningForAdaptiveInstruction(false);
        setAdaptiveVoiceRecordingSeconds(0);
        setLiveCoachStatus("error");
        setLiveCoachDetail(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [
    adaptive,
    adaptiveRewriteEnabled,
    elapsedSeconds,
    isListeningForAdaptiveInstruction,
    requestLiveCoachCheck,
  ]);

  useEffect(() => {
    if (!isPlaying) return;

    if (!adaptive && elapsedSeconds === 0 && !initialLiveCoachRequestedRef.current) {
      initialLiveCoachRequestedRef.current = true;
      void requestLiveCoachCheck("ride_start_summary");
      return;
    }

    if (elapsedSeconds <= 0) return;

    telemetrySamplesRef.current.push({
      elapsedSeconds,
      power,
      cadence,
      heartRate,
      targetPower: getRemainingWorkoutSnapshot().currentTargetPower,
      hrZoneName: currentHrZone?.name ?? null,
    });
    telemetrySamplesRef.current = telemetrySamplesRef.current.filter(
      (sample) => elapsedSeconds - sample.elapsedSeconds <= 10 * 60
    );
    setActualPowerSamples((samples) => [
      ...samples.filter((sample) => sample.elapsedSeconds < elapsedSeconds),
      { elapsedSeconds, power },
    ]);

    if (adaptive) {
      if (!adaptiveRewriteEnabled || adaptiveFeedbackIntervalSeconds === null) return;

      const shouldRequestAdaptivePlan =
        elapsedSeconds >= 30 &&
        (elapsedSeconds === 30 ||
          elapsedSeconds - lastAdaptivePlanSecondRef.current >= adaptiveFeedbackIntervalSeconds);

      if (shouldRequestAdaptivePlan && lastAdaptivePlanSecondRef.current !== elapsedSeconds) {
        lastAdaptivePlanSecondRef.current = elapsedSeconds;
        void requestLiveCoachCheck("adaptive_plan");
      }
      return;
    }

    if (
      elapsedSeconds >= fixedTrackCoachIntervalSeconds &&
      elapsedSeconds - lastLiveCoachCheckSecondRef.current >= fixedTrackCoachIntervalSeconds &&
      lastLiveCoachCheckSecondRef.current !== elapsedSeconds
    ) {
      lastLiveCoachCheckSecondRef.current = elapsedSeconds;
      void requestLiveCoachCheck("periodic_ride_check");
    }
  }, [
    adaptive,
    adaptiveRewriteEnabled,
    adaptiveFeedbackIntervalSeconds,
    cadence,
    currentHrZone,
    elapsedSeconds,
    fixedTrackCoachIntervalSeconds,
    getRemainingWorkoutSnapshot,
    heartRate,
    isPlaying,
    power,
    requestLiveCoachCheck,
  ]);

  useEffect(() => {
    if (elapsedSeconds === 0) {
      telemetrySamplesRef.current = [];
      initialLiveCoachRequestedRef.current = false;
      lastLiveCoachCheckSecondRef.current = 0;
      lastAdaptivePlanSecondRef.current = 0;
      recentLiveCoachFeedbackRef.current = [];
      liveCoachRunningRef.current = false;
      setLiveCoachStatus("idle");
      setLiveCoachFeedback(null);
      setLiveCoachDetail(null);
    }
  }, [elapsedSeconds]);

  const renderBuilderDialogContent = () => (
    <DialogContent className="sm:max-w-xl rounded-md">
      <DialogHeader>
        <DialogTitle>Build Ride</DialogTitle>
        <DialogDescription>
          Describe today&apos;s workout target.
        </DialogDescription>
      </DialogHeader>
      <textarea
        value={builderInstructions}
        onChange={(event) => setBuilderInstructions(event.target.value)}
        placeholder="Example: 45 minutes endurance, mostly Z2, keep it gentle because HR ran high last ride."
        className="min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <DialogFooter>
        <Button
          variant="outline"
          onClick={() => setIsBuilderOpen(false)}
          disabled={isBuildingWorkout}
        >
          Cancel
        </Button>
        <Button
          onClick={handleBuildWorkout}
          disabled={!builderInstructions.trim() || isBuildingWorkout}
        >
          {isBuildingWorkout ? "Building..." : "Build & Load"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );

  const renderAdaptiveSetupDialogContent = () => (
    <DialogContent className="sm:max-w-2xl rounded-md">
      <DialogHeader>
        <DialogTitle>Adaptive Freeride</DialogTitle>
        <DialogDescription>
          Set the intent the live coach should adapt around.
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ADAPTIVE_RIDE_PRESETS.map((preset) => {
          const selected = adaptiveIntentDraft.presetId === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => handleAdaptivePresetSelect(preset)}
              className={`rounded-md border p-3 text-left transition-colors ${
                selected ? "border-primary bg-primary/5" : "bg-card hover:bg-muted/30"
              }`}
            >
              <span className={`block text-sm font-bold ${selected ? "text-primary" : ""}`}>
                {preset.label}
              </span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                {preset.prompt}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-3">
        <div className="grid gap-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="adaptive-duration">
            Ride duration
          </label>
          <div className="flex items-center gap-2">
            <input
              id="adaptive-duration"
              type="number"
              min={10}
              max={240}
              step={5}
              value={adaptiveDurationInput}
              onChange={(event) => {
                const nextValue = event.target.value;
                setAdaptiveDurationInput(nextValue);
                const nextNumber = Number(nextValue);
                if (!Number.isFinite(nextNumber)) return;
                setAdaptiveIntentDraft((current) => ({
                  ...current,
                  durationMinutes: nextNumber,
                }));
              }}
              className="h-9 w-24 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <span className="text-sm text-muted-foreground">minutes</span>
          </div>
        </div>
      </div>

      <div className="grid gap-2">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="adaptive-notes">
          Ride notes
        </label>
        <textarea
          id="adaptive-notes"
          value={adaptiveIntentDraft.riderText}
          onChange={(event) =>
            setAdaptiveIntentDraft((current) => ({ ...current, riderText: event.target.value }))
          }
          placeholder="Example: keep me below 150 bpm, or make it hard if HR stays controlled."
          className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => setIsAdaptiveSetupOpen(false)}>
          Cancel
        </Button>
        <Button onClick={handleLoadAdaptiveRide} disabled={isPlaying}>
          Load Adaptive Ride
        </Button>
      </DialogFooter>
    </DialogContent>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-2xl font-bold">Workout Player</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsPickerOpen(true)}
              className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/20 px-3 py-1.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Select workout"
            >
              <span className="max-w-[250px] truncate text-sm font-bold">{workout.name}</span>
              <span className="text-xs text-muted-foreground" aria-hidden="true">▾</span>
            </button>
            {/* Adaptive Freeride ticker removed */}
            {workout.id.startsWith("imported-") && (
              <button
                className="text-muted-foreground hover:text-foreground transition-colors"
                onClick={async () => {
                  const newName = prompt("Enter new name for this workout:", workout.name);
                  if (newName && newName.trim() !== "") {
                    const updated = { ...workout, name: newName.trim() };
                    await updateWorkout(updated);
                    setWorkout(updated);
                    setAllWorkouts(prev => prev.map(w => w.id === updated.id ? updated : w));
                  }
                }}
                disabled={isPlaying || isUploading}
                title="Rename Workout"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
              </button>
            )}
          </div>
        </div>
        <div className="flex gap-2 items-center">
          <Button
            variant={adaptive ? "default" : "outline"}
            size="sm"
            onClick={openAdaptiveSetup}
            disabled={isPlaying}
            title="Choose an adaptive ride intent."
          >
            {adaptive ? adaptiveRideIntent.label : "Adaptive Freeride"}
          </Button>
          <Dialog open={isAdaptiveSetupOpen} onOpenChange={setIsAdaptiveSetupOpen}>
            {renderAdaptiveSetupDialogContent()}
          </Dialog>
          <Dialog open={isBuilderOpen} onOpenChange={setIsBuilderOpen}>
            <DialogTrigger asChild>
              <Button
                variant="default"
                size="sm"
                disabled={isPlaying || isUploading || isBuildingWorkout}
              >
                Build Ride
              </Button>
            </DialogTrigger>
            {renderBuilderDialogContent()}
          </Dialog>
          <Dialog open={isPickerOpen} onOpenChange={setIsPickerOpen}>
            <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
              <DialogHeader className="p-6 pb-2 flex flex-row items-center justify-between space-y-0">
                <div>
                  <DialogTitle>Select Workout</DialogTitle>
                  <DialogDescription>
                    Choose from built-in or imported workouts.
                  </DialogDescription>
                </div>
                <div className="flex gap-2 pr-6">
                  <input 
                    type="file" 
                    accept="image/*" 
                    className="hidden" 
                    ref={fileInputRef} 
                    onChange={handleUpload} 
                  />
                  <Button 
                    variant="secondary" 
                    size="sm" 
                    onClick={() => fileInputRef.current?.click()} 
                    disabled={isPlaying || isUploading}
                  >
                    {isUploading ? "Extracting..." : "Import Image"}
                  </Button>

                  <input 
                    type="file" 
                    accept=".zwo" 
                    className="hidden" 
                    ref={zwoFileInputRef} 
                    onChange={handleZwoUpload} 
                  />
                  <Button 
                    variant="secondary" 
                    size="sm" 
                    onClick={() => zwoFileInputRef.current?.click()} 
                    disabled={isPlaying}
                  >
                    Import ZWO
                  </Button>
                </div>
              </DialogHeader>

              <div className="flex-1 overflow-y-auto p-6 pt-2 flex flex-col gap-3">
                {allWorkouts.map((w) => {
                  const metrics = calculateWorkoutMetrics(w, riderProfile.fourDP.ftp);
                  const duration = w.blocks.reduce((acc, b) => acc + b.durationSeconds, 0);
                  const isActive = workout.id === w.id;
                  const isDeleting = deletingWorkoutId === w.id;

                  return (
                    <div 
                      key={w.id} 
                      className={`flex flex-col gap-3 p-4 border rounded-md cursor-pointer transition-all hover:border-primary/50 group ${
                        isActive ? "bg-primary/5 border-primary shadow-sm" : "bg-card hover:bg-muted/30"
                      }`}
                      onClick={() => {
                        if (isAdaptiveFreeride(w)) {
                          setIsPickerOpen(false);
                          openAdaptiveSetup();
                          return;
                        }
                        setWorkout(w);
                        setUnsavedBuiltWorkoutId(null);
                        setBuilderRationale(null);
                        handleStop();
                        setIsPickerOpen(false);
                      }}
                    >
                      <div className="flex justify-between items-start gap-3">
                        <div className="flex flex-col gap-0.5">
                          <span className={`font-bold text-base ${isActive ? "text-primary" : ""}`}>
                            {w.name}
                          </span>
                          <div className="flex gap-4 text-xs text-muted-foreground font-medium">
                            <span className="flex gap-1 items-center">
                              <span className="opacity-70">Duration:</span>
                              <span className="font-mono text-foreground">{Math.floor(duration / 60)}m</span>
                            </span>
                            <span className="flex gap-1 items-center">
                              <span className="opacity-70">TSS:</span>
                              <span className="font-mono text-foreground">{Math.round(metrics.tss)}</span>
                            </span>
                            <span className="flex gap-1 items-center">
                              <span className="opacity-70">IF:</span>
                              <span className="font-mono text-foreground">{metrics.iff.toFixed(2)}</span>
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {isActive && (
                            <div className="px-2 py-0.5 bg-primary text-[10px] text-primary-foreground font-bold rounded-full uppercase tracking-wider">
                              Active
                            </div>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={isPlaying || isDeleting}
                            title="Delete workout"
                            aria-label={`Delete ${w.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDeleteWorkout(w);
                            }}
                            className="text-muted-foreground opacity-100 hover:bg-destructive/10 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </div>
                      <WorkoutChart workout={w} progressSeconds={0} preview={true} riderProfile={riderProfile} />
                    </div>
                  );
                })}
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <WorkoutChart
        workout={workout}
        progressSeconds={elapsedSeconds}
        onSeek={handleSeek}
        riderProfile={riderProfile}
        actualPowerSamples={actualPowerSamples}
      />

      {builderRationale && (
        <div className="flex flex-col gap-3 rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mb-1 font-bold uppercase tracking-wider text-foreground">
                Builder Rationale
              </div>
              {builderRationale}
            </div>
            {unsavedBuiltWorkoutId === workout.id && (
              <Button
                size="sm"
                onClick={handleSaveBuiltWorkout}
                disabled={isSavingBuiltWorkout}
                className="shrink-0"
              >
                {isSavingBuiltWorkout ? "Saving..." : "Save Track"}
              </Button>
            )}
          </div>
          {unsavedBuiltWorkoutId === workout.id && (
            <p className="text-[10px] text-muted-foreground">
              This AI-built ride is loaded as a draft. Save it to keep it in Change Workout.
            </p>
          )}
        </div>
      )}      {/* Integrated Telemetry & Control Console */}
      <div className="flex flex-col rounded-md border bg-card shadow-sm overflow-hidden">
        {/* Telemetry Grid */}
        <div className="p-4 grid grid-cols-3 gap-4 text-center divide-x divide-border/60">
          <div className="flex flex-col items-center">
            <span className="text-xs text-muted-foreground uppercase font-bold tracking-wider h-8 flex flex-col items-center justify-end pb-1 gap-0.5">
              <span>Power</span>
              {activeTrainerMode.type === "erg" && (
                <span className="text-[10px] text-primary normal-case font-medium leading-none">
                  Target: {activeTrainerMode.watts}W
                </span>
              )}
              {isResistanceWorkoutMode && currentTargetPower !== null && (
                <span className="text-[10px] text-primary normal-case font-medium leading-none">
                  Target: {currentTargetPower}W
                </span>
              )}
            </span>
            <span className="text-3xl font-bold font-mono tracking-tight mt-1">{power ?? "-"} <span className="text-sm font-normal text-muted-foreground">W</span></span>
            {isResistanceWorkoutMode && currentTargetPower !== null && typeof power === "number" && (
              <span className={`mt-1 text-xs font-semibold ${Math.abs(power - currentTargetPower) <= Math.max(8, currentTargetPower * 0.05) ? "text-green-400" : power > currentTargetPower ? "text-orange-400" : "text-blue-300"}`}>
                {power > currentTargetPower ? "+" : ""}{Math.round(power - currentTargetPower)} W
              </span>
            )}
            
            <div className="h-6 w-full mt-1.5">
              {upcomingChange && (
                <div className="flex flex-col items-center w-full max-w-[100px] mx-auto gap-1">
                  <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-1000 ease-linear ${upcomingChange.nextTarget > upcomingChange.currentTarget ? 'bg-orange-500' : 'bg-blue-400'}`} 
                      style={{ width: `${(upcomingChange.seconds / 10) * 100}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-wider leading-none">
                    <span className={upcomingChange.nextTarget > upcomingChange.currentTarget ? 'text-orange-500' : 'text-blue-400'}>
                      {upcomingChange.nextTarget > upcomingChange.currentTarget ? '▲' : '▼'} {upcomingChange.nextTarget}W
                    </span>
                    <span className="ml-1 opacity-70">in {upcomingChange.seconds}s</span>
                  </span>
                </div>
              )}
            </div>
          </div>
          
          <div className="flex flex-col items-center">
            <span className="text-xs text-muted-foreground uppercase font-bold tracking-wider h-8 flex flex-col items-center justify-end pb-1">
              Cadence
            </span>
            <span className="text-3xl font-bold font-mono tracking-tight mt-1">{cadence ?? "-"} <span className="text-sm font-normal text-muted-foreground">rpm</span></span>
          </div>

          <div className="flex flex-col items-center">
            <span className="text-xs text-muted-foreground uppercase font-bold tracking-wider h-8 flex flex-col items-center justify-end pb-1 gap-0.5">
              <span>HR</span>
              {currentHrZone && (
                <span 
                  className="text-[10px] normal-case font-medium leading-none"
                  style={{ color: currentHrZone.color }}
                >
                  {currentHrZone.name.split(" ")[0]} ({currentHrZone.minBpm}-{currentHrZone.maxBpm})
                </span>
              )}
            </span>
            <span 
              className="text-3xl font-bold font-mono tracking-tight mt-1"
              style={{ color: currentHrZone?.color }}
            >
              {heartRate ?? "-"} <span className="text-sm font-normal opacity-75">bpm</span>
            </span>
          </div>
        </div>

        {/* Active Mode Info Ribbon */}
        <div className="px-4 py-2 bg-muted/40 border-t flex justify-between items-center text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground font-semibold uppercase tracking-wider">Active Mode:</span>
            <span className="font-semibold text-foreground">
              {activeTrainerMode.type === "none" && <span className="text-muted-foreground">None</span>}
              {activeTrainerMode.type === "erg" && <span className="text-primary">ERG ({activeTrainerMode.watts} W)</span>}
              {activeTrainerMode.type === "resistance" && <span className="text-primary">Resistance ({activeTrainerMode.level}%)</span>}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground font-semibold uppercase tracking-wider">Time:</span>
            <span className="font-mono font-bold text-foreground">
              {formatTime(elapsedSeconds)} <span className="text-muted-foreground font-normal">/ {formatTime(totalDuration)}</span>
            </span>
          </div>
        </div>

        {/* Ride Coach Message */}
        {(liveCoachFeedback || liveCoachStatus !== "idle") && (
          <div className="border-t px-4 py-3 bg-muted/10">
            <div className="mb-1 flex items-center justify-between gap-3">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Ride Coach
              </span>
              {liveCoachStatus === "checking" && (
                <span className="text-[9px] font-bold uppercase tracking-wider text-primary animate-pulse">
                  Checking...
                </span>
              )}
              {liveCoachStatus === "error" && (
                <span className="text-[9px] font-bold uppercase tracking-wider text-destructive">
                  Offline
                </span>
              )}
            </div>
            {(liveCoachFeedback || liveCoachDetail) && (
              <p
                className={
                  liveCoachFeedback
                    ? "text-sm font-medium leading-relaxed"
                    : "mt-1 text-xs leading-relaxed text-muted-foreground"
                }
              >
                {liveCoachFeedback || liveCoachDetail}
              </p>
            )}
          </div>
        )}

        {/* Bottom Control Bar */}
        <div className="px-4 py-3 bg-muted/40 border-t flex flex-wrap items-center justify-between gap-3">
          {/* Left Side: Coach Settings (Inline) */}
          <div className="flex items-center gap-2">
            {!adaptive && (
              <div className="flex items-center gap-1.5 rounded-md border bg-background/60 p-0.5 shadow-sm">
                <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground px-1.5">
                  Coach
                </span>
                <div className="flex rounded bg-muted/50 p-0.5">
                  {FIXED_TRACK_COACH_INTERVAL_OPTIONS.map((minutes) => {
                    const selected = fixedTrackCoachIntervalMinutes === minutes;
                    return (
                      <button
                        key={minutes}
                        type="button"
                        onClick={() => setFixedTrackCoachIntervalMinutes(minutes)}
                        className={`h-6 min-w-8 rounded px-1.5 text-[10px] font-bold transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                          selected
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        aria-pressed={selected}
                        title={`Coach update every ${minutes} minute${minutes === 1 ? "" : "s"}`}
                      >
                        {minutes}m
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {adaptive && (
              <div className="flex items-center gap-1.5 rounded-md border bg-background/60 p-0.5 shadow-sm">
                <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground px-1.5">
                  Rewrite
                </span>
                <div className="flex rounded bg-muted/50 p-0.5">
                  {ADAPTIVE_REWRITE_INTERVAL_OPTIONS.map((minutes) => {
                    const selected = adaptiveRewriteIntervalMinutes === minutes;
                    const label = minutes === null ? "Off" : `${minutes}m`;
                    const title =
                      minutes === null
                        ? "Turn adaptive rewrites and coach speech off"
                        : `Rewrite adaptive ride every ${minutes} minute${minutes === 1 ? "" : "s"}`;

                    return (
                      <button
                        key={minutes ?? "off"}
                        type="button"
                        onClick={() => handleAdaptiveRewriteIntervalSelect(minutes)}
                        className={`h-6 min-w-8 rounded px-1.5 text-[10px] font-bold transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                          selected
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        aria-pressed={selected}
                        title={title}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {isListeningForAdaptiveInstruction && (
              <div className="flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-0.5 text-[10px] font-bold text-red-600">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                <span>REC</span>
                <span className="font-mono">{formatShortDuration(adaptiveVoiceRecordingSeconds)}</span>
              </div>
            )}
          </div>

          {/* Right Side: Action Buttons */}
          <div className="flex items-center gap-2">
            {disabled && (
              <p className="text-[10px] text-red-500 font-semibold mr-2">Connect trainer to control</p>
            )}

            {elapsedSeconds > 0 && !isPlaying && (
              <Dialog open={isFinishOpen} onOpenChange={setIsFinishOpen}>
                <DialogTrigger asChild>
                  <Button variant="destructive" size="sm" className="h-8 text-xs font-semibold">Finish & Save</Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-lg rounded-md">
                  <DialogHeader>
                    <DialogTitle>Finish Session</DialogTitle>
                    <DialogDescription>
                      Add rider notes for the post-ride summary.
                    </DialogDescription>
                  </DialogHeader>
                  <textarea
                    value={finishComments}
                    onChange={(e) => setFinishComments(e.target.value)}
                    placeholder="How did it feel? Fueling, heat, legs, HR strap, anything unusual..."
                    className="min-h-28 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setIsFinishOpen(false)}>
                      Cancel
                    </Button>
                    <Button variant="destructive" onClick={handleFinishSession}>
                      Finish & Save
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}

            {elapsedSeconds > 0 && !isPlaying && (
              <Button
                onClick={handleDiscardRide}
                variant="outline"
                size="icon-sm"
                className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive shrink-0"
                title="Discard ride"
                aria-label="Discard ride"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}

            <Button 
              onClick={handleStop} 
              variant="outline" 
              size="sm"
              className="h-8 text-xs font-semibold"
              disabled={elapsedSeconds === 0}
            >
              Reset Timer
            </Button>

            {adaptive && (
              <Button
                onClick={startAdaptiveVoiceInstruction}
                variant={isListeningForAdaptiveInstruction ? "secondary" : "outline"}
                size="icon-sm"
                className={`h-8 w-8 ${isListeningForAdaptiveInstruction ? "border-red-500 text-red-600 ring-2 ring-red-500/30" : ""}`}
                disabled={disabled || !adaptiveRewriteEnabled}
                title={
                  !adaptiveRewriteEnabled
                    ? "Adaptive rewrite is off"
                    : isListeningForAdaptiveInstruction
                      ? "Stop recording"
                      : "Record adaptive ride instruction"
                }
                aria-label={
                  !adaptiveRewriteEnabled
                    ? "Adaptive rewrite is off"
                    : isListeningForAdaptiveInstruction
                      ? "Stop recording"
                      : "Record adaptive ride instruction"
                }
              >
                <Mic className={`h-3.5 w-3.5 ${isListeningForAdaptiveInstruction ? "animate-pulse" : ""}`} />
              </Button>
            )}

            <Button 
              onClick={handlePlayPause}
              variant={isPlaying ? "secondary" : "default"}
              size="sm"
              disabled={disabled || (!adaptive && elapsedSeconds >= totalDuration)}
              className="h-8 w-20 text-xs font-semibold"
            >
              {isPlaying ? "Pause" : "Play"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});
