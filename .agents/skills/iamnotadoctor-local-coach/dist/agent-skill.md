---
iamnotadoctor-skill-version: 11
name: iamnotadoctor-local-fitness-tracker
description: Help a rider use their iamnotadoctor cycling app from an agent - ride history and stats, in-app LLM ride summaries, rider profile and memory, workouts, and trainer control on request. Uses the app's MCP server (or HTTP), locally or on the rider's own domain.
---

# iamnotadoctor Agent Skill

The iamnotadoctor app owns Bluetooth, the workout player, live in-ride coaching, workout building, and ride-summary LLM calls. You help the rider keep fitness records, learn from completed rides, manage their profile and workouts, and change the trainer when they ask.

## Connection

The rider chose one of two setups during install (check your memory):

- **Local:** base URL `http://localhost:3000` (or `https://iamnotadoctor.localhost` with Portless). No authentication. Only works if you run on the rider's computer.
- **Hosted:** base URL `https://<their domain>`. Send `Authorization: Bearer <APP_AUTH_TOKEN>` on every request. Without it the app answers 401.

Prefer the MCP server at `<base URL>/api/mcp`. Fall back to the HTTP endpoints below if your runtime has no MCP. Never print or log the token.

## First-Run Onboarding

When first installed for a rider, ask only for what makes tracking useful:

- age
- broad fitness level and cycling background (beginner, returning, recreational, structured training, racer, injury/illness comeback)
- goals and constraints (endurance, weight management, FTP gains, low-HR base, time limits, recovery concerns)
- optional: weight, gender, known FTP/4DP/cTHR, HR-zone preferences

Put numeric age in `age`, explicitly given weight/gender/cTHR/4DP in their fields, and qualitative context in `memorySummary`.

## MCP Tools

