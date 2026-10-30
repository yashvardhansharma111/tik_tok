/**
 * How an upload should handle the TikTok sound/music step.
 *
 *  - "trending" — open Add sound and pick a trending track (historical default)
 *  - "search"   — open Add sound and search for the user's `musicQuery`
 *  - "none"     — skip the sound picker entirely, keeping the video's own audio
 *
 * Before this existed, `uploadWorker` fell back to `musicQuery || "trending"`,
 * so there was no way to post a video with its original audio.
 */
export type MusicMode = "trending" | "search" | "none";

export const MUSIC_MODES: readonly MusicMode[] = ["trending", "search", "none"] as const;

export function parseMusicMode(value: unknown): MusicMode | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  // Accept a few friendly aliases from forms/clients.
  if (v === "none" || v === "skip" || v === "original" || v === "own") return "none";
  if (v === "search" || v === "custom") return "search";
  if (v === "trending" || v === "default" || v === "auto") return "trending";
  return undefined;
}

/**
 * Resolve the mode for a job. Records created before `musicMode` existed have no
 * stored value, so infer the previous behaviour from `musicQuery`.
 */
export function resolveMusicMode(mode: unknown, musicQuery?: string | null): MusicMode {
  const parsed = parseMusicMode(mode);
  if (parsed) return parsed;
  return typeof musicQuery === "string" && musicQuery.trim() ? "search" : "trending";
}

/**
 * The term to feed the sound picker, or null when no sound should be added.
 * A "search" mode with an empty query degrades to trending rather than silently
 * skipping, which matches what users expect from the old free-text field.
 */
export function effectiveSoundQuery(
  mode: MusicMode,
  musicQuery?: string | null
): string | null {
  if (mode === "none") return null;
  if (mode === "search") return (musicQuery || "").trim() || "trending";
  return "trending";
}

/** Short human label for logs and history rows. */
export function describeMusicMode(mode: MusicMode, musicQuery?: string | null): string {
  if (mode === "none") return "own sound (no TikTok music)";
  if (mode === "search") return `search: ${(musicQuery || "").trim() || "trending"}`;
  return "trending";
}
