import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import type { BikeSample } from "./trainer-client";
import { DEFAULT_RIDER_PROFILE, type RiderProfile } from "./profile";
import type { RideSession, RideSessionSummary, SessionMetrics } from "./sessions";

type SessionRow = {
  id: string;
  workout_name: string;
  timestamp: number;
  metrics_json: string;
  rider_comments: string | null;
  llm_summary_json: string | null;
  llm_summary_status: string | null;
  llm_summary_error: string | null;
};

type SessionSummaryRow = SessionRow & {
  sample_count: number;
};

type SampleRow = {
  timestamp: number;
  power_w: number | null;
  cadence_rpm: number | null;
  speed_kph: number | null;
  resistance: number | null;
  heart_rate_bpm: number | null;
};

type MonthlySummaryRow = {
  month: string;
  summary_json: string;
  model: string | null;
  generated_at: number;
};

type RiderProfileRow = {
  nm: number;
  ac: number;
  map: number;
  ftp: number;
  c_thr: number;
  age: number | null;
  weight_kg: number | null;
  gender: string | null;
  hr_zones_json: string;
  colors_json: string;
  memory_summary: string | null;
};

export type ApiCallLogInput = {
  operation: string;
  provider?: string;
  model?: string;
  voice?: string;
  status: "success" | "error" | "timeout";
  startedAt?: number;
  durationMs?: number;
  request?: unknown;
  response?: unknown;
  error?: unknown;
};

export type ApiCallLog = {
  id: number;
  createdAt: number;
  operation: string;
  provider?: string;
  model?: string;
  voice?: string;
  status: ApiCallLogInput["status"];
  durationMs?: number;
  request: unknown;
  response?: unknown;
  error?: string;
};

const dbDir = path.join(process.cwd(), ".data");
const dbPath = path.join(dbDir, "iamnotadoctor.sqlite");
const legacyDbPath = path.join(dbDir, "kickr.sqlite");

let database: DatabaseSync | null = null;

