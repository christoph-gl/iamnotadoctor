"use client";

import { useRef, useState, useEffect } from "react";
import { BikeSample, TrainerClient } from "@/lib/trainer-client";
import { HeartRateClient } from "@/lib/hr-client";
import { Button } from "@/components/ui/button";
import { Cog, History, Info, Trash2 } from "lucide-react";
import { getRiderProfile, RIDER_PROFILE, saveRiderProfile, type RiderProfile } from "@/lib/profile";
import { WorkoutPlayer, type WorkoutPlayerHandle } from "@/components/workout-player";
import { 
  RideSession, 
  saveRideSession, 
  getSavedRideSessions, 
  deleteRideSession, 
  calculateActualMetrics,
  type SessionMetrics,
} from "@/lib/sessions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type ConnectionState = "disconnected" | "connecting" | "connected";
type TrainerMode = "erg" | "resistance";
type ActiveTrainerMode = { type: "none" } | { type: "erg", watts: number } | { type: "resistance", level: number };

const POWER_PROFILE_FIELDS = [
  {
    key: "nm",
    label: "P5",
    duration: "5 sec",
    description: "Best short sprint power over about 5 seconds.",
  },
  {
    key: "ac",
    label: "P60",
    duration: "60 sec",
    description: "Best hard one-minute power for short anaerobic efforts.",
  },
  {
    key: "map",
    label: "P300",
    duration: "5 min",
    description: "Best five-minute aerobic power used to scale harder intervals.",
  },
  {
    key: "ftp",
    label: "Threshold Power",
    duration: "sustained",
    description: "Estimated sustainable threshold power used for workout metrics and pacing.",
  },
] as const satisfies readonly {
  key: keyof RiderProfile["fourDP"];
  label: string;
  duration: string;
  description: string;
}[];

