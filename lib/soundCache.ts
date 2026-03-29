import fs from "fs";
import path from "path";

const CACHE_FILE = path.join(process.cwd(), "storage", "sound-cache.json");

export type CachedSoundEntry = {
  /** Row title / label shown in TikTok picker (used for quick re-search). */
  label: string;
  savedAt: number;
};

const memory = new Map<string, CachedSoundEntry>();
let loaded = false;

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as Record<string, CachedSoundEntry>;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.label === "string" && v.label.trim()) {
          memory.set(k, { label: v.label.trim(), savedAt: typeof v.savedAt === "number" ? v.savedAt : Date.now() });
        }
      }
    }
  } catch {
    // ignore corrupt cache
  }
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(memory), null, 0), "utf-8");
  } catch {
    // best-effort
  }
}

export function soundCacheKey(accountUsername: string, musicQuery: string): string {
  const u = accountUsername.trim().toLowerCase();
  const q = musicQuery.trim().toLowerCase().replace(/\s+/g, " ");
  return `${u}:::${q}`;
}

export function getCachedSound(accountUsername: string, musicQuery: string): CachedSoundEntry | undefined {
  loadFromDisk();
  return memory.get(soundCacheKey(accountUsername, musicQuery));
}

export function setCachedSound(accountUsername: string, musicQuery: string, label: string): void {
  loadFromDisk();
  const key = soundCacheKey(accountUsername, musicQuery);
  memory.set(key, { label: label.trim().slice(0, 500), savedAt: Date.now() });
  persist();
}

export function invalidateCachedSound(accountUsername: string, musicQuery: string): void {
  loadFromDisk();
  memory.delete(soundCacheKey(accountUsername, musicQuery));
  persist();
}
