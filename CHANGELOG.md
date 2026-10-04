# Changelog

All notable changes to this project will be documented in this file.

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
