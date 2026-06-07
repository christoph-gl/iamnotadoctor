# Optional Telegram Tracking Notes

Telegram can be used as a conversation surface for personal fitness tracking, not trainer control.

Recommended commands:

- `/inad_status` - summarize rider profile and latest saved ride.
- `/inad_recent` - summarize the last 3-5 saved rides, prioritizing `llmSummary`.
- `/inad_export` - prepare a compact fitness-tracking entry from recent rides.
- `/inad_memory_update` - propose a short rider memory update and ask before writing it.

Do not implement Telegram commands that set ERG watts, resistance, routes, workouts, or live ride control. The supported external-agent scope is profile, completed-ride summaries, exports, and approved memory updates.
