/**
 * Upload parallelism: UI and API allow up to this many parallel Playwright runs per wave.
 * Server-wide ceiling is {@link getUploadParallelAdminCap} (env UPLOAD_PARALLEL_BATCH_SIZE).
 */

export const UPLOAD_PARALLELISM_UI_MAX = 32;

/**
 * Max concurrent upload jobs claimed in one wave. Defaults to {@link UPLOAD_PARALLELISM_UI_MAX}
 * so the per-batch `parallelism` from the upload form is honored. Set
 * `UPLOAD_PARALLEL_BATCH_SIZE` lower on small hosts to cap resource usage.
 */
export function getUploadParallelAdminCap(): number {
  const raw = process.env.UPLOAD_PARALLEL_BATCH_SIZE;
  if (raw === undefined || raw === "") {
    return UPLOAD_PARALLELISM_UI_MAX;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return UPLOAD_PARALLELISM_UI_MAX;
  }
  return Math.max(1, Math.min(UPLOAD_PARALLELISM_UI_MAX, Math.floor(n)));
}
