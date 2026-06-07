import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const workoutsDir = path.join(process.cwd(), 'workouts');
const deletedWorkoutsFile = path.join(workoutsDir, '.deleted-workouts.json');

async function ensureDir() {
  try {
    await fs.access(workoutsDir);
  } catch {
    await fs.mkdir(workoutsDir, { recursive: true });
  }
}

async function readDeletedWorkoutIds() {
  try {
    const content = await fs.readFile(deletedWorkoutsFile, 'utf-8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : [];
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    if (code === 'ENOENT') return [];
    throw error;
  }
}

async function writeDeletedWorkoutIds(ids: string[]) {
  const uniqueIds = Array.from(new Set(ids)).sort();
  await fs.writeFile(deletedWorkoutsFile, JSON.stringify(uniqueIds, null, 2), 'utf-8');
}

function safeWorkoutId(id: string) {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return safeId && safeId === id ? safeId : null;
}

export async function GET(request: Request) {
  await ensureDir();
  try {
    const url = new URL(request.url);
    const files = await fs.readdir(workoutsDir);
    const workouts = [];
    for (const file of files) {
      if (file.startsWith('.')) continue;
      if (file.endsWith('.json')) {
        const content = await fs.readFile(path.join(workoutsDir, file), 'utf-8');
        try {
          workouts.push(JSON.parse(content));
        } catch (e) {
          console.error(`Failed to parse ${file}:`, e);
        }
      }
    }
    if (url.searchParams.get('includeDeleted') === 'true') {
      return NextResponse.json({
        workouts,
        deletedWorkoutIds: await readDeletedWorkoutIds(),
      });
    }
    return NextResponse.json(workouts);
  } catch (error) {
    console.error("Failed to read workouts directory:", error);
    return NextResponse.json({ error: 'Failed to load workouts' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  await ensureDir();
  try {
    const workout = await request.json();
    if (!workout || !workout.id) {
      return NextResponse.json({ error: 'Invalid workout data' }, { status: 400 });
    }
    
    const safeId = safeWorkoutId(workout.id);
    if (!safeId) {
      return NextResponse.json({ error: 'Invalid workout id' }, { status: 400 });
    }
    const filePath = path.join(workoutsDir, `${safeId}.json`);
    
    await fs.writeFile(filePath, JSON.stringify(workout, null, 2), 'utf-8');
    const deletedIds = await readDeletedWorkoutIds();
    await writeDeletedWorkoutIds(deletedIds.filter((id) => id !== safeId));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to save workout:", error);
    return NextResponse.json({ error: 'Failed to save workout' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  await ensureDir();
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Missing workout id' }, { status: 400 });
    }

    const safeId = safeWorkoutId(id);
    if (!safeId) {
      return NextResponse.json({ error: 'Invalid workout id' }, { status: 400 });
    }

    const filePath = path.join(workoutsDir, `${safeId}.json`);
    await fs.unlink(filePath).catch((error) => {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (code !== 'ENOENT') throw error;
    });

    const deletedIds = await readDeletedWorkoutIds();
    await writeDeletedWorkoutIds([...deletedIds, safeId]);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete workout:", error);
    return NextResponse.json({ error: 'Failed to delete workout' }, { status: 500 });
  }
}
