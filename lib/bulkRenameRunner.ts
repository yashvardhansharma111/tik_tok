/* eslint-disable @typescript-eslint/no-explicit-any */
import { connectDB } from "@/lib/db";
import { AccountModel } from "@/lib/models/Account";
import { RenameJobModel } from "@/lib/models/RenameJob";
import { renameTikTokUsername } from "@/automation/renameTikTokUsername";
import { buildStickyProxyForAccount } from "@/lib/proxyPlaywright";
import { randomUsernameSuffix, sanitizeTikTokUsername } from "@/lib/tiktokUsername";
import { renameLog } from "@/lib/renameDebugLog";
import mongoose from "mongoose";

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
- Follow the user's THEME (bands, aesthetics, jokes) but create new words — e.g. theme "Jared Leto" → new handles like "marsfan_vibes", "thirtysecfan", NOT the same as any forbidden handle above.`;

  const user = `THEME / style instructions (this is what the new names should feel like — examples in the theme are inspiration only, not strings to copy):
${prompt}

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
  if (!Array.isArray(arr) || arr.length !== n) {
    throw new Error(`Expected ${n} usernames, got ${Array.isArray(arr) ? arr.length : 0}`);
  }
  const raw = arr.map((s: unknown) => sanitizeTikTokUsername(String(s)));
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

export function scheduleBulkRenameJob(jobId: string) {
  setImmediate(() => {
    void runBulkRenameJob(jobId);
  });
}

const MAX_TIKTOK_USERNAME_ATTEMPTS = 6;

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

      const proxy = buildStickyProxyForAccount(acc.username, acc.proxy, 1);
      let lastError = "";
      let done = false;

      renameLog("account_loaded", {
        dbUsername: acc.username,
        accountId: String(item.accountId),
        hasSession: Boolean(acc.session?.length),
      });

      for (let attempt = 0; attempt < MAX_TIKTOK_USERNAME_ATTEMPTS; attempt++) {
        candidate = sanitizeTikTokUsername(candidate);
        renameLog("attempt", { attempt: attempt + 1, max: MAX_TIKTOK_USERNAME_ATTEMPTS, candidate });

        const free = await isHandleFreeForAccount(candidate, item.accountId);
        if (!free.ok) {
          lastError = free.reason;
          renameLog("candidate_not_free_in_app_db", { reason: free.reason, candidate });
          candidate = sanitizeTikTokUsername(`${item.username}_${randomUsernameSuffix()}${attempt}`);
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
          taken: r.taken,
          error: r.error,
        });

        if (r.ok && r.verified !== false) {
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
            break;
          }
          lastError = persist.error + " (TikTok may have updated; reconcile manually)";
          break;
        }

        lastError = r.error || "Rename failed";
        if (r.taken) {
          renameLog("retry_new_candidate_taken", { previous: candidate });
          candidate = sanitizeTikTokUsername(`${names[idx] || item.username}_${randomUsernameSuffix()}${attempt + 1}`);
          continue;
        }
        renameLog("abort_attempts_not_taken", { lastError });
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

    await RenameJobModel.updateOne({ _id: jobId }, { $set: { status: "done" } });
    renameLog("job_complete", { jobId: String(jobId) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    renameLog("job_fatal", { error: msg });
    await RenameJobModel.updateOne({ _id: jobId }, { $set: { status: "failed", error: msg } });
  }
}

export async function createBulkRenameJob(ownerId: mongoose.Types.ObjectId, prompt: string, accountIds: string[]) {
  await connectDB();
  const accounts = await AccountModel.find({
    _id: { $in: accountIds.map((id) => new mongoose.Types.ObjectId(id)) },
  }).lean();

  if (accounts.length !== accountIds.length) {
    throw new Error("One or more accounts not found");
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