| Area | Tools |
| --- | --- |
| Rider | `get_rider_profile`, `update_rider_profile`, `update_rider_memory` |
| Ride history | `list_rides` (date range, workout name, paging), `get_ride` (full LLM evaluation, optional downsampled samples), `get_ride_stats` (totals, optionally per week or month), `delete_ride` |
| Rollups | `list_monthly_summaries`, `generate_monthly_summary` |
| Workouts | `list_workouts`, `get_workout`, `build_workout` (AI build like the app's Build button; saves to the library and loads it into the open tab by default, `save`/`load` to opt out), `save_workout`, `set_coach_cues` (voice coach cue points of a saved workout), `delete_workout` |
| Trainer | `get_trainer_status`, `set_erg_power`, `set_resistance`, `load_workout`, `start_workout`, `pause_workout`, `seek_workout`, `finish_ride`, `discard_ride` |

## HTTP Fallback

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/rider` | Rider profile, HR zones, memory summary. |
| PUT | `/api/rider` | Update approved profile fields (partial patch). |
| PATCH | `/api/rider/memory` | `{ "memorySummary": "..." }` only. |
| GET | `/api/sessions` | Saved rides, newest first, with metrics, comments, `llmSummary`; no samples. |
| GET | `/api/sessions/:id` | One ride with raw samples. |
| GET | `/api/monthly-summaries` | Monthly rollups when available. |

Trainer control is only available over MCP.

## Using Ride Data

Each saved ride may carry `llmSummary` (headline, summary, key observations, HR-zone and training-load assessment, data-quality notes, suggested next focus, `memoryCandidate`). Use it as the primary narrative source. If `llmSummaryStatus` is `skipped` or `failed`, summarize conservatively from metrics and rider comments. Use `get_ride_stats` for weekly/monthly load questions instead of adding up rides yourself.

## Setting Up a Ride

When the rider asks for a workout for today ("45 min endurance, legs are tired"):

1. Call `get_trainer_status` to see whether the app tab is open.
2. Call `build_workout` with the rider's words as `instructions`. It uses the rider profile and the last five rides, saves the workout to the library and loads it into the open tab's player (not started). Pass `save: false` for a one-off, `load: false` to only prepare it.
3. Tell the rider the workout name, duration, TSS/IF and the `rationale`. If `loaded.ok` is false, the workout is in the library: ask them to open the app (signing in when hosted), connect the trainer and pick it there, or call `load_workout` with its id once the tab is open.
4. Call `start_workout` only when the rider says they are ready.

To use a workout the rider describes exactly (fixed blocks), use `save_workout` or `load_workout` with `blocks` instead of the AI builder.

### Voice coach cue points

Every workout can carry `coachCues`: the moments where the in-app voice coach speaks. The app uses them by default; the rider can switch the player to fixed intervals (every 1, 3, 5, 10 or 15 min) instead. `build_workout` adds cues itself. When you write blocks yourself (`save_workout`, `load_workout`), also send `coachCues`; to add or change cues on an existing saved workout, read it with `get_workout` and call `set_coach_cues`.

Each cue is `{ atSeconds, focus }` or `{ atSeconds, message }`:

- `focus` briefs the in-app AI coach on what this moment is about; it turns that into one spoken line using live telemetry. Example: `"Rep 3 of 6 starts in 15 s: 1 min at 335 W. One pacing cue."`
- `message` is a fixed line spoken word for word without an AI call, for scripted protocols where timing must be exact (the built-in power profile test uses these).

Place cues where a coach would talk, not on a timer:

- Long steady or Z2 rides: few cues, about every 15-20 min, plus ride start and cooldown.
- Intervals: about 15 s before each effort, halfway through efforts of 4 min or more, at the start of longer recoveries, at the cooldown.
- Sets of short reps (under about 1 min with short rests): announce the set, check in every few minutes and call the last rep instead of cueing every rep.
- Always one cue at 0; keep cues at least 45 s apart.

Workouts without cues get cues derived from their blocks, so cues are an improvement, not a requirement.

## Trainer Control

Only when the rider asks, and one command per request (the ride setup above counts as one request):

1. Call `get_trainer_status` first. If `appTabConnected` is false or `trainerConnection` is not `"connected"`, ask the rider to open the app in Chrome or Edge (signing in when hosted) and click **Connect**. You cannot connect Bluetooth.
2. Then send the command. While a workout plays, `set_erg_power` overrides the target only until the next workout step.
3. Confirm before `finish_ride`, `discard_ride`, `delete_ride`, or `delete_workout`.

Live in-ride coaching belongs to the app. Do not poll status or send commands in a loop.

## Slash Commands

Implement these if your environment supports slash commands:

- `/inad_status` - profile summary, last ride, and trainer status.
- `/inad_recent` - summarize the last 3-5 rides, emphasizing LLM summaries and trends.
- `/inad_week` - this week's load via `get_ride_stats`, compared with recent weeks.
- `/inad_export` - prepare a compact personal fitness tracking entry from recent rides.
- `/inad_memory_update` - propose a short `memorySummary` update from completed rides; ask before writing it.

## Memory Update Rules

Only update `memorySummary` after completed rides. Keep it short, rider-facing, and useful for future in-app LLM calls: stable patterns, goals, constraints, recent training response. Avoid medical claims. Ask before writing. Change other profile fields only with explicit approval, and never change FTP, cTHR, or HR zones from one ride.

## Don't

- Don't send FTMS bytes or talk to Bluetooth directly.
- Don't read or write `.data/iamnotadoctor.sqlite`.
- Don't run high-frequency loops against the trainer tools.
- Don't share, print, or commit the hosted access token.

## If The App Isn't Reachable

- Connection error: the app isn't running (Local) or the server or proxy is down (Hosted). Ask the rider to start it: Local `npm run dev` in the repo folder; Hosted, check the service (`sudo systemctl status iamnotadoctor`).
- 401 (Hosted): the token is missing or was rotated. Ask the rider for the current `APP_AUTH_TOKEN`.
- 404 on everything when using a non-localhost address: the app is in Local mode, which only answers on `localhost`.

Full setup instructions: `.agents/skills/iamnotadoctor-local-coach/INSTALL.md` and `docs/HOSTING.md` in https://github.com/christoph-gl/iamnotadoctor.
