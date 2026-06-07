import { NextResponse } from "next/server";
import { getRiderProfileFromDb, upsertRiderProfile } from "@/lib/db";
import {
  normalizeMemorySummary,
  validateRiderProfile,
} from "@/lib/rider-profile-validation";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const memorySummary = normalizeMemorySummary(body?.memorySummary);

    if (memorySummary === null) {
      return NextResponse.json(
        { error: "memorySummary must be a string" },
        { status: 400 }
      );
    }

    const profile = {
      ...getRiderProfileFromDb(),
      memorySummary,
    };
    const validationError = validateRiderProfile(profile);

    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    upsertRiderProfile(profile);
    return NextResponse.json({ success: true, profile });
  } catch (error) {
    console.error("Failed to save rider memory:", error);
    return NextResponse.json({ error: "Failed to save rider memory" }, { status: 500 });
  }
}
