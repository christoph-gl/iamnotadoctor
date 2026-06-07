# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-06-07

### Added
- Added package scripts for convenience in production/sandbox execution:
  - `start:free`: Starts the Next.js production server on an automatically allocated free port (`PORT=0`).
  - `build:start`: Builds the production bundle and runs it on a free port in one command.

### Fixed
- Fixed LLM repetition and looping responses in the Live Coach API (`POST /api/coach/live`):
  - Added strict `maxLength: 500` validation constraints directly to the JSON schema `RiderCueSchema` sent to the model.
  - Refactored the live coach system prompt, consolidating critical anti-repetition, layout, and style rules at the very top under `CRITICAL OUTPUT RULES`.
  - Replaced the assistant-only feedback history in the workout player with structured user/assistant conversation history to avoid the LLM "echo chamber" effect.
  - Raised default temperature to `0.4` for adaptive instructions to increase response diversity.
  - Reduced overall token budget boundaries (`maxOutputTokens` from `1800` to `1200` for adaptive intents, and `1200` to `800` for non-adaptive intents) to prevent rambling.
  - Replaced the post-processing deduplication/regex-cleansing logic with these upstream fixes to preserve output naturalness.
