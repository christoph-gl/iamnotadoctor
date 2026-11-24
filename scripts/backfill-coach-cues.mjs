#!/usr/bin/env node
// Adds voice coach cue points to saved workouts in ./workouts that have none.
// Workouts that already have coachCues are left alone.
//
//   node scripts/backfill-coach-cues.mjs [--ftp 250] [--dry-run]
//
// --ftp only changes the "% FTP" in the cue text; target watts come from the
// blocks. Needs Node 24+ (it imports the TypeScript cue logic directly).
import fs from "node:fs/promises";
import path from "node:path";
import { deriveCoachCues } from "../lib/coach-cues.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const ftpIndex = args.indexOf("--ftp");
const ftp = ftpIndex >= 0 ? Number(args[ftpIndex + 1]) : 172;
if (!Number.isFinite(ftp) || ftp <= 0) {
  console.error("--ftp must be a positive number");
  process.exit(1);
}

const dir = path.join(process.cwd(), "workouts");
let updated = 0;
for (const file of (await fs.readdir(dir)).sort()) {
  if (file.startsWith(".") || !file.endsWith(".json")) continue;
  const filePath = path.join(dir, file);
  const workout = JSON.parse(await fs.readFile(filePath, "utf-8"));
  if (Array.isArray(workout.coachCues) && workout.coachCues.length > 0) continue;
  if (!Array.isArray(workout.blocks) || workout.blocks.length === 0) continue;
  const coachCues = deriveCoachCues(workout.blocks, ftp);
  console.log(`${file}: ${workout.name} -> ${coachCues.length} cue points`);
  if (!dryRun) {
    await fs.writeFile(filePath, JSON.stringify({ ...workout, coachCues }, null, 2), "utf-8");
  }
  updated += 1;
}
console.log(`${dryRun ? "Would update" : "Updated"} ${updated} workout(s).`);
