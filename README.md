# iamnotadoctor

> Current public-facing version: **0.3**

It all started in December. I bought a smart bike ergometer (a Wahoo Kickr Core 2, to be precise), excited to get some winter miles in. At first, I was thrilled to find a nice, polished cycling app that seemingly did *not* lock everything behind a subscription model. But alas, three months later, the honeymoon phase ended. It turned out it was just a free trial, and they wanted to charge me €20/month just to control my trainer—which, let's be honest, is pretty basic technology. 

I looked at alternatives like Zwift, but honestly, all those flashing numbers, virtual avatars, and gamified UI elements are just way too noisy for my attention-deficit brain (jokingly). I didn't want a 3D video game; I just wanted to ride my bike, control the resistance, look at my metrics, and listen to music or watch a video in peace.

So, I decided to do what any reasonable developer would do: **vibe code my own app.**

(And yes, I named the app **`iamnotadoctor`** because in reality, I actually *am* a doctor—but I absolutely do not want to be held legally responsible for whatever you do with this app, your workouts, your heart rate, or your health stack!)

`iamnotadoctor` is a simple, zero-subscription, local-first web application that connects directly to your FTMS-compatible smart trainer and Bluetooth heart rate monitor using the **Web Bluetooth API**. 

What started as a simple alternative ended up doing **actually much more** than the original app:
*   **LLM Workout Builder:** A local/open-source LLM can create custom tracks and workouts for you based on simple natural language prompts.
*   **Broad Format Imports:** Import pre-existing tracks in standard formats (like Zwift ZWO XML).
*   **Visual Track Extraction:** You can upload a screenshot of a workout chart, or literally just take a photo of a workout profile you drew on paper, and the AI will automatically parse and convert it into a playable track scaled to your profile.
*   **Adaptive Ride Mode:** Run an adaptive freeride where the LLM constantly monitors your live stats (heart rate, power, cadence) and dynamically rewrites the workout plan to match your needs and fatigue level.
*   **Voice Control & Mid-Ride Adjustments:** You can talk to the LLM (using voice recordings) during a ride to tell it to make the workout harder, ease up, or change focus, and it will adapt the trainer targets on the fly.
*   **Deep Post-Ride Analysis:** At the end of every session, you get a detailed LLM-generated analysis of your performance (aerobic decoupling, zone distributions, quality score) and recommended targets.

Because it's open-source and AI-friendly, you don't even need to be a developer to get it running or modify it—you can just point your agent of choice (like OpenClaw, Hermes, or whichever coding assistant you use) to this repository, and let it do the heavy lifting.

---

### 💡 Quick Things to Know Before You Start

*   **Browser Choice:** You **should use Google Chrome** (or an equivalent Chromium-based browser like Edge) for the best Bluetooth connectivity. Web Bluetooth is currently best supported in Chrome. Firefox, Safari, and other browsers do not support Web Bluetooth yet.
*   **Hardware Compatibility:** It *should* work with most FTMS-compatible smart trainers/ergometers and standard Bluetooth heart rate monitors. However, I’ve only personally checked and tested it with my own setup: a **Wahoo Kickr Core 2** and an Amazfit pulse watch.
*   **API Key Setup (Required for LLM features):** To use any of the AI-powered features (like workout screenshot extraction, the natural language workout builder, live coaching feedback, adaptive ride mode, or post-ride analysis), you must supply your own private **OpenRouter API key** in a local `.env.local` file. The core trainer control, structured workout player, and local ZWO file imports work completely offline without any API keys.
*   **Make it Yours (Zero Dev Effort):** Everyone is free to adapt the app to its will. If you want to change the UI, add features, or adjust how a workout progresses, it's super easy—just tell your AI agent of choice what to do and let it write the code.
*   **Agentic Health Stack:** If you want, your AI agent can query most of the data from the app. You can have your agent fill in your vitals, retrieve your workout history, and query it regularly to integrate with your broader personal health stack.
*   **Dev Server vs. Build Server:**
    *   **Dev Server (`npm run dev`):** This is what you run locally while writing code or letting your agent modify the app. It supports hot-reloading (your changes appear instantly in the browser) and compiles files on the fly, making development fast but the loaded code unoptimized.
    *   **Build Server (`npm run build`):** This compiles and optimizes the entire app for production, performing optimizations like minification and tree-shaking. It generates a highly optimized production bundle that runs much faster and with less overhead. Use this or `npm run start` once you're done editing and just want to run the app.
    *   **Production Free Port (`npm run build:start` or `npm run start:free`):** Builds the production bundle and starts the production server on an automatically selected free port (e.g. in environments where port 3000 might be in use).

