import { NextResponse } from "next/server";
import { findPlannedWorkout, plannedWorkoutsCalendarUrl } from "@/lib/planned-workout";
import { readWorkoutLibrary } from "@/lib/workout-store";
import { ADAPTIVE_FREERIDE } from "@/lib/workouts";

export const dynamic = "force-dynamic";

/**
 * GET /api/workouts/planned?timeZone=Europe/Berlin
 * Today's planned workout from the calendar in PLANNED_WORKOUTS_ICAL_URL, or `planned: null`.
 */
export async function GET(request: Request) {
  if (!plannedWorkoutsCalendarUrl()) {
    return NextResponse.json({ configured: false, planned: null });
  }
  const url = new URL(request.url);
  const timeZone = url.searchParams.get("timeZone") ?? undefined;
  try {
    const library = [ADAPTIVE_FREERIDE, ...(await readWorkoutLibrary())];
    const planned = await findPlannedWorkout({ library, timeZone });
    return NextResponse.json({ configured: true, planned });
  } catch (error) {
    // Never log the calendar URL: it is a secret address.
    console.error("Failed to read planned workouts calendar:", error instanceof Error ? error.message : error);
    return NextResponse.json({ configured: true, planned: null, error: "Calendar unavailable" }, { status: 502 });
  }
}
