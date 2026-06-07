---
iamnotadoctor-skill-version: 8
name: iamnotadoctor-local-fitness-tracker
description: Help a rider use iamnotadoctor ride history and in-app LLM summaries for personal fitness tracking. Read rider profile and saved sessions over local HTTP; do not control trainer watts, routes, workouts, or live coaching.
---

# iamnotadoctor Fitness Tracking Helper

The iamnotadoctor app owns Bluetooth, workouts, live coaching, workout building, and ride-summary LLM calls. Your role is optional and slower: help the rider keep personal fitness records, learn from completed rides, and copy useful ride-summary insights into the rider memory.

Do not try to control the trainer. Do not send ERG/resistance/workout commands. Use only the tracking endpoints below.

## Base URL

```bash
BASE_URL="$(portless get iamnotadoctor 2>/dev/null || printf http://localhost:3000)"
```

If the user gives a different local URL, use that. The local iamnotadoctor tracking endpoints do not require authentication.

## First-Run Onboarding

When first installed for a rider, ask for only the information needed to make fitness tracking useful:

- age
- broad fitness level and cycling background, for example beginner, returning, recreational, structured training, racer, injury/illness comeback
- goals and constraints, for example endurance, weight management, FTP gains, low-HR base, time limits, recovery concerns
- optional: weight, gender, known FTP/4DP/cTHR, and HR-zone preferences if the rider knows them

Then read `GET /api/rider`. Update only fields the API supports:

- Put numeric `age` into `age`.
- Put known weight/gender/cTHR/4DP values into their existing fields.
- Put qualitative fitness level, goals, constraints, and tracking preferences into `memorySummary` with `PATCH /api/rider/memory`.
- Use `PUT /api/rider` only for explicitly approved profile-field changes.

## Endpoints You Use

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/rider` | Rider profile, HR zones, and memory summary. |
| PUT | `/api/rider` | Update supported rider-approved profile fields. |
| PATCH | `/api/rider/memory` | Update approved rider memory only. |
| GET | `/api/sessions` | Saved ride summaries with metrics, rider comments, and in-app LLM summaries. |
| GET | `/api/sessions/:id` | One full saved ride with raw samples when needed. |
| GET | `/api/monthly-summaries` | Monthly rollups when available. |

## Session Fields To Prioritize

`GET /api/sessions` returns rides newest-first without raw samples. Each session may include:

- `workoutName`
- `timestamp`
- `sampleCount`
- `metrics`: duration, TSS, IF, average power, HR, cadence
- `riderComments`
- `llmSummaryStatus`
- `llmSummary`: headline, summary, key observations, HR-zone assessment, training-load assessment, data-quality notes, suggested next focus, and `memoryCandidate`

Use the app-generated `llmSummary` as the primary narrative source when present. If `llmSummaryStatus` is `skipped` or `failed`, summarize from metrics and rider comments conservatively.

## Slash Commands

Implement these if your environment supports slash commands:

- `/inad_status` - read `/api/rider` and latest sessions; summarize current profile and last ride.
- `/inad_recent` - summarize the last 3-5 saved rides, emphasizing LLM summaries and trends.
- `/inad_export` - prepare a compact personal fitness tracking entry from recent rides.
- `/inad_memory_update` - propose a short `memorySummary` update from completed rides; ask before writing it.

## Memory Update Rules

Only update `memorySummary` after completed rides. Keep it short, rider-facing, and useful for future in-app LLM calls. Good memory notes include stable patterns, goals, constraints, and recent training response. Avoid medical claims and avoid rewriting FTP/HR zones from one ride.

Before writing memory, ask the rider and then use `PATCH /api/rider/memory`. Before `PUT /api/rider`, read the current profile and change only explicitly approved profile fields.

## Don't

- Don't send FTMS bytes or talk to Bluetooth directly.
- Don't queue trainer commands or workout plans.
- Don't read or write `.data/iamnotadoctor.sqlite`.
- Don't overwrite rider-entered profile fields without confirmation.
- Don't treat one ride as enough evidence to change FTP, cTHR, or HR zones.

## If The App Isn't Running

`curl $BASE_URL/api/rider` returning a connection error means the iamnotadoctor Next.js app is not up. Point the user at the bootstrap flow:

> Quick setup: `git clone https://github.com/christoph-gl/iamnotadoctor.git && cd iamnotadoctor && npm install && npm run dev`, then open the app in Chrome or Edge and connect the trainer from the UI. See `.agents/skills/iamnotadoctor-local-coach/INSTALL.md` for the full setup path.

Wait for the user to confirm the app is up before retrying.
