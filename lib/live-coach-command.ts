export type LiveCoachCommand =
  | {
      id?: string;
      type: "set_erg_watts";
      watts: number;
      reason?: string;
    }
  | {
      id?: string;
      type: "set_resistance";
      percent: number;
      reason?: string;
    }
  | {
      id?: string;
      type: "set_trainer_mode";
      mode: "erg";
      targetWatts: number;
      reason?: string;
    }
  | {
      id?: string;
      type: "set_trainer_mode";
      mode: "resistance";
      percent?: number;
      level?: number;
      reason?: string;
    }
  | {
      id?: string;
      type: "send_message";
      text: string;
      speak?: boolean;
      reason?: string;
    }
  | {
      id?: string;
      type: "request_rider_voice_feedback";
      prompt?: string;
      durationSeconds?: number;
      transcriptionMode?: "browser";
      reason?: string;
    }
  | {
      id?: string;
      type: "start_trainer";
      reason?: string;
    }
  | {
      id?: string;
      type: "stop_trainer";
      reason?: string;
    }
  | {
      id?: string;
      type: "set_workout_plan";
      horizonSeconds?: number;
      leadSeconds?: number;
      blocks: { durationSeconds: number; targetPower: number }[];
      reason?: string;
    };

export function makeLiveCoachCommandId() {
  return `live-coach-command-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
