/* eslint-disable @typescript-eslint/no-explicit-any */
import { connectDB } from "@/lib/db";
import { userHasAccountAccess } from "@/lib/accountAccess";
import { AccountModel } from "@/lib/models/Account";
import { RenameJobModel } from "@/lib/models/RenameJob";
import { renameTikTokUsername, TIKTOK_USERNAME_30_DAY_COOLDOWN_ERROR } from "@/automation/renameTikTokUsername";
import { buildStickyProxyForAccount } from "@/lib/proxyPlaywright";
import { randomUsernameSuffix, sanitizeTikTokUsername } from "@/lib/tiktokUsername";
import { renameLog } from "@/lib/renameDebugLog";
import mongoose from "mongoose";

function extractExampleUsernamesFromPrompt(prompt: string): string[] {
  const raw = (prompt || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw) {
    const token = line
      .replace(/^@/, "")
      .replace(/[^a-zA-Z0-9_]/g, "")
      .trim();
    const s = sanitizeTikTokUsername(token);
    if (!s || s.length < 4) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 50) break;
  }
  return out;
}

function uniquifyUsernames(names: string[]): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    let base = sanitizeTikTokUsername(raw);
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) {
      const suf = `_${n}`;
      candidate = sanitizeTikTokUsername(base.slice(0, Math.max(2, 24 - suf.length)) + suf);
      n += 1;
    }
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}

/**
 * Groq often echoes the current handle when it appears in the prompt. Those must NEVER be used
 * as the "new" username or Playwright never runs.
 */
function forceDistinctFromCurrentHandles(names: string[], currentHandles: string[]): string[] {
  const forbidden = new Set(currentHandles.map((h) => sanitizeTikTokUsername(h)));
  return names.map((name, i) => {
    let s = sanitizeTikTokUsername(name);
    const cur = sanitizeTikTokUsername(currentHandles[i]);
    if (forbidden.has(s) || s === cur) {
      renameLog("groq_echoed_forbidden_handle", {
        index: i,
        received: name,
        sanitized: s,
        currentAccountHandle: cur,
      });
      let bump = sanitizeTikTokUsername(`${cur.slice(0, 10)}_${randomUsernameSuffix()}${i}`);
      let tries = 0;
      while ((forbidden.has(bump) || bump === cur) && tries < 8) {
        bump = sanitizeTikTokUsername(`fan_${randomUsernameSuffix()}_${i}_${tries}`);
        tries += 1;
      }
      s = bump;
    }
    return s;
  });
}

