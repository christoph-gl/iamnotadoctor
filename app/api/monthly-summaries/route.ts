import { NextResponse } from "next/server";
import {
  getRiderProfileFromDb,
  listMonthlySummaries,
  listRideSessions,
  upsertMonthlySummary,
} from "@/lib/db";
import { summarizeMonth } from "@/lib/monthly-summary";

export const dynamic = "force-dynamic";

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export async function GET() {
  try {
    return NextResponse.json(listMonthlySummaries());
  } catch (error) {
    console.error("Failed to list monthly summaries:", error);
    return NextResponse.json({ error: "Failed to load monthly summaries" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const month = typeof body?.month === "string" ? body.month : currentMonth();
    const result = await summarizeMonth(
      month,
      listRideSessions(),
      getRiderProfileFromDb()
    );

    upsertMonthlySummary(month, result.summary, result.model);
    return NextResponse.json({ success: true, month, ...result });
  } catch (error) {
    console.error("Failed to summarize month:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