---

## For Local Agents Given This URL

If an agent is pointed at `https://github.com/christoph-gl/iamnotadoctor` and the user says “try this”, “implement it”, “first”, or similar, treat that as a request to **bootstrap the iamnotadoctor app locally and optionally install the fitness-tracking helper skill**. Do not ask “implement what?” unless the user explicitly asks for a code feature.

Fresh-agent default path:

1. Clone the repo to a user-approved directory, or use the directory the user already has.
2. Run `npm install`.
3. Do **not** copy `.env.example` to `.env.local`. It contains optional placeholders. Create `.env.local` only when the user provides real LLM or image-extraction credentials.
4. Start with `npm run dev` or `npm run dev:portless`; the script already includes Turbopack.
5. Wait for the first Next.js compile. It can take 30-90 seconds on a fresh install. Probe `http://localhost:3000/api/rider`, not only `/`.
6. Tell the user to open Chrome or Edge and connect Bluetooth from the UI. Agents cannot grant Web Bluetooth permission.
7. If setting up an external agent, follow [`.agents/skills/iamnotadoctor-local-coach/INSTALL.md`](./.agents/skills/iamnotadoctor-local-coach/INSTALL.md). The agent should ask the rider for age, broad fitness level, goals, and constraints, then use completed rides and in-app LLM summaries for personal fitness tracking.

## Features

- **Connect & Disconnect:** Manage Bluetooth GATT connections securely and see real-time UI state for both the Smart Trainer and a separate Heart Rate Monitor (like an Amazfit pulse watch).
- **Live Telemetry:** Streams real-time Power (Watts) and Cadence (RPM) from the `Indoor Bike Data` FTMS characteristic, synchronized with live Heart Rate (BPM) from a secondary Bluetooth HRM.
- **Trainer Modes:**
  - **ERG Mode:** Set a target power (e.g. 200 W) and the trainer dynamically adjusts resistance to maintain it regardless of cadence/gearing.
  - **Resistance Mode:** Set a static percentage resistance (0-100%).
- **Interactive Workout Player:**
  - Visualize your workout timeline with a dynamic, color-coded SVG chart scaled to your personal 4DP® profile.
  - Play, pause, or click to seek to any point in the workout—your trainer's ERG resistance will instantly update.
  - Real-time calculations of workout metrics including Normalized Power (NP), Intensity Factor (IF®), and Training Stress Score (TSS®).
  - **Screen Wake Lock:** Automatically prevents your computer or tablet from sleeping or dimming the screen during an active workout session.
- **Workout Imports:**
  - **ZWO Files:** Parse and load industry-standard Zwift XML workout files directly in the browser.
  - **AI Image Import:** Upload a screenshot of a 4DP® or ERG workout chart, and an image-capable AI model will extract the structure and translate it into a playable workout scaled to your profile.