async function groqGenerateTikTokUsernames(prompt: string, labels: string[]): Promise<string[]> {
  const n = labels.length;

  const promptExamples = extractExampleUsernamesFromPrompt(prompt);
  if (promptExamples.length >= n) {
    renameLog("prompt_examples_used", { count: promptExamples.length, using: n, examples: promptExamples.slice(0, n) });
    const raw = promptExamples.slice(0, n).map((s) => sanitizeTikTokUsername(s));
    const distinct = forceDistinctFromCurrentHandles(raw, labels);
    return uniquifyUsernames(distinct);
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");

  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const forbiddenList = labels.map((h) => sanitizeTikTokUsername(h)).join(", ");
  const sys = `You invent NEW TikTok usernames (handles). You are renaming accounts — the output MUST be different from what exists today.

Hard rules:
- Output ONLY valid JSON: one array of exactly ${n} strings. No markdown.
- Each string: 4–24 chars, lowercase a-z, digits, underscore only. Start with a letter.
- All ${n} strings must be unique (case-insensitive).
- CRITICAL: Do NOT output any string that equals (case-insensitive) any of these FORBIDDEN handles: ${forbiddenList}
  Those are the accounts' CURRENT @names. Repeating them would mean "no change" — always invent DIFFERENT handles.
- Follow the user's THEME (bands, aesthetics, jokes) but create new words — e.g. theme "Jared Leto" → new handles like "marsfan_vibes", "thirtysecfan", NOT the same as any forbidden handle above.
- If the user supplied example handles, use them as STYLE anchors (same vibe/pattern), but do not copy them exactly unless they are explicitly intended outputs.`;

  const user = `THEME / style instructions (this is what the new names should feel like — examples in the theme are inspiration only, not strings to copy):
${prompt}

EXAMPLE handles (STYLE ONLY): ${JSON.stringify(promptExamples.slice(0, 12))}

FORBIDDEN outputs (current login handles — never put these in your JSON): ${JSON.stringify(labels)}

Return a JSON array of exactly ${n} brand-new candidate usernames, position i for account row i, all different from the forbidden list.`;

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.9,
      max_tokens: 700,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Groq error: ${resp.status} ${t}`);
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("Groq did not return a JSON array");
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) {
    throw new Error("Groq did not return a JSON array");
  }

  const sliced = arr.length > n ? arr.slice(0, n) : arr;
  const padded = [...sliced];
  while (padded.length < n) {
    padded.push(sanitizeTikTokUsername(`user_${randomUsernameSuffix()}${padded.length}`));
  }

  if (arr.length !== n) {
    renameLog("groq_username_count_mismatch", {
      expected: n,
      got: arr.length,
      using: padded.length,
    });
  }

  const raw = padded.map((s: unknown) => sanitizeTikTokUsername(String(s)));
  const distinct = forceDistinctFromCurrentHandles(raw, labels);
  const out = uniquifyUsernames(distinct);
  renameLog("groq_usernames_ready", {
    count: out.length,
    usernames: out,
    groqRawAfterSanitize: raw,
    afterDistinctFromCurrent: distinct,
  });
  return out;
}

/**
 * When a candidate is taken on TikTok, ask Groq for a single creative alternative
 * that matches the original prompt theme. Receives every previously tried name so
 * Groq never suggests a duplicate.
 */
async function groqGenerateAlternativeUsername(
  triedNames: string[],
  prompt: string
): Promise<string | null> {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) return null;

  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const forbiddenJson = JSON.stringify([...new Set(triedNames.map((s) => s.toLowerCase()))]);

  const sys = `You invent ONE new TikTok username. Rules:
- 4–24 chars, lowercase a-z, digits, underscore only. Start with a letter.
- Output ONLY the raw username string — no quotes, no JSON, no explanation, no commentary.
- Must NOT equal (case-insensitive) any of these already-tried handles: ${forbiddenJson}
- Be creative: use abbreviations, wordplay, number substitutions, underscores, related words. Never just append random digits to a taken name.`;

  const user = `These usernames were all unavailable on TikTok: ${forbiddenJson}
Theme / prompt: "${prompt}"
Invent ONE brand-new username that captures the same vibe but is unique and likely available. Output ONLY the username.`;

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        temperature: 1.1,
        max_tokens: 60,
      }),
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    const raw = (data?.choices?.[0]?.message?.content?.trim() || "")
      .replace(/^["'\s]+|["'\s]+$/g, "");
    const clean = sanitizeTikTokUsername(raw);
    const lower = clean.toLowerCase();
    if (!clean || clean.length < 4 || triedNames.some((t) => t.toLowerCase() === lower)) {
      renameLog("groq_alternative_rejected", { raw, clean, reason: "too short or duplicate" });
      return null;
    }
    renameLog("groq_alternative_generated", { tried: triedNames, alternative: clean });
    return clean;
  } catch (e) {
    renameLog("groq_alternative_error", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export function scheduleBulkRenameJob(jobId: string) {
  setImmediate(() => {
    void runBulkRenameJob(jobId);
  });
}

const MAX_TIKTOK_USERNAME_ATTEMPTS = Number(process.env.RENAME_MAX_ATTEMPTS || 12);

function is30DayUsernameCooldownError(msg: string | undefined): boolean {
  if (!msg) return false;
  if (msg === TIKTOK_USERNAME_30_DAY_COOLDOWN_ERROR) return true;
  return /once every\s*30\s*days/i.test(msg) && /username/i.test(msg);
}

async function isHandleFreeForAccount(
  newUsername: string,
  accountId: mongoose.Types.ObjectId
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const taken = await AccountModel.findOne({ username: newUsername }).lean();
  if (taken && String(taken._id) !== String(accountId)) {
    return { ok: false, reason: `Handle ${newUsername} already used by another account in this app` };
  }
  return { ok: true };
}

async function saveAccountUsername(accountId: mongoose.Types.ObjectId, newUsername: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await AccountModel.updateOne({ _id: accountId }, { $set: { username: newUsername } });
    return { ok: true };
  } catch (e: any) {
    if (e?.code === 11000) {
      return { ok: false, error: "Duplicate username in database" };
    }
    throw e;
  }
}

async function sleepBetweenAccountsMs(): Promise<void> {
  const ms = Number(process.env.RENAME_BETWEEN_ACCOUNTS_MS || 25000);
  if (ms <= 0) return;
  renameLog("between_accounts_sleep", { ms });
  await new Promise((r) => setTimeout(r, ms));
}

/** Job-level status from per-item outcomes (was always `done` before, which misled the UI). */
async function finalizeRenameJobStatus(jobId: mongoose.Types.ObjectId): Promise<void> {
  const fresh = await RenameJobModel.findById(jobId).lean();
  if (!fresh) return;
  const items = (fresh as { items?: Array<{ status?: string }> }).items || [];
  let nDone = 0;
  let nFail = 0;
  for (const it of items) {
    if (it.status === "done") nDone += 1;
    else if (it.status === "failed") nFail += 1;
  }
  let finalStatus: "done" | "failed" | "partial";
  if (nFail === 0) finalStatus = "done";
  else if (nDone === 0) finalStatus = "failed";
  else finalStatus = "partial";
  await RenameJobModel.updateOne({ _id: jobId }, { $set: { status: finalStatus } });
  renameLog("job_status_finalized", { jobId: String(jobId), finalStatus, nDone, nFail });
}

async function runBulkRenameJob(jobId: string) {
  await connectDB();
  const job = await RenameJobModel.findById(jobId).lean();
  if (!job) return;

  await RenameJobModel.updateOne({ _id: jobId }, { $set: { status: "running" } });
  renameLog("job_running", { jobId: String(jobId), prompt: (job as any).prompt });

  try {
    const labels = (job as any).items.map((i: any) => i.username);
    renameLog("groq_request", { labels, prompt: (job as any).prompt });
    const names = await groqGenerateTikTokUsernames((job as any).prompt, labels);

    for (let idx = 0; idx < (job as any).items.length; idx++) {
      if (idx > 0) await sleepBetweenAccountsMs();

      const item = (job as any).items[idx];
      let candidate = names[idx] || sanitizeTikTokUsername(item.username + "_" + randomUsernameSuffix());

      renameLog("item_start", {
        jobId: String(jobId),
        index: idx,
        accountId: String(item.accountId),
        initialCandidate: candidate,
        groqSlot: names[idx],
      });

      await RenameJobModel.updateOne(
        { _id: jobId, "items.accountId": item.accountId },
        { $set: { "items.$.proposedName": candidate, "items.$.status": "running" } }
      );

      const acc = await AccountModel.findById(item.accountId).lean();
      if (!acc || !acc.session) {
        await RenameJobModel.updateOne(
          { _id: jobId, "items.accountId": item.accountId },
          { $set: { "items.$.status": "failed", "items.$.error": "No session" } }
        );
        await RenameJobModel.updateOne({ _id: jobId }, { $inc: { completed: 1 } });
        continue;
      }

      const snap = sanitizeTikTokUsername(item.username);
      const live = sanitizeTikTokUsername(acc.username);
      if (snap !== live) {
        renameLog("rename_stale_job_snapshot", {
          message:
            "Job item.username is the frozen ‘before’ handle from queue time; Account.username was changed since — automation uses current Account row for TikTok",
          itemUsernameSnapshot: item.username,
          accountUsernameNow: acc.username,
          accountId: String(item.accountId),
        });
      }

      const proxy = buildStickyProxyForAccount(acc.username, acc.proxy, 1, String(acc._id));
      let lastError = "";
      let done = false;
      const triedCandidates: string[] = [];

      renameLog("account_loaded", {
        dbUsername: acc.username,
        accountId: String(item.accountId),
        hasSession: Boolean(acc.session?.length),
      });

      /** Ask Groq for a fresh name that hasn't been tried yet. Falls back to random suffix. */
      const nextCandidate = async (): Promise<string> => {
        const allTried = [...triedCandidates, acc.username, ...names];
        const alt = await groqGenerateAlternativeUsername(allTried, (job as any).prompt);
        if (alt) {
          renameLog("retry_candidate_chosen", { candidate: alt, source: "groq" });
          return sanitizeTikTokUsername(alt);
        }
        const fb = sanitizeTikTokUsername(
          `${names[idx] || item.username}_${randomUsernameSuffix()}${triedCandidates.length}`
        );
        renameLog("retry_candidate_chosen", { candidate: fb, source: "random_suffix" });
        return fb;
      };

      for (let attempt = 0; attempt < MAX_TIKTOK_USERNAME_ATTEMPTS; attempt++) {
        candidate = sanitizeTikTokUsername(candidate);
        triedCandidates.push(candidate);
        renameLog("attempt", { attempt: attempt + 1, max: MAX_TIKTOK_USERNAME_ATTEMPTS, candidate });

        const free = await isHandleFreeForAccount(candidate, item.accountId);
        if (!free.ok) {
          lastError = free.reason;
          renameLog("candidate_not_free_in_app_db", { reason: free.reason, candidate });
          candidate = await nextCandidate();
          continue;
        }

        const r = await renameTikTokUsername({
          sessionJson: acc.session,
          currentUsername: acc.username,
          newUsername: candidate,
          proxy,
        });

        renameLog("playwright_result", {
          candidate,
          ok: r.ok,
          verified: r.verified,
          error: r.error,
        });

        if (is30DayUsernameCooldownError(r.error)) {
          lastError = r.error || TIKTOK_USERNAME_30_DAY_COOLDOWN_ERROR;
          renameLog("rename_blocked_30_day_cooldown", {
            accountId: String(item.accountId),
            oldUsernameLive: acc.username,
            oldUsernameJobSnapshot: item.username,
            attemptedNewUsername: candidate,
            message:
              "TikTok blocks username changes within ~30 days — not retrying other candidate names for this account",
          });
          console.warn(
            `[rename] Name NOT changed — accountId=${String(item.accountId)} OLD @${acc.username} | tried NEW @${candidate} | ${lastError}`
          );
          break;
        }

        if (r.ok && r.verified) {
          const persist = await saveAccountUsername(item.accountId, candidate);
          renameLog("mongo_persist", {
            candidate,
            ok: persist.ok,
            error: persist.ok ? undefined : persist.error,
          });
          if (persist.ok) {
            await RenameJobModel.updateOne(
              { _id: jobId, "items.accountId": item.accountId },
              {
                $set: {
                  "items.$.status": "done",
                  "items.$.proposedName": candidate,
                  "items.$.appliedUsername": candidate,
                  "items.$.error": undefined,
                },
              }
            );
            done = true;
            renameLog("item_done", { appliedUsername: candidate });
            renameLog("rename_audit_persisted", {
              jobId: String(jobId),
              accountId: String(item.accountId),
              usernameBefore: item.username,
              usernameAfter: candidate,
              note: "RenameJob.items.username left unchanged (snapshot); Account.username updated to usernameAfter",
            });
            console.info(
              `[rename] Name saved — accountId=${String(item.accountId)} OLD @${acc.username} → NEW @${candidate} (MongoDB Account.username updated)`
            );
            break;
          }
          lastError = persist.error;
          break;
        }

        lastError = r.error || "TikTok UI did not respond after save";

        const shouldRetry =
          lastError === "Username not available" ||
          (typeof lastError === "string" && lastError.startsWith("Verification failed")) ||
          lastError === "TikTok UI did not respond after save";

        if (shouldRetry) {
          renameLog("retry_new_candidate", { previous: candidate, reason: lastError, attemptsDone: attempt + 1 });
          const betweenAttemptMs = Number(process.env.RENAME_BETWEEN_ATTEMPT_MS || 2500);
          if (betweenAttemptMs > 0) {
            renameLog("between_attempt_sleep", { ms: betweenAttemptMs });
            await new Promise((r) => setTimeout(r, betweenAttemptMs));
          }
          candidate = await nextCandidate();
          continue;
        }

        renameLog("abort_attempts_not_retryable", { lastError });
        break;
      }

      if (!done) {
        await RenameJobModel.updateOne(
          { _id: jobId, "items.accountId": item.accountId },
          { $set: { "items.$.status": "failed", "items.$.error": lastError || "Could not set username" } }
        );
        renameLog("item_failed", { error: lastError });
      }

      await RenameJobModel.updateOne({ _id: jobId }, { $inc: { completed: 1 } });
    }

    await finalizeRenameJobStatus(new mongoose.Types.ObjectId(jobId));
    renameLog("job_complete", { jobId: String(jobId) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    renameLog("job_fatal", { error: msg });
    await RenameJobModel.updateOne({ _id: jobId }, { $set: { status: "failed", error: msg } });
  }
}

export async function createBulkRenameJob(
  ownerId: mongoose.Types.ObjectId,
  prompt: string,
  accountIds: string[],
  opts?: { skipAccessCheck?: boolean }
) {
  await connectDB();
  const accounts = await AccountModel.find({
    _id: { $in: accountIds.map((id) => new mongoose.Types.ObjectId(id)) },
  }).lean();

  if (accounts.length !== accountIds.length) {
    throw new Error("One or more accounts not found");
  }
  if (!opts?.skipAccessCheck) {
    for (const a of accounts) {
      if (!userHasAccountAccess(a as { ownerId?: unknown; ownerIds?: unknown }, ownerId)) {
        throw new Error("One or more accounts not owned by you");
      }
    }
  }

  const items = accounts.map((a: any) => ({
    accountId: a._id,
    username: a.username,
    proposedName: "",
    status: "pending" as const,
  }));

  const job = await RenameJobModel.create({
    ownerId,
    prompt,
    status: "queued",
    total: items.length,
    completed: 0,
    items,
  });

  scheduleBulkRenameJob(String(job._id));
  return job;
}
