#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EXPORT_DIR = path.join(ROOT, "exports");
const DB_NAME = "tiktok_automation";

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

const AccountSchema = new mongoose.Schema(
  {
    username: { type: String, required: true },
  },
  { strict: false, collection: "accounts" }
);

const RenameJobSchema = new mongoose.Schema(
  {
    prompt: { type: String, required: false },
    status: { type: String, required: false },
    items: [
      new mongoose.Schema(
        {
          accountId: { type: mongoose.Schema.Types.ObjectId, required: true },
          username: { type: String, required: true },
          proposedName: { type: String, required: false },
          appliedUsername: { type: String, required: false },
          status: { type: String, required: false },
          error: { type: String, required: false },
        },
        { _id: false }
      ),
    ],
  },
  { strict: false, collection: "renamejobs", timestamps: true }
);

const Account = mongoose.models.ExportAccount || mongoose.model("ExportAccount", AccountSchema);
const RenameJob = mongoose.models.ExportRenameJob || mongoose.model("ExportRenameJob", RenameJobSchema);

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function hasLikelyManualReconcileError(error) {
  return /reconcile manually|tiktok may have updated/i.test(error || "");
}

function timestampForFile(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

async function main() {
  loadDotenv();
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("Missing MONGODB_URI in .env");
    process.exit(1);
  }

  await mongoose.connect(uri, { dbName: DB_NAME });

  const [accounts, jobs] = await Promise.all([
    Account.find({}, { username: 1 }).lean(),
    RenameJob.find({}, { prompt: 1, status: 1, items: 1, createdAt: 1, updatedAt: 1 }).sort({ createdAt: -1 }).lean(),
  ]);

  const accountMap = new Map(accounts.map((a) => [String(a._id), a.username || ""]));
  const rows = [];

  for (const job of jobs) {
    for (const item of job.items || []) {
      const accountId = String(item.accountId);
      const currentMongoUsername = accountMap.get(accountId) || "";
      const previousUsername = (item.username || "").trim();
      const proposedName = (item.proposedName || "").trim();
      const appliedUsername = (item.appliedUsername || "").trim();
      const itemStatus = (item.status || "").trim();
      const error = (item.error || "").trim();

      const mongoDiffersFromApplied =
        Boolean(appliedUsername) && Boolean(currentMongoUsername) && currentMongoUsername !== appliedUsername;
      const likelyChangedOnTikTokNotMongo =
        itemStatus === "failed" &&
        Boolean(proposedName) &&
        currentMongoUsername !== proposedName &&
        hasLikelyManualReconcileError(error);
      const groqCandidateNotInMongo =
        Boolean(proposedName) &&
        proposedName !== currentMongoUsername &&
        itemStatus !== "done";

      if (!mongoDiffersFromApplied && !likelyChangedOnTikTokNotMongo && !groqCandidateNotInMongo) {
        continue;
      }

      const mismatchType = mongoDiffersFromApplied
        ? "mongo_differs_from_applied"
        : likelyChangedOnTikTokNotMongo
          ? "likely_changed_on_tiktok_not_mongo"
          : "groq_candidate_not_in_mongo";

      rows.push({
        jobId: String(job._id),
        createdAt: job.createdAt ? new Date(job.createdAt).toISOString() : "",
        updatedAt: job.updatedAt ? new Date(job.updatedAt).toISOString() : "",
        jobStatus: job.status || "",
        accountId,
        previousUsername,
        currentMongoUsername,
        proposedName,
        appliedUsername,
        itemStatus,
        mismatchType,
        prompt: job.prompt || "",
        error,
      });
    }
  }

  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const outFile = path.join(EXPORT_DIR, `groq-renames-not-in-ui-${timestampForFile()}.csv`);
  const headers = [
    "jobId",
    "createdAt",
    "updatedAt",
    "jobStatus",
    "accountId",
    "previousUsername",
    "currentMongoUsername",
    "proposedName",
    "appliedUsername",
    "itemStatus",
    "mismatchType",
    "prompt",
    "error",
  ];

  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(",")),
  ];

  fs.writeFileSync(outFile, lines.join("\n"), "utf8");
  await mongoose.disconnect();

  console.log(`Exported ${rows.length} row(s) to ${outFile}`);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
