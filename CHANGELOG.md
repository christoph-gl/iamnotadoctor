# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Voice coach cue points: workouts can carry `coachCues`, the moments where the voice coach speaks (sparse on long Z2 rides, before efforts, halfway through long efforts and at recoveries on interval sessions). The player uses them by default; the Coach control can still switch to a fixed 1/3/5/10/15-minute interval. Workouts without cues get cues derived from their blocks.
- MCP: `save_workout` and `load_workout` accept `coachCues`, the new `set_coach_cues` tool changes them on a saved workout, `list_workouts`/`get_workout` report them, and the initialize instructions tell agents how to place them. `build_workout` now asks the model for cue points too. Agent skill version 11.
- `scripts/backfill-coach-cues.mjs` adds derived cue points to saved workouts that have none. The workouts in `workouts/` and the built-in workouts now have cue points.

### Changed
- The power profile test speaks fixed, scripted instructions matched to its resistance-mode protocol (gear and cadence pacing, countdowns and "go" calls for the 5 s, 1 min, 5 min and 20 min efforts) instead of AI comments, so the timing is exact.

## [0.6] - 2026-11-01

### Changed
- MCP `build_workout` now works like the app's Build button: it saves the built workout to the library and loads it into the open app tab (not started) by default, so an agent can set up a ride session in one call. Pass `save: false` / `load: false` to opt out; the result reports `saved` and `loaded`.
- The MCP server sends short usage instructions on initialize (how to set up a ride, trainer and confirmation rules), so any MCP client learns the flow without installing the skill.
- Agent skill version 10: new "Setting Up a Ride" section (`get_trainer_status` -> `build_workout` -> `start_workout` on the rider's word).

### Fixed
- The AI workout builder failed with "400 Provider returned error" on Gemini models (`~google/gemini-flash-latest`), which reject `maxItems` in the structured-output schema. The 80-block limit is now checked after parsing.

## [0.5] - 2026-11-01

### Added
- MCP server at `/api/mcp` (Streamable HTTP via `mcp-handler`) with 23 tools: rider profile and memory, ride history (filter by date or workout, full LLM evaluation, downsampled telemetry), ride statistics overall or per week or month, monthly summaries, workout library (list, inspect, AI-build, save, delete), and trainer control.
- Trainer control for agents through the open app tab: set ERG watts or resistance, load, start, pause or seek a workout, finish and save or discard the ride. The tab relays queued commands via `/api/trainer-bridge`; Bluetooth stays in the browser.
- Hosted mode as a second official setup next to local: setting `APP_AUTH_TOKEN` protects every page and API route. Browsers sign in once at `/login` (30-day session), agents send the token as a bearer token. See `docs/HOSTING.md`.
- `docs/HOSTING.md`: comparison of the local and hosted setups and a step-by-step guide (service, HTTPS reverse proxy, verification, maintenance).

### Changed
- Local mode now only answers requests addressed to `localhost`, blocking other websites from reaching the app's APIs.
- Agent onboarding (README, `AGENTS.md`, skill `INSTALL.md`) starts by explaining the local and hosted setups and letting the user choose. The portable agent skill is now version 9: MCP first, hosted token handling, trainer control on rider request.
- The upcoming-target countdown is now a horizontal bar above the ERG slider that fills over the last 10 seconds before a power change.
- Workout file storage and the AI workout builder moved into shared server helpers (`lib/workout-store.ts`, `lib/workout-builder.ts`) used by both the HTTP routes and MCP tools.

## [0.4] - 2026-10-04

### Changed
- Redesigned the dashboard layout: the Time / Cadence / HR telemetry strip now spans the full width beneath both columns, with larger, responsive readouts and the HR zone shown below the heart rate.
- Moved live power into the Workout Controller's Power card, showing current watts next to the target, plus a "Next · in Ns" countdown before workout target changes.
- Cleaned up the Power card: the target is shown once, the active trainer mode appears as a status badge in the card header, and the ERG and resistance controls use a compact slider and input row with an upcoming-target marker on the ERG slider.
- Removed the separate Active Mode / Time ribbon from the player console; that information now lives in the Power card and telemetry strip.
- Workout chart now uses the shared card background and stretches to align with the left column.
- Upgraded Next.js to `16.3.3`, `eslint-config-next` to `16.3.3`, and Zod to `^4.5.4`.

## [0.3] - 2026-08-11

### Added
- Added package scripts for convenience in production/sandbox execution:
  - `start:free`: Starts the Next.js production server on an automatically allocated free port (`PORT=0`).
  - `build:start`: Builds the production bundle and runs it on a free port in one command.
- Added SQLite-backed API call logging for structured LLM requests/results and TTS requests/results.
- Added the local `GET /api/debug/api-calls?limit=50` endpoint for inspecting sanitized recent AI calls.

### Fixed
- Fixed LLM repetition and looping responses in the Live Coach API (`POST /api/coach/live`):
  - Added strict `maxLength: 500` validation constraints directly to the JSON schema `RiderCueSchema` sent to the model.
  - Refactored the live coach system prompt, consolidating critical anti-repetition, layout, and style rules at the very top under `CRITICAL OUTPUT RULES`.
  - Replaced the assistant-only feedback history in the workout player with structured user/assistant conversation history to avoid the LLM "echo chamber" effect.
  - Raised default temperature to `0.4` for adaptive instructions to increase response diversity.
  - Reduced overall token budget boundaries (`maxOutputTokens` from `1800` to `1200` for adaptive intents, and `1200` to `800` for non-adaptive intents) to prevent rambling.
  - Replaced the post-processing deduplication/regex-cleansing logic with these upstream fixes to preserve output naturalness.
- Prevented overlapping or stale coach speech from interrupting the current spoken message.
- Deduplicated the 10-second pre-transition resistance notification so each resistance change is announced once.
- Rejected structured live-coach responses that end with `finish_reason: "length"` and increased the short-coach output budget, preventing incomplete cues such as "Your heart" from being spoken or added to conversation history.
- Upgraded Next.js from `16.2.12` to `16.3.0`.
