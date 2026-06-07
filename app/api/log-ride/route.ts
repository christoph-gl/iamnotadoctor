import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

type LoggedBikeSample = {
  timestamp: number;
  powerW?: number;
  cadenceRpm?: number;
  speedKph?: number;
  resistance?: number;
  heartRateBpm?: number;
};

export async function POST(req: Request) {
  try {
    const { filename, samples, isNew, metadata, finalMetrics } = await req.json();

    if (!filename) {
      return NextResponse.json({ error: 'Invalid data' }, { status: 400 });
    }

    const safeFilename = filename.replace(/[^a-z0-9\-_.]/gi, '_') + '.csv';
    const filePath = path.join(process.cwd(), 'csv_logs', safeFilename);

    let content = "";

    if (isNew && metadata) {
      content += `# Workout: ${metadata.workoutName}\n`;
      content += `# Power Profile: P5=${metadata.profile.nm}, P60=${metadata.profile.ac}, P300=${metadata.profile.map}, Threshold=${metadata.profile.ftp}\n`;
      content += `# Date: ${new Date().toISOString()}\n`;
      content += "timestamp,powerW,cadenceRpm,speedKph,resistance,heartRateBpm\n";
    }

    if (Array.isArray(samples) && samples.length > 0) {
      content += (samples as LoggedBikeSample[]).map((s) => {
        const ts = new Date(s.timestamp).toISOString();
        return `${ts},${s.powerW ?? ''},${s.cadenceRpm ?? ''},${s.speedKph ?? ''},${s.resistance ?? ''},${s.heartRateBpm ?? ''}`;
      }).join('\n') + '\n';
    }

    if (finalMetrics) {
      const footer = `\n# --- FINAL METRICS ---\n` +
                     `# Duration: ${Math.floor(finalMetrics.durationSeconds / 60)}m ${finalMetrics.durationSeconds % 60}s\n` +
                     `# TSS: ${Math.round(finalMetrics.tss)}\n` +
                     `# IF: ${finalMetrics.iff.toFixed(2)}\n` +
                     `# Avg Power: ${finalMetrics.avgPower ?? '-'}\n` +
                     `# Avg HR: ${finalMetrics.avgHr ?? '-'}\n` +
                     `# Avg Cadence: ${finalMetrics.avgCadence ?? '-'}\n`;
      
      if (isNew) {
        content += footer;
      } else {
        await fs.appendFile(filePath, footer);
      }
    }

    if (content) {
      if (isNew) {
        await fs.writeFile(filePath, content);
      } else {
        await fs.appendFile(filePath, content);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error saving CSV log:', error);
    return NextResponse.json({ error: 'Failed to save log' }, { status: 500 });
  }
}
