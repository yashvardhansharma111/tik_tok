import fs from "fs/promises";
import path from "path";

const JANITOR_TIMER_KEY = "__storageJanitorTimer_v1";

function janitorDisabled(): boolean {
  return process.env.STORAGE_JANITOR === "0" || process.env.STORAGE_JANITOR === "false";
}

function maxAgeMs(): number {
  const n = Number(process.env.STORAGE_JANITOR_MAX_AGE_MS ?? 86_400_000);
  return Number.isFinite(n) && n >= 60_000 ? n : 86_400_000;
}

function intervalMs(): number {
  const n = Number(process.env.STORAGE_JANITOR_INTERVAL_MS ?? 3_600_000);
  return Number.isFinite(n) && n >= 60_000 ? n : 3_600_000;
}

/**
 * Deletes **subdirectories** under `storage/debug` and `storage/tmp-uploads` whose **mtime** is older than
 * `STORAGE_JANITOR_MAX_AGE_MS` (default 24h). Does not touch `sound-cache.json`, `accounts.json`, `cookies/`, etc.
 */
export async function runStorageJanitorOnce(): Promise<{ removed: number; errors: string[] }> {
  if (janitorDisabled()) return { removed: 0, errors: [] };

  const maxAge = maxAgeMs();
  const now = Date.now();
  const root = process.cwd();
  const targets = [path.join(root, "storage", "debug"), path.join(root, "storage", "tmp-uploads")];

  let removed = 0;
  const errors: string[] = [];

  for (const dir of targets) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        const st = await fs.stat(full);
        if (!st.isDirectory()) continue;
        if (now - st.mtimeMs < maxAge) continue;
        await fs.rm(full, { recursive: true, force: true });
        removed += 1;
      } catch (e) {
        errors.push(`${full}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (removed > 0) {
    console.log(
      `[StorageJanitor] removed ${removed} director(ies) older than ${Math.round(maxAge / 3600000)}h under storage/debug and storage/tmp-uploads`
    );
  }
  return { removed, errors };
}

/** Idempotent: starts at most one interval per process (Next dev / worker / mongo runner). */
export function ensureStorageJanitorStarted(): void {
  const g = globalThis as unknown as Record<string, ReturnType<typeof setInterval> | undefined>;
  if (g[JANITOR_TIMER_KEY]) return;

  if (janitorDisabled()) {
    console.log("[StorageJanitor] disabled (STORAGE_JANITOR=0)");
    return;
  }

  void runStorageJanitorOnce().catch((e) => console.warn("[StorageJanitor] initial run failed", e));

  g[JANITOR_TIMER_KEY] = setInterval(() => {
    void runStorageJanitorOnce().catch((e) => console.warn("[StorageJanitor] run failed", e));
  }, intervalMs());
}
