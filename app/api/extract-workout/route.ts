import { generateObject, getOpenRouterModel, openRouterApiKey, openRouterDefaultModel } from "@/lib/llm-calls-env"
import { z } from "zod"
import { NextResponse } from "next/server"

const workoutImageExtractorApiKey =
  process.env.WORKOUT_IMAGE_EXTRACTOR_API_KEY || openRouterApiKey

const workoutImageExtractorModelName =
  process.env.WORKOUT_IMAGE_EXTRACTOR_MODEL ||
  openRouterDefaultModel

const workoutImageExtractorModel = getOpenRouterModel(
  workoutImageExtractorModelName
)

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const file = formData.get("file") as File | null

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 })
    }

    const buffer = await file.arrayBuffer()

    const result = await generateObject({
      model: workoutImageExtractorModel,
      apiKey: workoutImageExtractorApiKey,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are a cycling workout extractor for a power-profile / ERG mode chart.
Extract the sequence of workout blocks from left to right.
The chart usually has a white horizontal line which represents threshold power (100% threshold).
Colors represent different reference metrics:
- Blue bars reference threshold power.
- Yellow bars reference 5-minute power.
- Orange bars reference 60-second power.
- Pink bars reference 5-second power.

Estimate the duration in seconds based on the width of the bars. The total duration is usually given (e.g., 54:21) or implied.
Estimate the intensity percentage based on the height relative to the reference metric. For example, if a blue bar is exactly on the white threshold line, it is 100% threshold.`,
            },
            {
              type: "image",
              image: buffer,
            },
          ],
        },
      ],
      schema: z.object({
        name: z
          .string()
          .describe("Title of the workout, or 'Extracted Workout'"),
        total_duration_minutes: z.number(),
        blocks: z.array(
          z.object({
            duration_seconds: z.number(),
            zone: z.string().describe("e.g., Recovery, Tempo, P60, P300, P5"),
            intensity_percent: z
              .number()
              .describe(
                "percentage relative to the reference_metric, e.g., 100"
              ),
            reference_metric: z.enum(["FTP", "MAP", "AC", "NM"]),
          })
        ),
      }),
    })

    return NextResponse.json(result.object)
  } catch (error) {
    console.error("Error extracting workout:", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
