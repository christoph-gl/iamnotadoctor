# LLM AI Agents Guidelines (`AGENTS.md`)

This document provides instructions and context for any Large Language Model (LLM) or AI agent working on the iamnotadoctor project.

## Public-facing release convention

Whenever changes are pushed to the `public-facing` branch:

- Update the current public-facing version line at the top of `README.md`.
- Add or update the corresponding dated release entry in `CHANGELOG.md`.
- Keep the README version and changelog release number aligned.

The current public-facing release is version `0.3`.

## Fresh Public-URL Agent Behavior

If the user gives only the public GitHub URL, or says “try this again”, “implement it”, “first”, or similar after sharing the URL, assume they want the first useful setup path:

1. Clone/open the repo.
2. Install dependencies with `npm install`.
3. Start the iamnotadoctor app locally.
4. Verify `GET /api/rider`.
5. Install the lean portable skill from `.agents/skills/iamnotadoctor-local-coach/dist/agent-skill.md` only if the user wants an optional external fitness-tracking agent.
6. Guide the user through browser Bluetooth connection. If installing an external agent, have it ask for age, broad fitness level, goals, and constraints.

Do not ask “implement what?” for this bootstrap request. Ask a narrow question only when needed, such as where to clone the repo or whether the user wants the optional local fitness-tracking helper.

Fresh setup footguns:
- Do not run `cp .env.example .env.local`; `.env.example` contains optional placeholders, not runnable secrets.
- Do not append `-- --turbopack` to `npm run dev`; the script already includes Turbopack.
- Do not decide the server failed after a short wait. First Next.js compile can take 30-90 seconds.
- Probe `http://localhost:3000/api/rider` or `https://iamnotadoctor.localhost/api/rider`, not just the root page.
- Web Bluetooth must be completed by the user in Chrome or Edge via UI button clicks.

## Context & Domain

This is a **Next.js (App Router) / React / TypeScript** application interacting directly with a FTMS-compatible smart trainer and an external Bluetooth Heart Rate Monitor (HRM).
Communication relies heavily on the **Web Bluetooth API** (`navigator.bluetooth`).

### FTMS (Trainer) Constraints
- **FTMS Service UUID:** `0x1826`
- **Indoor Bike Data Characteristic UUID:** `0x2ad2`
- **Fitness Machine Control Point Characteristic UUID:** `0x2ad9`

### HRM Constraints
- **Heart Rate Service UUID:** `0x180d`
- **Heart Rate Measurement Characteristic UUID:** `0x2a37`

## Core Concepts to Retain

1. **Bluetooth Constraints:** 
   - Bluetooth connection requests MUST be triggered by user interactions (e.g. `onClick` of a button).
   - Web Bluetooth requires HTTPS or `localhost` (secure context) to function.
   - Disconnect handling is crucial (`gattserverdisconnected` events) for multiple parallel connections.
   - Device discovery should stay service-filtered: trainer uses FTMS (`filters: [{ services: [0x1826] }]`), HRM uses Heart Rate (`filters: [{ services: [0x180d] }]`). Do not return to broad `acceptAllDevices: true` unless the user explicitly wants a troubleshooting mode.
2. **FTMS Specifics:**
   - **ERG Mode (Target Power):** Uses Opcode `0x05`. Sends watts as `int16`. Trainer auto-adjusts resistance based on cadence.
   - **Resistance Mode:** Uses Opcode `0x04`. Sends percentage as `int16`. Note: While the FTMS spec defines a resolution of `0.1` (so 100% = 1000), some trainers deviate from the spec and expect a direct `0-100` scale (100% = 100).
   - The trainer will drop the control link or fail to execute commands if `requestControl()` (Opcode `0x00`) or `reset()` (Opcode `0x01`) is missing during initialization.
3. **Data Decoding:**
   - The Indoor Bike Data parser requires reading a `flags` bitmask to determine exactly which values (cadence, power, speed, distance) are present in the byte array.
   - Heart rate is pulled primarily from the external HRM (`hr-client.ts`), but can be supplemented via the FTMS payload if the trainer provides it natively.
4. **Workout Player Engine:**
   - The app features a robust workout player (`components/workout-player.tsx`) that reads from `lib/workouts.ts`. 
   - Workouts are scaled against the loaded rider profile (FTP, MAP, AC, NM). `lib/profile.ts` contains the default seed profile, but runtime values are SQLite-backed.
   - The player handles automatic ERG mode adjustments as the timeline progresses.
   - The chart calculates real-time NP, TSS, and IF based on the loaded workout blocks.
   - **Screen Wake Lock:** Uses the `navigator.wakeLock` API to prevent the device from sleeping while a workout is playing. It re-requests the lock on `visibilitychange` to handle tab switching.
