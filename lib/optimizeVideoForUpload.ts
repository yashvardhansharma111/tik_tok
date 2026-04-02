import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

/**
 * Optional FFmpeg pass: smaller file → less **upload** bytes through the proxy.
 * Requires `ffmpeg` on PATH. On failure, returns the original path.
 *
 * Env: `UPLOAD_VIDEO_FFMPEG=1` to enable.
 * `UPLOAD_FFMPEG_CRF` (default 28), `UPLOAD_FFMPEG_MAX_WIDTH` (default 720).
 */
export async function resolveOptimizedVideoPath(originalPath: string): Promise<string> {
  const enabled =
    process.env.UPLOAD_VIDEO_FFMPEG === "1" ||
    process.env.UPLOAD_VIDEO_FFMPEG === "true" ||
    process.env.UPLOAD_VIDEO_FFMPEG === "yes";
  if (!enabled) return originalPath;

  const dir = path.dirname(originalPath);
  const base = path.basename(originalPath, path.extname(originalPath));
  const outPath = path.join(dir, `${base}.proxy-opt.mp4`);

  const crf = Math.min(35, Math.max(18, Number(process.env.UPLOAD_FFMPEG_CRF || 28)));
  const maxW = Math.min(1920, Math.max(480, Number(process.env.UPLOAD_FFMPEG_MAX_WIDTH || 720)));

  const ok = await runFfmpeg(originalPath, outPath, crf, maxW);
  if (!ok) return originalPath;

  try {
    const st = await fs.stat(outPath);
    const orig = await fs.stat(originalPath);
    if (st.size >= orig.size * 0.98) {
      await fs.unlink(outPath).catch(() => {});
      return originalPath;
    }
  } catch {
    return originalPath;
  }

  return outPath;
}

function runFfmpeg(input: string, output: string, crf: number, maxWidth: number): Promise<boolean> {
  return new Promise((resolve) => {
    const vf = `scale=min(${maxWidth}\\,iw):-2`;
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input,
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      String(crf),
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      output,
    ];
    const p = spawn("ffmpeg", args, { stdio: "ignore" });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}
