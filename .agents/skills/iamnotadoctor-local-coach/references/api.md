# iamnotadoctor App API Reference

Preferred base URL is `https://iamnotadoctor.localhost` when Portless is running:

```bash
BASE_URL="$(portless get iamnotadoctor 2>/dev/null || printf http://localhost:3000)"
```

## Current Agent Contract

The iamnotadoctor app now handles live coaching, workout building, ride summaries, and trainer control internally. External agents should focus on personal fitness tracking after rides.

Use these endpoints:

```txt
GET /api/rider
PUT /api/rider
PATCH /api/rider/memory
GET /api/sessions
GET /api/sessions?includeSamples=true
GET /api/sessions/:id
GET /api/monthly-summaries
```

Fresh agents should not try to control watts, routes, workouts, or live coaching.

## First Smoke Test

```bash
curl -sf "$BASE_URL/api/rider"
curl -sf "$BASE_URL/api/sessions"
```

These local endpoints do not require authentication.

## Rider Context

```txt
GET /api/rider
PUT /api/rider
PATCH /api/rider/memory
```

`GET /api/rider` returns:

```ts
type RiderProfile = {
  fourDP: { nm: number; ac: number; map: number; ftp: number };
  cTHR: number;
  age: number | null;
  weightKg: number | null;
  gender: "male" | "female" | string | null;
  hrZones: {
    id: string;
    name: string;
    percentageRange: string;
    minBpm: number;
    maxBpm: number;
    color: string;
  }[];
  colors: { nm: string; ac: string; map: string; ftp: string };
  memorySummary: string;
};
```

On first install, ask the rider for age, broad fitness level, cycling background, goals, and constraints. Store:

- numeric age in `age`
- explicitly provided weight, gender, cTHR, and 4DP values in their matching fields
- qualitative fitness level, goals, constraints, and tracking preferences in `memorySummary`

`PUT /api/rider` accepts partial profile patches and merges them into the current profile, then validates the result. Use it only for rider-approved changes to profile fields such as age, weight, cTHR, 4DP, HR zones, or colors.

For memory-only updates, prefer:

```txt
PATCH /api/rider/memory
```

Payload:

```json
{ "memorySummary": "Short rider-facing memory..." }
```

## Sessions

```txt
GET /api/sessions
GET /api/sessions/:id
```

`GET /api/sessions` returns saved ride summaries, usually newest-first. It does not include raw samples:

```ts
type RideSessionSummary = {
  id: string;
  workoutName: string;
  timestamp: number;
  sampleCount: number;
  metrics: {
    tss: number;
    iff: number;
    durationSeconds: number;
    avgPower?: number;
    avgHr?: number;
    avgCadence?: number;
  };
  riderComments?: string;
  llmSummaryStatus?: "skipped" | "generated" | "failed";
  llmSummary?: {
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
  llmSummaryError?: string;
};
```

Use `GET /api/sessions/:id` when raw samples are needed for a specific ride. The app can also call `GET /api/sessions?includeSamples=true` to retrieve all sessions with samples for its own history UI.

Use `llmSummary` as the primary narrative source for personal tracking. If a summary is skipped or failed, summarize from metrics and rider comments conservatively.

## Monthly Summaries

```txt
GET /api/monthly-summaries
```

Use monthly summaries when available for trend-level exports or memory updates. If unavailable or empty, fall back to recent sessions.

## Memory Update Pattern

1. Read `/api/rider`.
2. Read recent `/api/sessions`.
3. Build a short proposed `memorySummary` from stable patterns and the app's `llmSummary.memoryCandidate` fields.
4. Ask the rider before writing it.
5. `PATCH /api/rider/memory` with the approved `memorySummary`.

Avoid medical claims. Do not change FTP, cTHR, or HR zones based on one ride.