export function getDb() {
  if (!database) {
    fs.mkdirSync(dbDir, { recursive: true });
    if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
      fs.copyFileSync(legacyDbPath, dbPath);
    }
    database = new DatabaseSync(dbPath);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS ride_sessions (
        id TEXT PRIMARY KEY,
        workout_name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        metrics_json TEXT NOT NULL,
        rider_comments TEXT,
        llm_summary_json TEXT,
        llm_summary_status TEXT,
        llm_summary_error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS ride_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        power_w REAL,
        cadence_rpm REAL,
        speed_kph REAL,
        resistance REAL,
        heart_rate_bpm REAL,
        FOREIGN KEY (session_id) REFERENCES ride_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS ride_samples_session_timestamp_idx
        ON ride_samples(session_id, timestamp);

      CREATE TABLE IF NOT EXISTS rider_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nm REAL NOT NULL,
        ac REAL NOT NULL,
        map REAL NOT NULL,
        ftp REAL NOT NULL,
        c_thr REAL NOT NULL,
        age INTEGER,
        weight_kg REAL,
        gender TEXT,
        hr_zones_json TEXT NOT NULL,
        colors_json TEXT NOT NULL,
        memory_summary TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monthly_summaries (
        month TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL,
        model TEXT,
        generated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_call_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        operation TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        voice TEXT,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        request_json TEXT NOT NULL,
        response_json TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS api_call_logs_created_at_idx
        ON api_call_logs(created_at DESC);

      CREATE INDEX IF NOT EXISTS api_call_logs_operation_idx
        ON api_call_logs(operation, created_at DESC);
    `);
    migrateRideSessionSummaries();
    dropLegacyAgentTables();
    seedRiderProfile();
  }

  return database;
}

function dropLegacyAgentTables() {
  database?.exec(`
    DROP TABLE IF EXISTS agent_commands;
    DROP TABLE IF EXISTS agent_events;
  `);
}

function migrateRideSessionSummaries() {
  const columns = database
    ?.prepare("PRAGMA table_info(ride_sessions)")
    .all() as { name: string }[] | undefined;
  const names = new Set(columns?.map((column) => column.name) ?? []);

  if (!names.has("rider_comments")) {
    database?.exec("ALTER TABLE ride_sessions ADD COLUMN rider_comments TEXT");
  }
  if (!names.has("llm_summary_json")) {
    database?.exec("ALTER TABLE ride_sessions ADD COLUMN llm_summary_json TEXT");
  }
  if (!names.has("llm_summary_status")) {
    database?.exec("ALTER TABLE ride_sessions ADD COLUMN llm_summary_status TEXT");
  }
  if (!names.has("llm_summary_error")) {
    database?.exec("ALTER TABLE ride_sessions ADD COLUMN llm_summary_error TEXT");
  }
}

function seedRiderProfile() {
  const exists = database
    ?.prepare("SELECT 1 FROM rider_profile WHERE id = 1")
    .get();

  if (!exists) {
    upsertRiderProfile(DEFAULT_RIDER_PROFILE);
  }
}

export function getRiderProfileFromDb(): RiderProfile {
  const row = getDb()
    .prepare(
      `SELECT nm, ac, map, ftp, c_thr, age, weight_kg, gender,
              hr_zones_json, colors_json, memory_summary
       FROM rider_profile
       WHERE id = 1`
    )
    .get() as RiderProfileRow | undefined;

  if (!row) return DEFAULT_RIDER_PROFILE;

  return {
    fourDP: {
      nm: row.nm,
      ac: row.ac,
      map: row.map,
      ftp: row.ftp,
    },
    cTHR: row.c_thr,
    age: row.age,
    weightKg: row.weight_kg,
    gender: row.gender,
    hrZones: JSON.parse(row.hr_zones_json) as RiderProfile["hrZones"],
    colors: JSON.parse(row.colors_json) as RiderProfile["colors"],
    memorySummary: row.memory_summary ?? "",
  };
}

export function upsertRiderProfile(profile: RiderProfile) {
  getDb()
    .prepare(
      `INSERT INTO rider_profile (
        id, nm, ac, map, ftp, c_thr, age, weight_kg, gender,
        hr_zones_json, colors_json, memory_summary, updated_at
      )
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        nm = excluded.nm,
        ac = excluded.ac,
        map = excluded.map,
        ftp = excluded.ftp,
        c_thr = excluded.c_thr,
        age = excluded.age,
        weight_kg = excluded.weight_kg,
        gender = excluded.gender,
        hr_zones_json = excluded.hr_zones_json,
        colors_json = excluded.colors_json,
        memory_summary = excluded.memory_summary,
        updated_at = excluded.updated_at`
    )
    .run(
      profile.fourDP.nm,
      profile.fourDP.ac,
      profile.fourDP.map,
      profile.fourDP.ftp,
      profile.cTHR,
      profile.age,
      profile.weightKg,
      profile.gender,
      JSON.stringify(profile.hrZones),
      JSON.stringify(profile.colors),
      profile.memorySummary,
      Date.now()
    );
}

export function insertRideSession(session: RideSession) {
  const db = getDb();
  const insertSession = db.prepare(`
    INSERT OR REPLACE INTO ride_sessions (
      id,
      workout_name,
      timestamp,
      metrics_json,
      rider_comments,
      llm_summary_json,
      llm_summary_status,
      llm_summary_error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteSamples = db.prepare("DELETE FROM ride_samples WHERE session_id = ?");
  const insertSample = db.prepare(`
    INSERT INTO ride_samples (
      session_id,
      timestamp,
      power_w,
      cadence_rpm,
      speed_kph,
      resistance,
      heart_rate_bpm
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    insertSession.run(
      session.id,
      session.workoutName,
      session.timestamp,
      JSON.stringify(session.metrics),
      session.riderComments?.trim() || null,
      session.llmSummary ? JSON.stringify(session.llmSummary) : null,
      session.llmSummaryStatus ?? null,
      session.llmSummaryError ?? null
    );
    deleteSamples.run(session.id);

    for (const sample of session.samples) {
      insertSample.run(
        session.id,
        sample.timestamp,
        sample.powerW ?? null,
        sample.cadenceRpm ?? null,
        sample.speedKph ?? null,
        sample.resistance ?? null,
        sample.heartRateBpm ?? null
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listRideSessions(): RideSession[] {
  const db = getDb();
  const sessions = db
    .prepare(
      `SELECT id, workout_name, timestamp, metrics_json, rider_comments,
              llm_summary_json, llm_summary_status, llm_summary_error
       FROM ride_sessions
       ORDER BY timestamp DESC`
    )
    .all() as SessionRow[];

  const sampleStatement = db.prepare(`
    SELECT timestamp, power_w, cadence_rpm, speed_kph, resistance, heart_rate_bpm
    FROM ride_samples
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `);

  return sessions.map((session) => {
    const samples = sampleStatement.all(session.id) as SampleRow[];

    return {
      id: session.id,
      workoutName: session.workout_name,
      timestamp: session.timestamp,
      metrics: JSON.parse(session.metrics_json) as SessionMetrics,
      samples: samples.map(rowToBikeSample),
      riderComments: session.rider_comments ?? undefined,
      llmSummary: session.llm_summary_json
        ? JSON.parse(session.llm_summary_json)
        : undefined,
      llmSummaryStatus:
        session.llm_summary_status === "generated" ||
        session.llm_summary_status === "failed" ||
        session.llm_summary_status === "skipped"
          ? session.llm_summary_status
          : undefined,
      llmSummaryError: session.llm_summary_error ?? undefined,
    };
  });
}

export function listRideSessionSummaries(): RideSessionSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.workout_name, s.timestamp, s.metrics_json, s.rider_comments,
              s.llm_summary_json, s.llm_summary_status, s.llm_summary_error,
              COUNT(rs.id) AS sample_count
       FROM ride_sessions s
       LEFT JOIN ride_samples rs ON rs.session_id = s.id
       GROUP BY s.id
       ORDER BY s.timestamp DESC`
    )
    .all() as SessionSummaryRow[];

  return rows.map((session) => ({
    id: session.id,
    workoutName: session.workout_name,
    timestamp: session.timestamp,
    metrics: JSON.parse(session.metrics_json) as SessionMetrics,
    sampleCount: session.sample_count,
    riderComments: session.rider_comments ?? undefined,
    llmSummary: session.llm_summary_json
      ? JSON.parse(session.llm_summary_json)
      : undefined,
    llmSummaryStatus:
      session.llm_summary_status === "generated" ||
      session.llm_summary_status === "failed" ||
      session.llm_summary_status === "skipped"
        ? session.llm_summary_status
        : undefined,
    llmSummaryError: session.llm_summary_error ?? undefined,
  }));
}

export function getRideSessionById(id: string): RideSession | null {
  const db = getDb();
  const session = db
    .prepare(
      `SELECT id, workout_name, timestamp, metrics_json, rider_comments,
              llm_summary_json, llm_summary_status, llm_summary_error
       FROM ride_sessions
       WHERE id = ?`
    )
    .get(id) as SessionRow | undefined;

  if (!session) return null;

  const samples = db
    .prepare(`
      SELECT timestamp, power_w, cadence_rpm, speed_kph, resistance, heart_rate_bpm
      FROM ride_samples
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `)
    .all(session.id) as SampleRow[];

  return {
    id: session.id,
    workoutName: session.workout_name,
    timestamp: session.timestamp,
    metrics: JSON.parse(session.metrics_json) as SessionMetrics,
    samples: samples.map(rowToBikeSample),
    riderComments: session.rider_comments ?? undefined,
    llmSummary: session.llm_summary_json
      ? JSON.parse(session.llm_summary_json)
      : undefined,
    llmSummaryStatus:
      session.llm_summary_status === "generated" ||
      session.llm_summary_status === "failed" ||
      session.llm_summary_status === "skipped"
        ? session.llm_summary_status
        : undefined,
    llmSummaryError: session.llm_summary_error ?? undefined,
  };
}

export function deleteRideSessionById(id: string) {
  getDb().prepare("DELETE FROM ride_sessions WHERE id = ?").run(id);
}

function redactApiLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 20_000 ? `${value.slice(0, 20_000)}…[truncated]` : value;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return `[binary ${value.byteLength} bytes]`;
  }
  if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
  if (Array.isArray(value)) return value.map((item) => redactApiLogValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        if (/api[-_]?key|authorization|token|secret/i.test(key)) {
          return [key, "[redacted]"];
        }
        if (
          typeof item === "string" &&
          item.length > 1_000 &&
          (/base64|audio|image|data/i.test(key) || item.startsWith("data:"))
        ) {
          return [key, `[redacted binary ${item.length} chars]`];
        }
        return [key, redactApiLogValue(item, depth + 1)];
      })
    );
  }
  return String(value);
}

