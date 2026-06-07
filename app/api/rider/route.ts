import { NextResponse } from "next/server";
import { getRiderProfileFromDb, upsertRiderProfile } from "@/lib/db";
import {
  mergeRiderProfilePatch,
  validateRiderProfile,
  type RiderProfilePatch,
} from "@/lib/rider-profile-validation";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getRiderProfileFromDb());
  } catch (error) {
    console.error("Failed to load rider profile:", error);
    return NextResponse.json({ error: "Failed to load rider profile" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const current = getRiderProfileFromDb();
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid rider profile patch" }, { status: 400 });
    }

    const patch = body as RiderProfilePatch;
    const profile = mergeRiderProfilePatch(current, patch);
    const validationError = validateRiderProfile(profile);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    upsertRiderProfile(profile);
    return NextResponse.json({ success: true, profile: getRiderProfileFromDb() });
  } catch (error) {
    console.error("Failed to save rider profile:", error);
    return NextResponse.json({ error: "Failed to save rider profile" }, { status: 500 });
  }
}
