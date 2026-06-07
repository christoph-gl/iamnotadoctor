import { NextResponse } from "next/server";
import type { RideSession } from "@/lib/sessions";
import {
  deleteRideSessionById,
  getRiderProfileFromDb,
  insertRideSession,
  listRideSessionSummaries,
  listRideSessions,
} from "@/lib/db";
import { summarizeRideSession } from "@/lib/ride-summary";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const includeSamples = url.searchParams.get("includeSamples") === "true";
    return NextResponse.json(
      includeSamples ? listRideSessions() : listRideSessionSummaries()
    );
  } catch (error) {
    console.error("Failed to list ride sessions:", error);
    return NextResponse.json({ error: "Failed to load sessions" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = (await req.json()) as RideSession;
    if (!session?.id || !session.workoutName || !Array.isArray(session.samples)) {
      return NextResponse.json({ error: "Invalid session payload" }, { status: 400 });
    }

    const summaryResult = await summarizeRideSession({
      session,
      riderProfile: getRiderProfileFromDb(),
    });
    const enrichedSession: RideSession = {
      ...session,
      llmSummary: summaryResult.summary,
      llmSummaryStatus: summaryResult.status,
      llmSummaryError: summaryResult.error,
    };

    insertRideSession(enrichedSession);
    return NextResponse.json({ success: true, session: enrichedSession });
  } catch (error) {
    console.error("Failed to save ride session:", error);
    return NextResponse.json({ error: "Failed to save session" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "Missing session id" }, { status: 400 });
  }

  try {
    deleteRideSessionById(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete ride session:", error);
    return NextResponse.json({ error: "Failed to delete session" }, { status: 500 });
  }
}