function stringifyApiLogValue(value: unknown) {
  try {
    return JSON.stringify(redactApiLogValue(value)) ?? "null";
  } catch {
    return JSON.stringify({ error: "Unable to serialize API log value" });
  }
}

function apiLogErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(redactApiLogValue(error));
  } catch {
    return String(error);
  }
}

export function recordApiCallLog(input: ApiCallLogInput) {
  try {
    getDb()
      .prepare(
        `INSERT INTO api_call_logs (
          created_at, operation, provider, model, voice, status, duration_ms,
          request_json, response_json, error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.startedAt ?? Date.now(),
        input.operation,
        input.provider ?? null,
        input.model ?? null,
        input.voice ?? null,
        input.status,
        input.durationMs ?? null,
        stringifyApiLogValue(input.request ?? null),
        input.response === undefined ? null : stringifyApiLogValue(input.response),
        input.error === undefined ? null : apiLogErrorMessage(input.error)
      );
  } catch (error) {
    console.error("Failed to persist API call log:", error);
  }
}

export function listApiCallLogs(limit = 50): ApiCallLog[] {
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  const rows = getDb()
    .prepare(
      `SELECT id, created_at, operation, provider, model, voice, status,
              duration_ms, request_json, response_json, error
       FROM api_call_logs
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(safeLimit) as Array<{
    id: number;
    created_at: number;
    operation: string;
    provider: string | null;
    model: string | null;
    voice: string | null;
    status: ApiCallLogInput["status"];
    duration_ms: number | null;
    request_json: string;
    response_json: string | null;
    error: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    operation: row.operation,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    voice: row.voice ?? undefined,
    status: row.status,
    durationMs: row.duration_ms ?? undefined,
    request: JSON.parse(row.request_json),
    response: row.response_json ? JSON.parse(row.response_json) : undefined,
    error: row.error ?? undefined,
  }));
}

export function upsertMonthlySummary(month: string, summary: unknown, model?: string) {
  getDb()
    .prepare(
      `INSERT INTO monthly_summaries (month, summary_json, model, generated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET
         summary_json = excluded.summary_json,
         model = excluded.model,
         generated_at = excluded.generated_at`
    )
    .run(month, JSON.stringify(summary), model ?? null, Date.now());
}

export function listMonthlySummaries() {
  const rows = getDb()
    .prepare(
      `SELECT month, summary_json, model, generated_at
       FROM monthly_summaries
       ORDER BY month DESC`
    )
    .all() as MonthlySummaryRow[];

  return rows.map((row) => ({
    month: row.month,
    summary: JSON.parse(row.summary_json),
    model: row.model ?? undefined,
    generatedAt: row.generated_at,
  }));
}

function rowToBikeSample(row: SampleRow): BikeSample {
  return {
    timestamp: row.timestamp,
    powerW: row.power_w ?? undefined,
    cadenceRpm: row.cadence_rpm ?? undefined,
    speedKph: row.speed_kph ?? undefined,
    resistance: row.resistance ?? undefined,
    heartRateBpm: row.heart_rate_bpm ?? undefined,
  };
}
