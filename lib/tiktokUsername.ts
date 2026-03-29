/** TikTok handle rules (approximate): letters, numbers, period, underscore; length cap. */
export function sanitizeTikTokUsername(raw: string): string {
  let s = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, "")
    .replace(/^\.+|\.+$/g, "");
  if (s.length < 2) s = `u${Date.now().toString(36).slice(-6)}`;
  return s.slice(0, 24);
}

export function randomUsernameSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}