- **AI Workout Builder:** Describe today’s ride in natural language, such as “45 minutes endurance, keep HR down,” and the app builds an ERG workout from the rider profile plus the last five ride summaries. Generated rides load as drafts first; use **Save Track** to make a good one permanent in the workout picker.
- **In-Ride LLM Feedback:** When a preplanned workout starts, the app asks the LLM for a short ride-start summary. Every five minutes during the ride it sends compact 30-second telemetry snapshots plus the remaining workout and shows feedback below the Power/Cadence/HR card. For preplanned workouts this lane is feedback-only; it does not change ERG watts or rewrite the plan.
- **Post-Ride LLM Summaries:** On **Finish & Save**, add rider comments. The server computes a compact ride-analysis payload, asks an LLM for a structured summary, and stores that summary with the session in SQLite.
- **Rider Profile Management:** Configure and store your Neuromuscular Power (NM), Anaerobic Capacity (AC), Maximal Aerobic Power (MAP), Functional Threshold Power (FTP), and Cycling Threshold Heart Rate (cTHR) zones.
- **Data Export:** Download a `.csv` record of your ride telemetry containing timestamps, power, cadence, speed, heart rate, and resistance level.
- **Optional External Agent Tracking:** Local agents can read saved rides and in-app LLM summaries through local HTTP APIs, then help the rider update personal fitness tracking or the rider memory summary.
- **SQLite-backed Rider Context:** Store FTP/4DP, HR zones, age, weight, gender, and an LLM-ready rider memory summary in `.data/iamnotadoctor.sqlite`.

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. LLM Features & OpenRouter Setup:
   To enable AI features (workout building, coaching feedback, summaries), you must supply your own private **OpenRouter API key** (or other supported keys). Create a `.env.local` file in the root directory:
   ```
   LLM_CALLS_API_KEY=your_private_openrouter_api_key_here
   LLM_CALLS_MODEL=google/gemini-2.5-flash

   WORKOUT_IMAGE_EXTRACTOR_API_KEY=your_private_openrouter_api_key_here
   WORKOUT_IMAGE_EXTRACTOR_MODEL=google/gemini-2.5-flash
   ```

   Plain trainer control and workout playback work without these values. Text LLM lanes (live coach, workout builder, ride/monthly summaries) use OpenRouter through `OPENROUTER_API_KEY` or `LLM_CALLS_API_KEY`, with `LLM_CALLS_MODEL` as the shared model and optional per-lane overrides such as `LIVE_COACH_MODEL` or `RIDE_SUMMARY_MODEL`. Screenshot import can use `WORKOUT_IMAGE_EXTRACTOR_*` for its own image-capable lane.

   Do not create `.env.local` by blindly copying `.env.example`; leave optional placeholders unset unless you have real values.

   Restart `next dev` after editing `.env.local` — Next.js only reads env vars at server start.

3. Run the development server:
   ```bash
   npm run dev
   ```

   Or run through Portless for a stable HTTPS project URL:
   ```bash
   npm run dev:portless
   ```

   On first launch, wait for compilation before deciding it failed. A good readiness check is:
   ```bash
   curl -fsS http://localhost:3000/api/rider | head -c 200
   ```

