/**
 * One-time backfill: populate Account.previousUsername from RenameJob history.
 * For each account that was renamed, finds the earliest rename job item with
 * status "done" and sets previousUsername to the original username snapshot.
 *
 * Usage: npx tsx scripts/backfillPreviousUsername.ts
 */
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";

const MONGO_URI = process.env.MONGODB_URI || "";
const DB_NAME = "tiktok_automation";

async function main() {
  await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
  console.log("Connected to MongoDB");

  const Account = mongoose.connection.collection("accounts");
  const RenameJob = mongoose.connection.collection("renamejobs");

  const jobs = await RenameJob.find(
    { "items.status": "done" },
    { projection: { items: 1, createdAt: 1 } }
  ).sort({ createdAt: 1 }).toArray();

  console.log(`Found ${jobs.length} rename jobs with completed items`);

  // Map accountId -> earliest original username
  const originalNames = new Map<string, string>();

  for (const job of jobs) {
    for (const item of job.items || []) {
      if (item.status !== "done") continue;
      if (!item.accountId || !item.username) continue;
      const key = String(item.accountId);
      // Keep the EARLIEST (first) original name
      if (!originalNames.has(key)) {
        originalNames.set(key, item.username);
      }
    }
  }

  console.log(`Found original names for ${originalNames.size} accounts`);

  let updated = 0;
  for (const [accountId, prevName] of originalNames) {
    const result = await Account.updateOne(
      {
        _id: new mongoose.Types.ObjectId(accountId),
        $or: [
          { previousUsername: { $exists: false } },
          { previousUsername: "" },
          { previousUsername: null },
        ],
      },
      { $set: { previousUsername: prevName } }
    );
    if (result.modifiedCount > 0) {
      updated++;
      console.log(`  Updated ${prevName} -> current name (accountId: ${accountId})`);
    }
  }

  console.log(`\nBackfill complete: ${updated} accounts updated with previousUsername`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