5. **Workout Imports (ZWO & AI):**
   - The app natively parses standard XML `.zwo` (Zwift) files directly in the browser via `DOMParser`.
   - The app can extract workouts from screenshots using an image-capable multimodal model. The backend endpoint (`/api/extract-workout/route.ts`) expects `WORKOUT_IMAGE_EXTRACTOR_API_KEY` and `WORKOUT_IMAGE_EXTRACTOR_MODEL` in `.env.local` for screenshot imports only, or falls back to the shared OpenRouter config.
   - All other in-app LLM lanes use OpenRouter through `OPENROUTER_API_KEY` or `LLM_CALLS_API_KEY` plus `LLM_CALLS_MODEL` via `lib/llm-calls-env.ts`, with optional per-lane key/model overrides.
6. **Live In-Ride LLM Lane:**
   - During rides, avoid external-agent callback paths for time-sensitive UI feedback. Use `POST /api/coach/live`, which calls the configured OpenRouter-compatible model directly.
   - Configure `LIVE_COACH_API_KEY` and `LIVE_COACH_MODEL` for this lane, or rely on shared `OPENROUTER_API_KEY` / `LLM_CALLS_API_KEY` and `LLM_CALLS_MODEL`. Do not use `WORKOUT_IMAGE_EXTRACTOR_*` for live coach. `LIVE_COACH_TIMEOUT_MS` defaults to 8000 so a slow provider does not stall the ride UI indefinitely.
   - For preplanned workouts, the current UI uses this lane as feedback-only. At Play from `0:00`, it sends `intent: "ride_start_summary"` with rider profile, HR zones, and remaining workout blocks. Every five minutes while playing, it sends `intent: "periodic_ride_check"` with rider profile, HR zones, latest sample, ride-so-far averages, 30-second telemetry snapshots, and the remaining workout.
   - For `ride_start_summary` and `periodic_ride_check`, the model is instructed to return `send_message` only, and the client does not apply trainer/workout commands from these periodic checks. Preplanned workout ERG targets remain owned by the workout timeline.
   - Experimental spoken feedback uses `POST /api/coach/tts`. Keep TTS credentials server-side (`OPENROUTER_API_KEY` or `GROK_TTS_API_KEY`). The route calls the configured OpenRouter-compatible TTS model with voice `sal` by default and returns MP3 audio. TTS failure must not block ride control or text feedback.
   - External agents should not own live coaching or trainer control. They are optional helpers for post-ride fitness tracking and rider-profile/memory updates from completed ride summaries.
7. **Workout Builder and Post-Ride Summary LLM Lanes:**
   - `POST /api/workout-builder` creates an ERG workout from rider instructions, current Europe/Berlin date/time, the SQLite rider profile, and the last five saved ride summaries. It returns a draft workout and rationale; it must not persist the workout automatically. The browser shows **Save Track** for drafts the rider wants to keep permanently in `workouts/`.
   - Configure `WORKOUT_BUILDER_API_KEY` / `WORKOUT_BUILDER_MODEL` for this lane. It falls back through `RIDE_SUMMARY_API_KEY`, `LIVE_COACH_API_KEY`, `OPENROUTER_API_KEY`, and `LLM_CALLS_API_KEY`.
   - `POST /api/sessions` enriches finished rides with a structured LLM summary before SQLite persistence. The payload is derived in `lib/ride-summary.ts` from metrics, HR/power zone distributions, splits, aerobic decoupling, data quality, rider profile, and rider comments. It should not send raw telemetry as the primary prompt context.
   - Configure `RIDE_SUMMARY_API_KEY` / `RIDE_SUMMARY_MODEL` for this lane, or rely on `LLM_CALLS_*`. If no key is configured, saving still succeeds with `llmSummaryStatus: "skipped"`.
8. **SQLite Persistence:**
   - Runtime data lives in `.data/iamnotadoctor.sqlite`, ignored by git.
   - `lib/db.ts` owns schema creation and persistence functions. Keep DB initialization lazy and server-side.
   - Current tables: `ride_sessions`, `ride_samples`, `rider_profile`, and `monthly_summaries`.
   - The app still keeps localStorage fallback/backfill for old ride history, but new saved sessions go through `/api/sessions`.

## Local Agent / LLM Control Architecture

The architecture intentionally does **not** expose an MCP server. The browser remains the Bluetooth owner. The Next.js app exposes small local HTTP endpoints that optional external agents can use for rider profile and completed ride history.

### Three layers, three audiences

| Layer | Lives in | Audience | Read when |
| --- | --- | --- | --- |
| **App internals** (FTMS, SQLite, Web Bluetooth, workout player) | `AGENTS.md`, `lib/`, `components/` | Someone editing the iamnotadoctor app itself | Code changes |
| **One-time setup** (bootstrap, onboarding, smoke tests) | `.agents/skills/iamnotadoctor-local-coach/INSTALL.md` and `references/api.md` | Agent doing first-time install | Once per machine, plus troubleshooting |
| **Operating contract** (profile/session endpoints, tracking loop, memory rules) | `.agents/skills/iamnotadoctor-local-coach/dist/agent-skill.md` | The running agent | Every tracking turn |

