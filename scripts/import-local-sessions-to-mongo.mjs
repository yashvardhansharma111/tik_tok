#!/usr/bin/env node
/**
 * Import Playwright storageState JSON files from storage/ into MongoDB Account documents.
 *
 * Usage (from project root):
 *   npx cross-env OWNER_EMAIL=you@example.com node --env-file=.env scripts/import-local-sessions-to-mongo.mjs
 *   npm run import-sessions
 *
 * Optional env:
 *   OWNER_EMAIL  — if set, resolves User by email and sets account ownerId (so the user sees accounts in the app).
 *                  If omitted, accounts are stored without ownerId (only admins see them until reassigned).
 *
 * Flags:
 *   --dry-run    — print actions only, no DB writes
 *   --all-cookies — also import every storage/cookies/*.json not listed in accounts.json (username = filename)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STORAGE = path.join(ROOT, "storage");
const ACCOUNTS_JSON = path.join(STORAGE, "accounts.json");
const COOKIES_DIR = path.join(STORAGE, "cookies");

function loadDotenv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return;
  const txt = fs.readFileSync(p, "utf8");
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allCookies = args.includes("--all-cookies");

const AccountSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false, index: true },
    username: { type: String, required: true, unique: true, index: true },
    session: { type: String, required: true },
    proxy: { type: String, required: false },
    status: { type: String, enum: ["active", "expired"], default: "active" },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
const Account = mongoose.models.Account || mongoose.model("Account", AccountSchema);

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["admin", "user"], default: "user" },
    status: { type: String, enum: ["pending", "active", "blocked"], default: "pending" },
    emailVerified: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
const User = mongoose.models.User || mongoose.model("User", UserSchema);

function sessionStringFromFile(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  const parsed = JSON.parse(raw);
  return JSON.stringify(parsed);
}

function resolveCookiePath(cookieFile) {
  const rel = cookieFile.replace(/^\//, "");
  const a = path.join(STORAGE, rel);
  if (fs.existsSync(a)) return a;
  const b = path.join(ROOT, rel);
  if (fs.existsSync(b)) return b;
  return null;
}

async function main() {
  loadDotenv();
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("Missing MONGODB_URI. Use: node --env-file=.env scripts/import-local-sessions-to-mongo.mjs");
    process.exit(1);
  }

  const ownerEmail = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
  let ownerId = null;
  if (ownerEmail) {
    await mongoose.connect(uri, { dbName: "tiktok_automation" });
    const u = await User.findOne({ email: ownerEmail }).lean();
    await mongoose.disconnect();
    if (!u) {
      console.error(`No user found with email ${ownerEmail}. Sign up first or fix OWNER_EMAIL.`);
      process.exit(1);
    }
    ownerId = u._id;
    console.log(`Assigning ownerId → ${ownerEmail} (${ownerId})`);
  }

  /** @type {Map<string, { absPath: string, lastUsedAt?: Date }>} */
  const byUser = new Map();

  if (fs.existsSync(ACCOUNTS_JSON)) {
    const manifest = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, "utf8"));
    if (!Array.isArray(manifest)) throw new Error("accounts.json must be an array");
    for (const row of manifest) {
      const username = typeof row.username === "string" ? row.username.trim() : "";
      const cookieFile = typeof row.cookieFile === "string" ? row.cookieFile.trim() : "";
      if (!username || !cookieFile) {
        console.warn("Skip manifest row (missing username or cookieFile):", row);
        continue;
      }
      const abs = resolveCookiePath(cookieFile);
      if (!abs) {
        console.warn(`Skip ${username}: cookie file not found for ${cookieFile}`);
        continue;
      }
      let lastUsedAt;
      if (row.lastUsedAt) {
        const d = new Date(row.lastUsedAt);
        if (!Number.isNaN(d.getTime())) lastUsedAt = d;
      }
      byUser.set(username, { absPath: abs, lastUsedAt });
    }
  } else {
    console.warn("No storage/accounts.json — will only use --all-cookies if set.");
  }

  if (allCookies && fs.existsSync(COOKIES_DIR)) {
    const names = fs.readdirSync(COOKIES_DIR).filter((f) => f.endsWith(".json"));
    for (const f of names) {
      if (f === "testAccount.json") continue;
      const username = f.replace(/\.json$/i, "");
      if (byUser.has(username)) continue;
      byUser.set(username, { absPath: path.join(COOKIES_DIR, f) });
    }
  }

  if (byUser.size === 0) {
    console.error("Nothing to import. Add storage/accounts.json and cookie files, or pass --all-cookies.");
    process.exit(1);
  }

  console.log(`Prepared ${byUser.size} account(s) for import${dryRun ? " (dry-run)" : ""}.`);

  if (dryRun) {
    for (const [username, { absPath, lastUsedAt }] of byUser) {
      console.log(`  ${username} ← ${path.relative(ROOT, absPath)}${lastUsedAt ? ` lastUsedAt=${lastUsedAt.toISOString()}` : ""}`);
    }
    process.exit(0);
  }

  await mongoose.connect(uri, { dbName: "tiktok_automation" });

  let ok = 0;
  let fail = 0;
  for (const [username, { absPath, lastUsedAt }] of byUser) {
    try {
      const session = sessionStringFromFile(absPath);
      await Account.findOneAndUpdate(
        { username },
        {
          username,
          session,
          status: "active",
          ...(ownerId ? { ownerId } : {}),
          ...(lastUsedAt ? { lastUsedAt } : {}),
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
      );
      console.log(`OK  ${username}`);
      ok++;
    } catch (e) {
      console.error(`ERR ${username}:`, e instanceof Error ? e.message : e);
      fail++;
    }
  }

  await mongoose.disconnect();
  console.log(`Done. ${ok} imported, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
