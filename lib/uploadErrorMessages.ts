/**
 * Maps raw automation / DB error strings to short, non-technical copy for the UI.
 */

export function friendlyUploadError(raw: string | undefined | null): string {
  if (raw == null || String(raw).trim() === "") {
    return "Unknown error — check History or server logs.";
  }
  const s = String(raw);

  if (
    s === "account_lock_busy" ||
    /\baccount_lock_busy\b/i.test(s) ||
    /^ACCOUNT_LOCKED:/i.test(s)
  ) {
    return "This account is already in use: another upload is running, or the last run crashed and the lock clears after a few minutes. If nobody else is using it, wait 2–45 minutes (see server settings) or restart workers after a crash. Only one automation per account at a time.";
  }

  if (s.startsWith("missing_video_file:") || s.includes("missing_video_file")) {
    return "The video file for this batch was not found on this computer. Upload again here, or run the job only on the server where you started the upload.";
  }

  if (/SESSION_EXPIRED|session expired|logged out|sign in again/i.test(s)) {
    return "TikTok session expired. Open Accounts and capture or import a fresh session.";
  }

  if (/ERR_TUNNEL|ERR_PROXY|ERR_CONNECTION|tunnel connection failed|proxy/i.test(s)) {
    return "Network or proxy problem — the browser could not reach TikTok through your proxy. Check proxy settings and try again.";
  }

  if (/net::ERR_/i.test(s) || /Navigation failed/i.test(s)) {
    return "Network error while opening TikTok. Check internet, firewall, VPN, or proxy.";
  }

  if (/browser.*closed|Target page.*closed|context.*closed/i.test(s)) {
    return "Browser closed unexpectedly. Try again; if it repeats, check server memory and Playwright setup.";
  }

  if (/Sound not verified|sound flow/i.test(s)) {
    return "Could not confirm the sound step on TikTok. Try a different sound search or leave sound blank.";
  }

  if (/No sound row|Add sound control not found/i.test(s)) {
    return "Could not open or use the sound picker. TikTok may have changed the page — try without a sound or update automation.";
  }

  if (/superseded_by_new_batch/i.test(s)) {
    return "Cancelled because a newer upload was started for this account.";
  }

  return "Something went wrong during automation. See History for the technical message, or retry.";
}

/** One-line title for badges / tables. */
export function shortUploadErrorLabel(raw: string | undefined | null): string {
  if (raw == null || String(raw).trim() === "") return "Error";
  const s = String(raw);
  if (s === "account_lock_busy" || /\baccount_lock_busy\b/i.test(s)) return "Account busy";
  if (s.startsWith("missing_video_file:") || s.includes("missing_video_file")) return "Video missing on server";
  if (/SESSION_EXPIRED|session expired/i.test(s)) return "Session expired";
  if (/ERR_TUNNEL|proxy|net::ERR_/i.test(s)) return "Network / proxy";
  return "Failed";
}