export default function App() {
  const clientRef = useRef(new TrainerClient());
  const hrClientRef = useRef(new HeartRateClient());

  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [hrConnectionState, setHrConnectionState] = useState<ConnectionState>("disconnected");

  const [power, setPower] = useState<number | undefined>();
  const [cadence, setCadence] = useState<number | undefined>();
  const [heartRate, setHeartRate] = useState<number | undefined>();
  const [riderProfile, setRiderProfile] = useState<RiderProfile>(RIDER_PROFILE);
  const [settingsProfile, setSettingsProfile] = useState<RiderProfile>(RIDER_PROFILE);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  
  // Controls
  const [mode, setMode] = useState<TrainerMode>("erg");
  const [resistance, setResistance] = useState(20);
  const [targetPower, setTargetPower] = useState(150);
  
  // What the trainer is currently running
  const [activeTrainerMode, setActiveTrainerMode] = useState<ActiveTrainerMode>({ type: "none" });
  const [isSavingSession, setIsSavingSession] = useState(false);
  const [savedSummarySession, setSavedSummarySession] = useState<RideSession | null>(null);
  const [isSavedSummaryOpen, setIsSavedSummaryOpen] = useState(false);
  const [isSessionHistoryOpen, setIsSessionHistoryOpen] = useState(false);
  const [sessionSampleCount, setSessionSampleCount] = useState(0);

  const [sessions, setSessions] = useState<RideSession[]>([]);
  const currentSessionFilenameRef = useRef<string | null>(null);
  const activeWorkoutNameRef = useRef<string>("Manual Ride");
  const workoutPlayerRef = useRef<WorkoutPlayerHandle | null>(null);
  const unsavedSamplesRef = useRef<BikeSample[]>([]);

  useEffect(() => {
    getSavedRideSessions().then(setSessions);
    getRiderProfile().then((profile) => {
      setRiderProfile(profile);
      setSettingsProfile(profile);
    });

  }, []);

  const logSamples = async (samples: BikeSample[], isNew: boolean, finalMetrics?: SessionMetrics) => {
    if (!currentSessionFilenameRef.current) return;
    try {
      await fetch("/api/log-ride", {
        method: "POST",
        body: JSON.stringify({
          filename: currentSessionFilenameRef.current,
          samples,
          isNew,
          metadata: isNew ? {
            workoutName: activeWorkoutNameRef.current,
            profile: riderProfile.fourDP
          } : undefined,
          finalMetrics
        }),
      });
    } catch (e) {
      console.error("Failed to log samples to server:", e);
    }
  };

  const setDraftProfileNumber = (
    section: "fourDP",
    key: keyof RiderProfile["fourDP"],
    value: string
  ) => {
    setSettingsProfile((profile) => ({
      ...profile,
      [section]: {
        ...profile[section],
        [key]: Number(value) || 0,
      },
    }));
  };

  const setDraftRootNumber = (key: "age" | "weightKg", value: string) => {
    setSettingsProfile((profile) => ({
      ...profile,
      [key]: value === "" ? null : Number(value),
    }));
  };

  const updateDraftHrZone = (
    zoneId: string,
    key: "name" | "percentageRange" | "minBpm" | "maxBpm" | "color",
    value: string
  ) => {
    setSettingsProfile((profile) => ({
      ...profile,
      hrZones: profile.hrZones.map((zone) =>
        zone.id === zoneId
          ? {
              ...zone,
              [key]: key === "minBpm" || key === "maxBpm" ? Number(value) || 0 : value,
            }
          : zone
      ),
    }));
  };

  const handleSettingsOpenChange = (open: boolean) => {
    if (open) {
      setSettingsProfile(riderProfile);
    }
    setIsSettingsOpen(open);
  };

  const handleSaveProfile = async () => {
    setIsSavingProfile(true);
    try {
      await saveRiderProfile(settingsProfile);
      const saved = await getRiderProfile();
      setRiderProfile(saved);
      setSettingsProfile(saved);
      setIsSettingsOpen(false);
    } catch (e) {
      console.error(e);
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSavingProfile(false);
    }
  };

  const currentHrZone = heartRate 
    ? riderProfile.hrZones.find(z => heartRate >= z.minBpm && heartRate <= z.maxBpm) 
    : undefined;

  async function connect() {
    try {
      setConnectionState("connecting");
      // Reset logging for a potential new session
      currentSessionFilenameRef.current = `ride-${Date.now()}`;
      unsavedSamplesRef.current = [];
      setSessionSampleCount(0);

      await clientRef.current.connect(
        (sample) => {
          setPower(sample.powerW);
          setCadence(sample.cadenceRpm);
          setSessionSampleCount(clientRef.current.samples.length);
          // Only update local HR state if trainer provides it AND external HRM is not connected
          if (sample.heartRateBpm !== undefined && !hrClientRef.current.isConnected) {
            setHeartRate(sample.heartRateBpm);
          }

          // Buffer and log samples
          unsavedSamplesRef.current.push(sample);
          if (unsavedSamplesRef.current.length >= 10) {
            const toLog = [...unsavedSamplesRef.current];
            const isNew = clientRef.current.samples.length <= 10;
            unsavedSamplesRef.current = [];
            logSamples(toLog, isNew);
          }
        },
        () => {
          setConnectionState("disconnected");
          setPower(undefined);
          setCadence(undefined);
          setActiveTrainerMode({ type: "none" });
          if (!hrClientRef.current.isConnected) {
            setHeartRate(undefined);
          }
          // Final log of remaining samples
          if (unsavedSamplesRef.current.length > 0) {
            logSamples(unsavedSamplesRef.current, false);
            unsavedSamplesRef.current = [];
          }
        }
      );
      setConnectionState("connected");
      setSessionSampleCount(clientRef.current.samples.length);
    } catch (e) {
      setConnectionState("disconnected");
      console.error(e);
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function disconnect() {
    try {
      await clientRef.current.disconnect();
    } catch (e) {
      console.error(e);
    }
  }

  async function connectHRM() {
    try {
      setHrConnectionState("connecting");
      await hrClientRef.current.connect(
        (bpm) => {
          setHeartRate(bpm);
          clientRef.current.currentHeartRate = bpm;
        },
        () => {
          setHrConnectionState("disconnected");
          setHeartRate(undefined);
          clientRef.current.currentHeartRate = undefined;
        }
      );
      setHrConnectionState("connected");
    } catch (e) {
      setHrConnectionState("disconnected");
      console.error(e);
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function disconnectHRM() {
    try {
      await hrClientRef.current.disconnect();
    } catch (e) {
      console.error(e);
    }
  }

  async function setTrainerResistance(level: number) {
    await clientRef.current.setResistance(level);
    setActiveTrainerMode({ type: "resistance", level });
    setResistance(level);
  }

  async function setTrainerTargetPower(watts: number) {
    await clientRef.current.setTargetPower(watts);
    setActiveTrainerMode({ type: "erg", watts });
    setTargetPower(watts);
  }

  async function applyResistance(level?: number) {
    const levelToSet = typeof level === "number" ? level : resistance;
    try {
      await setTrainerResistance(levelToSet);
    } catch (e) {
      console.error(e);
      alert(e instanceof Error ? e.message : String(e));
    }
  }
  
  async function applyTargetPower(watts?: number) {
    const powerToSet = typeof watts === "number" ? watts : targetPower;
    try {
      await setTrainerTargetPower(powerToSet);
    } catch (e) {
      console.error(e);
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function applyWorkoutTargetPower(watts: number) {
    if (activeTrainerMode.type === "resistance" || mode === "resistance") {
      setTargetPower(watts);
      return;
    }

    await applyTargetPower(watts);
  }

  const handleStopSession = async (workoutName: string, riderComments?: string) => {
    const samples = [...clientRef.current.samples];
    if (samples.length === 0) return;
    setIsSavingSession(true);

    const metrics = calculateActualMetrics(samples, riderProfile.fourDP.ftp);

    try {
      // Final log of remaining samples and metrics before ending session
      logSamples(unsavedSamplesRef.current, false, metrics);
      unsavedSamplesRef.current = [];

      const newSession: RideSession = {
        id: "session-" + Date.now(),
        workoutName,
        timestamp: Date.now(),
        samples,
        metrics,
        riderComments: riderComments?.trim() || undefined,
      };

      const savedSession = await saveRideSession(newSession);
      setSessions(prev => [savedSession, ...prev]);
      setSavedSummarySession(savedSession);
      setIsSavedSummaryOpen(true);
      clientRef.current.samples = []; // Clear samples for next session
      setSessionSampleCount(0);
      currentSessionFilenameRef.current = null; // Mark session as ended
    } catch (error) {
      console.error("Failed to finish session:", error);
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingSession(false);
    }
  };

  const handleExportSession = (session: RideSession) => {
    const rows = session.samples.map((s) => ({
      timestamp: new Date(s.timestamp).toISOString(),
      powerW: s.powerW ?? "",
      cadenceRpm: s.cadenceRpm ?? "",
      speedKph: s.speedKph ?? "",
      resistance: s.resistance ?? "",
      heartRateBpm: s.heartRateBpm ?? "",
    }));

    const csv = [
      "timestamp,powerW,cadenceRpm,speedKph,resistance,heartRateBpm",
      ...rows.map((r) =>
        [r.timestamp, r.powerW, r.cadenceRpm, r.speedKph, r.resistance, r.heartRateBpm].join(",")
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `iamnotadoctor-${session.workoutName.replace(/\s+/g, '-')}-${session.timestamp}.csv`;
    a.click();

    URL.revokeObjectURL(url);
  };

  const handleDeleteSession = async (id: string) => {
    if (window.confirm("Delete this session?")) {
      await deleteRideSession(id);
      setSessions(prev => prev.filter(s => s.id !== id));
    }
  };

  async function exportCsv() {
    const rows = clientRef.current.samples.map((s) => ({
      timestamp: new Date(s.timestamp).toISOString(),
      powerW: s.powerW ?? "",
      cadenceRpm: s.cadenceRpm ?? "",
      speedKph: s.speedKph ?? "",
      resistance: s.resistance ?? "",
      heartRateBpm: s.heartRateBpm ?? "",
    }));

    const csv = [
      "timestamp,powerW,cadenceRpm,speedKph,resistance,heartRateBpm",
      ...rows.map((r) =>
        [r.timestamp, r.powerW, r.cadenceRpm, r.speedKph, r.resistance, r.heartRateBpm].join(",")
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `iamnotadoctor-session-${Date.now()}.csv`;
    a.click();

    URL.revokeObjectURL(url);
  }

  const inputClass = "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  const labelClass = "flex flex-col gap-1 text-xs font-semibold text-muted-foreground";

  const renderRideSummary = (session: RideSession, compact = false) => {
    if (!session.llmSummary) {
      return (
        <p className="text-xs text-muted-foreground">
          Summary {session.llmSummaryStatus || "not available"}
          {session.llmSummaryError ? `: ${session.llmSummaryError}` : ""}
        </p>
      );
    }

    return (
      <div className="flex flex-col gap-3">
        <div>
          <h4 className="text-sm font-semibold">{session.llmSummary.headline}</h4>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {session.llmSummary.summary}
          </p>
        </div>

        {!compact && (
          <>
            <div>
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Observations
              </div>
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {session.llmSummary.keyObservations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>

            <div className="grid gap-3 text-xs text-muted-foreground">
              <div>
                <span className="font-semibold text-foreground">HR zones: </span>
                {session.llmSummary.heartRateZoneAssessment}
              </div>
              <div>
                <span className="font-semibold text-foreground">Load: </span>
                {session.llmSummary.trainingLoadAssessment}
              </div>
              {session.llmSummary.riderCommentsReflection && (
                <div>
                  <span className="font-semibold text-foreground">Rider notes: </span>
                  {session.llmSummary.riderCommentsReflection}
                </div>
              )}
            </div>

            <div>
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Next Focus
              </div>
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {session.llmSummary.suggestedNextFocus.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    );
  };

  const renderSessionHistory = () => (
    <div className="flex flex-col gap-3">
      {/* Current unsaved samples if any */}
      {sessionSampleCount > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-dashed bg-muted/10 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-semibold text-xs">Unsaved Session</span>
            <span className="text-[10px] text-muted-foreground">
              {isSavingSession ? "Saving summary..." : `${sessionSampleCount} samples`}
            </span>
          </div>
          <Button onClick={exportCsv} variant="outline" size="sm" className="h-7 w-full text-xs">
            Export Temporary CSV
          </Button>
        </div>
      )}

      {sessions.length === 0 && sessionSampleCount === 0 && (
        <p className="py-8 text-center text-xs text-muted-foreground">No sessions recorded yet.</p>
      )}

      <div className="flex max-h-[65vh] flex-col gap-2 overflow-y-auto pr-1">
        {sessions.map((session) => (
          <div key={session.id} className="group relative flex flex-col gap-2 rounded-md border bg-card p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span className="truncate pr-8 text-sm font-bold">{session.workoutName}</span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(session.timestamp).toLocaleDateString()} at {new Date(session.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <Button
                onClick={() => handleDeleteSession(session.id)}
                variant="ghost"
                size="icon-sm"
                className="absolute right-2 top-2 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                aria-label={`Delete ${session.workoutName}`}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>

            <div className="grid grid-cols-3 gap-1 text-center">
              <div className="flex flex-col">
                <span className="text-[9px] uppercase text-muted-foreground">Power</span>
                <span className="font-mono text-xs">{session.metrics.avgPower || "-"}W</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[9px] uppercase text-muted-foreground">TSS</span>
                <span className="font-mono text-xs">{Math.round(session.metrics.tss)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[9px] uppercase text-muted-foreground">Time</span>
                <span className="font-mono text-xs">
                  {Math.floor(session.metrics.durationSeconds / 60)}m
                </span>
              </div>
            </div>

            {session.riderComments && (
              <p className="rounded-sm bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">
                {session.riderComments}
              </p>
            )}

            {session.llmSummary && (
              <div className="rounded-sm border bg-muted/20 p-2">
                <div className="mb-1 font-bold uppercase tracking-wider text-muted-foreground">
                  AI Summary
                </div>
                {renderRideSummary(session, true)}
                <details className="mt-2">
                  <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    More
                  </summary>
                  <div className="mt-2 border-t pt-2">
                    {renderRideSummary(session)}
                  </div>
                </details>
              </div>
            )}

            {!session.llmSummary && session.llmSummaryStatus && (
              <p className="text-[10px] text-muted-foreground">
                Summary {session.llmSummaryStatus}
              </p>
            )}

            <Button
              onClick={() => handleExportSession(session)}
              variant="secondary"
              size="sm"
              className="h-7 w-full text-[10px] font-bold"
            >
              Download CSV
            </Button>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <main className="flex min-h-svh flex-col gap-6 p-6 lg:flex-row">
      {/* Left Column - Controls & Telemetry */}
      <div className="flex max-w-md min-w-0 flex-col gap-6 text-sm w-full">
        
        {/* Header with Settings */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Workout Controller</h1>
          <Dialog open={isSavedSummaryOpen} onOpenChange={setIsSavedSummaryOpen}>
            <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto rounded-md">
              <DialogHeader>
                <DialogTitle>Session Saved</DialogTitle>
                <DialogDescription>
                  {savedSummarySession?.workoutName || "Ride summary"}
                </DialogDescription>
              </DialogHeader>
              {savedSummarySession && (
                <div className="rounded-md border bg-muted/20 p-4">
                  {renderRideSummary(savedSummarySession)}
                </div>
              )}
              <DialogFooter>
                <Button onClick={() => setIsSavedSummaryOpen(false)}>
                  Done
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Dialog open={isSettingsOpen} onOpenChange={handleSettingsOpenChange}>
            <DialogTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Open rider settings">
                <Cog className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Rider Settings</DialogTitle>
                <DialogDescription>
                  Profile values used by workouts, ride metrics, and summaries.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-6 mt-4">
                <div className="flex flex-col border rounded-md bg-card overflow-hidden">
                  <div className="p-4 bg-muted/20 border-b">
                    <h3 className="font-semibold text-base">Power Profile</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                    {POWER_PROFILE_FIELDS.map(({ key, label, duration, description }) => (
                      <label key={key} className={labelClass} title={description}>
                        <span className="flex items-center gap-1">
                          <span>{label}</span>
                          <Info className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        </span>
                        <span className="text-[10px] font-normal text-muted-foreground">{duration}</span>
                        <input
                          type="number"
                          min="0"
                          value={settingsProfile.fourDP[key]}
                          onChange={(e) => setDraftProfileNumber("fourDP", key, e.target.value)}
                          className={inputClass}
                        />
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col border rounded-md bg-card overflow-hidden">
                  <div className="p-4 bg-muted/20 border-b">
                    <h3 className="font-semibold text-base">Body Profile</h3>
                  </div>
                  <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-4">
                    <label className={labelClass}>
                      <span>Age</span>
                      <input
                        type="number"
                        min="0"
                        value={settingsProfile.age ?? ""}
                        onChange={(e) => setDraftRootNumber("age", e.target.value)}
                        className={inputClass}
                      />
                    </label>
                    <label className={labelClass}>
                      <span>Weight (kg)</span>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={settingsProfile.weightKg ?? ""}
                        onChange={(e) => setDraftRootNumber("weightKg", e.target.value)}
                        className={inputClass}
                      />
                    </label>
                    <label className={labelClass}>
                      <span>Gender</span>
                      <select
                        value={settingsProfile.gender ?? ""}
                        onChange={(e) => setSettingsProfile((profile) => ({ ...profile, gender: e.target.value || null }))}
                        className={inputClass}
                      >
                        <option value="">Unset</option>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                      </select>
                    </label>
                    <label className={labelClass}>
                      <span>cTHR</span>
                      <input
                        type="number"
                        min="0"
                        value={settingsProfile.cTHR}
                        onChange={(e) => setSettingsProfile((profile) => ({ ...profile, cTHR: Number(e.target.value) || 0 }))}
                        className={inputClass}
                      />
                    </label>
                  </div>
                </div>

                <div className="flex flex-col border rounded-md bg-card overflow-hidden">
                  <div className="p-4 bg-muted/20 border-b flex justify-between items-center">
                    <div>
                      <h3 className="font-semibold text-base">Heart Rate Zones</h3>
                    </div>
                  </div>
                  <div className="flex flex-col divide-y">
                    <div className="grid grid-cols-[1fr_1fr_72px_72px_44px] gap-2 p-3 px-4 text-xs font-semibold text-muted-foreground uppercase bg-muted/10">
                      <div>Name</div>
                      <div>Range</div>
                      <div>Min</div>
                      <div>Max</div>
                      <div>Color</div>
                    </div>
                    {settingsProfile.hrZones.map((zone) => (
                      <div key={zone.id} className="grid grid-cols-[1fr_1fr_72px_72px_44px] gap-2 p-3 items-center">
                        <input
                          value={zone.name}
                          onChange={(e) => updateDraftHrZone(zone.id, "name", e.target.value)}
                          className={inputClass}
                        />
                        <input
                          value={zone.percentageRange}
                          onChange={(e) => updateDraftHrZone(zone.id, "percentageRange", e.target.value)}
                          className={inputClass}
                        />
                        <input
                          type="number"
                          min="0"
                          value={zone.minBpm}
                          onChange={(e) => updateDraftHrZone(zone.id, "minBpm", e.target.value)}
                          className={inputClass}
                        />
                        <input
                          type="number"
                          min="0"
                          value={zone.maxBpm}
                          onChange={(e) => updateDraftHrZone(zone.id, "maxBpm", e.target.value)}
                          className={inputClass}
                        />
                        <input
                          type="color"
                          value={zone.color}
                          onChange={(e) => updateDraftHrZone(zone.id, "color", e.target.value)}
                          className="h-9 w-full rounded-md border border-input bg-transparent p-1"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col border rounded-md bg-card overflow-hidden">
                  <div className="p-4 bg-muted/20 border-b">
                    <h3 className="font-semibold text-base">Rider Memory Summary</h3>
                  </div>
                  <div className="p-4">
                    <textarea
                      value={settingsProfile.memorySummary}
                      onChange={(e) => setSettingsProfile((profile) => ({ ...profile, memorySummary: e.target.value }))}
                      className="min-h-28 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => handleSettingsOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleSaveProfile} disabled={isSavingProfile}>
                    {isSavingProfile ? "Saving..." : "Save Settings"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
        <div className="flex flex-col gap-4">
          {/* Devices Card */}
          <div className="flex flex-col gap-3 p-4 border rounded-md bg-card shadow-sm">
            <h2 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">Devices</h2>
            
            <div className="flex flex-col divide-y divide-border/60">
              {/* Trainer Row */}
              <div className="flex items-center justify-between pb-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-bold">Smart Trainer</span>
                  <div className="flex items-center gap-1.5">
                    <span className="relative flex h-2 w-2">
                      {connectionState === "connecting" && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span>
                      )}
                      <span className={`relative inline-flex rounded-full h-2 w-2 ${
                        connectionState === "connected" ? "bg-green-500" :
                        connectionState === "connecting" ? "bg-yellow-500" :
                        "bg-red-500"
                      }`}></span>
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      {connectionState}
                    </span>
                  </div>
                </div>
                {connectionState === "disconnected" ? (
                  <Button onClick={connect} size="sm" className="h-8 px-3 text-xs font-semibold">
                    Connect
                  </Button>
                ) : (
                  <Button onClick={disconnect} variant="destructive" size="sm" className="h-8 px-3 text-xs font-semibold" disabled={connectionState === "connecting"}>
                    Disconnect
                  </Button>
                )}
              </div>

              {/* HRM Row */}
              <div className="flex items-center justify-between pt-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-bold">Heart Rate Monitor</span>
                  <div className="flex items-center gap-1.5">
                    <span className="relative flex h-2 w-2">
                      {hrConnectionState === "connecting" && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span>
                      )}
                      <span className={`relative inline-flex rounded-full h-2 w-2 ${
                        hrConnectionState === "connected" ? "bg-green-500" :
                        hrConnectionState === "connecting" ? "bg-yellow-500" :
                        "bg-red-500"
                      }`}></span>
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      {hrConnectionState}
                    </span>
                  </div>
                </div>
                {hrConnectionState === "disconnected" ? (
                  <Button onClick={connectHRM} variant="secondary" size="sm" className="h-8 px-3 text-xs font-semibold">
                    Connect
                  </Button>
                ) : (
                  <Button onClick={disconnectHRM} variant="destructive" size="sm" className="h-8 px-3 text-xs font-semibold" disabled={hrConnectionState === "connecting"}>
                    Disconnect
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4 p-4 rounded-md border bg-card shadow-sm">
            {/* Mode Switcher */}
            <div className="flex p-0.5 bg-muted/60 rounded-md">
              <button
                className={`flex-1 py-1 text-xs font-bold rounded transition-all ${
                  mode === "erg" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setMode("erg")}
              >
                ERG Mode (Watts)
              </button>
              <button
                className={`flex-1 py-1 text-xs font-bold rounded transition-all ${
                  mode === "resistance" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setMode("resistance")}
              >
                Resistance (%)
              </button>
            </div>

            {/* ERG Mode Controls */}
            {mode === "erg" && (
              <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-1">
                <label className="flex flex-col gap-1.5 font-medium">
                  <div className="flex justify-between items-center text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    <span>Target Power</span>
                    <span className="text-primary font-mono text-sm font-bold">{targetPower} W</span>
                  </div>
                  <input
                    type="range"
                    min="50"
                    max="1000"
                    step="5"
                    value={targetPower}
                    onChange={(e) => setTargetPower(Number(e.target.value))}
                    className="w-full accent-primary cursor-pointer h-1 bg-muted rounded-lg appearance-none"
                    disabled={connectionState !== "connected"}
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground/50 font-semibold">
                    <span>50 W</span>
                    <span>1000 W</span>
                  </div>
                </label>
                
                <div className="flex gap-2 items-center">
                  <input 
                    type="number" 
                    min="50" 
                    max="1000" 
                    value={targetPower} 
                    onChange={(e) => setTargetPower(Number(e.target.value))}
                    className="flex h-8 w-16 rounded-md border border-input bg-transparent px-2.5 py-1 text-xs font-mono shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={connectionState !== "connected"}
                  />
                  <Button 
                    onClick={() => applyTargetPower()} 
                    size="sm"
                    className="flex-1 h-8 text-xs font-semibold"
                    disabled={connectionState !== "connected"}
                  >
                    {activeTrainerMode.type === "erg" ? "Update Target Power" : "Activate ERG Mode"}
                  </Button>
                </div>
              </div>
            )}

            {/* Resistance Mode Controls */}
            {mode === "resistance" && (
              <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-1">
                <label className="flex flex-col gap-1.5 font-medium">
                  <div className="flex justify-between items-center text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    <span>Resistance Level</span>
                    <span className="text-primary font-mono text-sm font-bold">{resistance}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="0.5"
                    value={resistance}
                    onChange={(e) => setResistance(Number(e.target.value))}
                    className="w-full accent-primary cursor-pointer h-1 bg-muted rounded-lg appearance-none"
                    disabled={connectionState !== "connected"}
                  />
                </label>

                <Button 
                  onClick={() => applyResistance()} 
                  size="sm"
                  className="w-full h-8 text-xs font-semibold"
                  disabled={connectionState !== "connected"}
                >
                  {activeTrainerMode.type === "resistance" ? "Update Resistance" : "Activate Resistance Mode"}
                </Button>
                <p className="text-[10px] text-muted-foreground/50 text-center font-medium leading-normal">
                  Power output will scale with your cadence and gearing.
                </p>
              </div>
            )}
          </div>

          <div className="border-t pt-2">
            <Dialog open={isSessionHistoryOpen} onOpenChange={setIsSessionHistoryOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="w-full justify-between">
                  <span className="flex items-center gap-2">
                    <History className="h-4 w-4" />
                    Session History
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {sessions.length}
                  </span>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85vh] overflow-hidden rounded-md sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Session History</DialogTitle>
                  <DialogDescription>
                    Review saved rides, export CSV files, or remove sessions.
                  </DialogDescription>
                </DialogHeader>
                {renderSessionHistory()}
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      {/* Right Column - Workout Player */}
      <div className="flex min-w-0 w-full max-w-4xl flex-col gap-6">
        <WorkoutPlayer
           ref={workoutPlayerRef}
           disabled={connectionState !== "connected"}
           onPowerTargetChange={applyWorkoutTargetPower}
           onStopSession={handleStopSession}
           onWorkoutChange={(w) => activeWorkoutNameRef.current = w.name}
           manualControlMode={mode}
           power={power}
           cadence={cadence}
           heartRate={heartRate}
           currentHrZone={currentHrZone}
           activeTrainerMode={activeTrainerMode}
           riderProfile={riderProfile}
        />
      </div>
    </main>
  );
}