4. Open [http://localhost:3000](http://localhost:3000) with your browser.

   With Portless, open [https://iamnotadoctor.localhost](https://iamnotadoctor.localhost). The project name comes from `package.json`, and agents can discover the URL with:
   ```bash
   npx portless get iamnotadoctor
   ```

> **Note:** Web Bluetooth requires a secure context (HTTPS) or `localhost`. It is currently fully supported in **Chrome** and **Edge**. Ensure no other trainer apps are actively connected to your trainer, as they typically only accept one active Bluetooth control connection at a time.
>
> Bluetooth discovery is intentionally service-filtered. The trainer picker filters for FTMS (`0x1826`), and the HRM picker filters for Heart Rate (`0x180d`) so the browser chooser does not list unrelated nearby devices.
>
> Portless command note: use `npm run dev:portless`, `npx portless`, or `npx portless run next dev --turbopack`. Do not use `portless run dev`; that tries to execute a shell command named `dev` instead of the npm script.

## Technology Stack
- Next.js (App Router)
- React
- TypeScript
- Web Bluetooth API (FTMS protocol for trainer, standard HRM protocol for heart rate)
- OpenAI SDK against OpenRouter-compatible APIs, with `zod` validation for image-to-workout extraction, workout building, live coaching, and structured ride summaries
- Tailwind CSS
- shadcn/ui components

## AI Workout Builder

The **Build Ride** button in the Workout Player sends natural-language ride instructions to `POST /api/workout-builder`. The server builds the prompt from:

- the current date/time in Europe/Berlin and ISO form
- the rider request text
- the SQLite-backed rider profile: 4DP values, cTHR, age, weight, gender, HR zones, and memory summary
- the last five saved rides, including date, metrics, rider comments, and any LLM-generated ride evaluation

The model returns structured ERG blocks (`durationSeconds`, `targetPower`, and an internal purpose). The route clamps block duration and target watts, calculates planned NP/IF/TSS, and returns the workout to the browser. It does **not** save generated workouts automatically. The browser loads the generated ride as a draft and shows **Save Track** in the builder-rationale panel; clicking it persists the workout JSON through `POST /api/workouts`, making it permanent in the route-name picker.

Useful smoke test:

```bash
curl -k -X POST https://iamnotadoctor.localhost/api/workout-builder \
  -H "Content-Type: application/json" \
  -d '{"instructions":"45 minutes endurance, mostly Z2, keep it gentle because HR ran high last ride"}'
```

If you are not using Portless, replace `https://iamnotadoctor.localhost` with `http://localhost:3000`.

## In-Ride LLM Feedback

The workout player uses `POST /api/coach/live` for app-owned, low-latency feedback during structured workouts:

- **At ride start:** when the rider presses Play at `0:00`, the browser sends `intent: "ride_start_summary"`. The payload includes the rider profile and the remaining workout blocks. The model returns a short `send_message` that summarizes the planned ride and gives one focus cue.
- **Every five minutes:** while the workout is playing, the browser sends `intent: "periodic_ride_check"`. The payload includes the rider profile, HR zones, active mode, the latest sample, ride-so-far averages, rolling 30-second snapshots from the last 10 minutes, and the remaining workout blocks.
- **Feedback-only for preplanned workouts:** the prompt tells the model to return `send_message` only for these two intents, and the client does not apply trainer or workout commands from periodic checks. Planned ERG targets remain owned by the workout timeline.

The feedback is rendered below the Power/Cadence/HR card. General live-coach calls use `LIVE_COACH_TIMEOUT_MS` (8000 ms by default), while automatic fixed-track summaries use `FIXED_TRACK_COACH_TIMEOUT_MS` (15000 ms by default). On timeout the ride keeps running and the coach panel shows an offline/detail message instead of blocking trainer control.

Experimental spoken feedback can be enabled through the OpenRouter-compatible TTS lane. Set `OPENROUTER_API_KEY` or `GROK_TTS_API_KEY` in `.env.local`, and optionally `GROK_TTS_MODEL`, `GROK_TTS_VOICE_ID`, or `GROK_TTS_TIMEOUT_MS` (30000 ms by default). When a new coach message arrives, the browser still plays the local notification chime, then requests `POST /api/coach/tts`. The browser retries one transient server failure. TTS failures remain non-blocking; the text feedback stays visible.

For local debugging, structured model calls and TTS requests/results are persisted in the SQLite `api_call_logs` table. The recent sanitized records are available at `GET /api/debug/api-calls?limit=50`; audio payloads are stored as metadata and binary content is not persisted.

## Post-Ride LLM Summaries

When the rider taps **Finish & Save**, the workout player asks for optional free-text comments. The browser posts the full `RideSession` to `POST /api/sessions`; the server enriches it through `lib/ride-summary.ts` before writing to SQLite. If no summary model/key is configured, the ride still saves with `llmSummaryStatus: "skipped"`.

Stored per-session summary fields:

- `riderComments`
- `llmSummary`
- `llmSummaryStatus`: `generated`, `skipped`, or `failed`
- `llmSummaryError`

### Technical Analysis: Ride-Summary Payload Calculations

The LLM does not receive raw telemetry as its main context. The server converts second-level samples into a compact, auditable payload in `buildRideSummaryPayload()`.

Session identity and timing:

- `startedAtIso` is derived from the first sample timestamp, falling back to the session save timestamp.
- `savedAtIso` is derived from `session.timestamp`.
- `durationSeconds` comes from `session.metrics.durationSeconds`; if absent, it falls back to `samples.length`.
- `riderComments` is the trimmed text entered in the Finish & Save dialog.

Stored ride metrics:

- `avgPower`, `avgHr`, and `avgCadence` are calculated in `calculateActualMetrics()` by averaging non-missing sample values.
- `durationSeconds` currently assumes roughly one persisted sample per second.
- Normalized Power (`np`) is calculated from rolling 30-second average power values raised to the fourth power, averaged, then fourth-rooted.
- Intensity Factor (`iff`) is `np / ftp`.
- Training Stress Score (`tss`) is `(durationSeconds * np * iff) / (ftp * 36)`. This is equivalent to the standard hourly TSS formula after unit simplification.

Rider profile context:

- The payload includes FTP, MAP, AC, NM, cTHR, age, weight, HR zones, and the current `memorySummary` from `rider_profile`.
- The image-provided 4DP values currently match the SQLite row: NM `821`, AC `335`, MAP `216`, FTP `172`.

Heart-rate zone distribution:

- Each HR zone is read from `riderProfile.hrZones`.
- For every sample with `heartRateBpm`, the code counts a second in the zone whose inclusive range contains that BPM: `minBpm <= heartRateBpm <= maxBpm`.
- Percent is `zoneSeconds / durationSeconds * 100`, rounded to one decimal.
- Samples with missing HR are not assigned to a zone; missing HR count is reported separately in data quality.

Power-zone distribution:

- Power zones are derived from current FTP, not from named workout blocks:
  - off/coasting: `<= 0 W`
  - recovery: `1 W` to `55% FTP`
  - endurance: `>55%` to `75% FTP`
  - tempo: `>75%` to `90% FTP`
  - threshold: `>90%` to `105% FTP`
  - VO2: `>105%` to `120% FTP`
  - anaerobic: `>120% FTP`
- Percent is `zoneSeconds / durationSeconds * 100`, rounded to one decimal.

Series summaries:

- Power, heart rate, cadence, speed, and resistance each get `count`, `missing`, `min`, `max`, `avg`, `median`, `p10`, and `p90`.
- Percentiles sort available values and linearly interpolate between neighboring ranks.
- Missing values are excluded from averages and percentiles, then counted explicitly.

Splits and aerobic drift:

- Split averages are computed for `first_half`, `second_half`, `first_third`, and `last_third`.
- Each split reports average power, heart rate, and cadence from non-missing values.
- Aerobic decoupling compares power-per-bpm in the first half and second half using samples with both positive power and HR.
- `percentChange` is `(secondHalfPowerPerBpm - firstHalfPowerPerBpm) / firstHalfPowerPerBpm * 100`. A negative value means less power per heartbeat later in the ride.

Data quality:

- Timestamps are converted into sample gaps in seconds.
- The payload reports average sample gap, max sample gap, gaps over two seconds, and missing seconds for power, HR, and cadence.
- The prompt instructs the model to reduce confidence when data quality is weak.

Prompt guardrails:

- The model is told to be specific with numbers, avoid medical diagnosis, avoid changing HR zones from one ride alone, and treat indoor speed as low-value unless simulation mode is relevant.
- It returns structured JSON: headline, summary, key observations, HR-zone assessment, rider-comments reflection, training-load assessment, data-quality notes, next focus, and a compact durable memory candidate.

## Optional External Agent Tracking

The browser remains the Bluetooth owner, and the app now owns all live LLM behavior: workout building, in-ride feedback, post-ride summaries, and trainer execution. External agents are optional helpers for slower personal tracking workflows after rides.

Fresh agents should not control watts, routes, workouts, or live coaching. The supported external-agent surface is profile and completed-ride tracking only.

Agents should read rider context and completed rides:

```bash
BASE_URL="$(portless get iamnotadoctor 2>/dev/null || printf http://localhost:3000)"
curl "$BASE_URL/api/rider"
curl "$BASE_URL/api/sessions"
```

On first install, the agent should ask the rider for age, broad fitness level, cycling background, goals, and constraints. It can store numeric age and other explicitly approved profile fields through `PUT /api/rider`, and qualitative fitness context in `memorySummary` through `PATCH /api/rider/memory`.

For later tracking, agents should prioritize the app-generated `llmSummary` stored on each saved ride. That summary includes a headline, key observations, HR-zone assessment, training-load assessment, suggested next focus, and a compact `memoryCandidate` for durable rider memory.

## SQLite Persistence

Runtime data is stored in `.data/iamnotadoctor.sqlite`, which is intentionally ignored by git. The database currently contains `ride_sessions`, `ride_samples`, `rider_profile`, and `monthly_summaries`.

The browser still keeps a localStorage fallback for existing history and offline resilience. On first load, if SQLite has no sessions but localStorage does, the app backfills those sessions into SQLite.

The rider profile is seeded from the original static profile and now includes:

- 4DP values: NM, AC, MAP, FTP
- cycling threshold heart rate (`cTHR`)
- heart-rate zones
- age
- weight in kg
- gender (`male`, `female`, or unset)
- `memorySummary` for future LLM-updated ride/performance notes

Use the cog button in the top right of the app to edit these values manually.

## Local Agent Architecture

The browser owns Bluetooth. Time-sensitive in-ride feedback uses the app-owned `POST /api/coach/live` endpoint, which calls the configured OpenRouter-compatible model directly. For preplanned workouts, the active UI uses this route only for rider-facing text: one ride-start summary and five-minute feedback checks. The workout timeline remains the source of truth for ERG targets.

External agents remain useful for personal fitness tracking: onboarding the rider profile, summarizing saved rides, exporting ride results into another tracking system, and proposing concise `memorySummary` updates from completed rides. They operate through local HTTP and never speak FTMS or talk to the trainer directly.

Use:

- `GET /api/rider`, `PUT /api/rider`, and `PATCH /api/rider/memory`
- `GET /api/sessions` for lightweight ride summaries
- `GET /api/sessions/:id` for one full ride with raw samples
- `GET /api/monthly-summaries` when available

Do not use external agents for live trainer control, route control, or in-ride workout adaptation. Those decisions now belong to the app's in-process LLM lanes and workout player.

### Install-once skill model

External agents do not operate by reading this repo on every tracking turn. They install a lean portable skill into their own workspace once and operate from there:

```
.agents/skills/iamnotadoctor-local-coach/
├── INSTALL.md                   ← read this first when an agent is pointed at the repo
├── dist/
│   └── agent-skill.md           ← copy into the agent runtime's skill directory as SKILL.md
└── references/
    └── api.md                   ← rider/session endpoint reference
```

What lives where:

- **Hot path** (in the installed skill, ~1–2 screens): rider/session endpoints, onboarding questions, memory update rules, slash commands, "don't" rules. Self-contained — no repo fetches at runtime.
- **Cold path** (in `references/`): endpoint shapes and smoke tests. Read once during install, then forgotten.
- **Not in the skill at all**: FTMS opcodes, SQLite schema, Web Bluetooth, workout player internals. Those live in `AGENTS.md` for someone editing the app.

`dist/agent-skill.md` starts with a `iamnotadoctor-skill-version` line. Bump it whenever the operating contract changes; installed copies use it to detect drift and re-install.

Workflow: agent points at repo once → reads [`INSTALL.md`](./.agents/skills/iamnotadoctor-local-coach/INSTALL.md) → if the iamnotadoctor app isn't running yet, walks the user through Step 0 (clone, `npm install`, optional `.env.local`, `npm run dev`) → copies `dist/agent-skill.md` into its own skills dir → asks for age and fitness context → uses ride summaries for tracking → never opens this repo again until version bumps.

## Further Development
See `AGENTS.md` for guidelines and instructions for LLMs working on this project in the future.
