import { NextResponse } from "next/server";
import { getRideSessionById } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  try {
    const session = getRideSessionById(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    return NextResponse.json(session);
  } catch (error) {
    console.error("Failed to load ride session:", error);
    return NextResponse.json({ error: "Failed to load session" }, { status: 500 });
  }
}