External agents are expected to **install** the lean portable skill from `.agents/skills/iamnotadoctor-local-coach/dist/agent-skill.md` into their own workspace once, then operate without re-reading this repo. Install flow: [`.agents/skills/iamnotadoctor-local-coach/INSTALL.md`](.agents/skills/iamnotadoctor-local-coach/INSTALL.md). Authoring guidance for the skill itself: `.agents/skills/iamnotadoctor-local-coach/SKILL.md`. The dist skill carries a `iamnotadoctor-skill-version` line; bump it when the operating contract changes so installed copies can detect drift.

External-agent setup is agent-only: do not edit the iamnotadoctor Next.js app; use the existing local APIs as a stable service.

### Base URL

When the app is started with Portless, prefer the stable project URL `https://iamnotadoctor.localhost`. Discover it with `portless get iamnotadoctor`. If Portless is not running or the HTTPS certificate is not trusted by the calling process, fall back to the direct dev-server URL such as `http://localhost:3000`.

### Browser Ownership
- The browser tab owns Web Bluetooth and sends FTMS commands.
- External agents should not attempt to talk directly to the trainer.
- Do not document or build new external-agent behavior that controls trainer watts, routes, workouts, or live coaching unless the user explicitly asks to revive that architecture and you also add an explicit client surface for it.

### External Agent Tracking Endpoints
- `GET /api/rider` returns the current rider profile.
- `PUT /api/rider` merges approved rider-profile field updates into the current profile.
- `PATCH /api/rider/memory` updates only `memorySummary`.
- `GET /api/sessions` returns saved ride summaries with metrics, sample count, rider comments, and in-app LLM summaries, but not raw samples.
- `GET /api/sessions/:id` returns one full saved ride with samples when raw telemetry is needed.
- `GET /api/monthly-summaries` returns rollups when available.
- These local endpoints do not require authentication.

On first install, an external agent should ask the rider for age, broad fitness level, cycling background, goals, and constraints. Store numeric age in `age` and qualitative fitness context in `memorySummary`. Store weight, gender, cTHR, or 4DP values only when the rider explicitly provides them.

Completed ride summaries may include `llmSummaryStatus` and `llmSummary`. Agents should prefer those app-generated summaries over raw telemetry when helping the rider update personal fitness tracking or proposing a `memorySummary` update.

### Live Coaching Boundary
- Use `POST /api/coach/live` for in-ride, latency-sensitive app feedback. For preplanned workouts, `ride_start_summary` and `periodic_ride_check` are text-only and must not adapt the workout or trainer load.
- Keep external agents out of live trainer control. External agents are for post-ride tracking, rider memory, and exporting completed ride results.

### Rider Profile
The rider profile is seeded from `DEFAULT_RIDER_PROFILE` and stored in SQLite. It currently includes:
- 4DP values: `nm`, `ac`, `map`, `ftp`
- `cTHR`
- HR zones with names, percentage labels, min/max BPM, and colors
- `age`
- `weightKg`
- `gender` (`male`, `female`, or unset)
- `memorySummary`

The settings cog in the app opens a modal for manual profile editing. External agents may propose `memorySummary` updates after full rides, especially using `llmSummary.memoryCandidate`, but should ask before writing.

### Important Future Agent Rules
- Do not put FTMS byte encoding in prompts or agent glue.
- Avoid high-frequency external-agent loops. Use `/api/coach/live` for in-app ride feedback and let the app handle real-time trainer execution.
- Use `/api/rider`, `/api/sessions`, and `/api/monthly-summaries` as the external-agent context surface.
- Prefer adding new server routes or DB helpers over reading `.data/iamnotadoctor.sqlite` directly from external scripts.

## UI/UX Rules

- Follow the existing **shadcn/ui** design system (e.g. `components/ui/button.tsx`, `dialog.tsx`).
- Tailwind CSS is used for all styling. Use standard layout primitives (`flex`, `gap-*`, `p-*`, `grid`).
- Emphasize visual feedback for hardware state (e.g., connected, connecting, disconnected, loading spinners, connection status dots).
- Validate state and throw sensible/alert errors if the Bluetooth hardware connection drops or fails.

## Future Development Roadmap

- **Simulation Mode:** Implement FTMS Opcode `0x11` (Set Indoor Bike Simulation Parameters) for simulated grade/incline. This requires sending simulated wind resistance and track gradient.
- **Workout Builder UI:** Create a drag-and-drop timeline UI where a user can manually construct custom workouts without needing to write JSON or import ZWO files.
- **Live Telemetry Charting:** Use a charting library (like Recharts, which is compatible with shadcn/ui) to plot actual live Power/Cadence/HR data as the ride progresses, overlaying it on top of the planned workout chart.
- **Save Workouts via Database:** Imported/saved workouts still use JSON files under `workouts/`; consider moving them behind SQLite later.
- **External Agent Integration:** External agents are optional fitness-tracking helpers. They install the portable skill, read rider context and saved ride summaries, and help update personal tracking or rider memory. Live in-ride coaching belongs to `/api/coach/live`.
