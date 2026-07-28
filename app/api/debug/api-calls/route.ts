import { NextResponse } from "next/server";
import { listApiCallLogs } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") || 50);
    return NextResponse.json(listApiCallLogs(Number.isFinite(limit) ? limit : 50));
  } catch (error) {
    console.error("Failed to list API call logs:", error);
    return NextResponse.json({ error: "Failed to load API call logs" }, { status: 500 });
  }
}
