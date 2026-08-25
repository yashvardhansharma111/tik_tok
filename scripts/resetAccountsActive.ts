import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || "";
const DB_NAME = process.env.MONGODB_DB || "tiktok_automation";

const USERNAMES = [
  "priyansh122",
  "dorothy1rr499bl",
  "dorothy2fr212my",
  "dorothy3bb404in",
  "dorothy3hy795fca",
  "carol8mu657fj",
  "carol4ps602aa",
  "carol3ko546ne",
  "user1045875832122jgfd",
  "malefda8265",
  "lareennaa28689",
  "mourraa3854",
  "athera754365",
  "jaredletoarchive01",
  "dorothy1kz516gu",
  "dorothy0ue404yw",
  "donna7rx338vw",
  "donna7pf121zo",
  "donna6gb461mk",
  "donna2eb126nv",
  "donna0bu145hf",
  "deborah9mu441el",
  "deborah9ag873wx",
  "jaredletomars09",
  "30secondtomarsdaily03",
  "jaredletomars10",
  "official30secondmars05",
  "jaredletomars08",
  "jaredletomars07",
  "30secondtomarsdaily02",
  "jaredletomars06",
  "official30secondmars02",
  "jaredletomars05",
  "jaredletoarchive07",
  "letofanpage04",
  "@30secondtomarsdaily06",
  "sandramichelle_20100063",
  "helenruth_20107574",
  "helenkimberly_20102372",
  "dorothy3hy795fc",
  "elizabeth2di072er",
  "elizabeth5af021et",
  "helen5gl026ds",
  "helen5qv126ti",
];

async function main() {
  if (!MONGO_URI) {
    console.error("MONGODB_URI not set in .env");
    process.exit(1);
  }

  console.log("Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
  const accounts = mongoose.connection.collection("accounts");

  // Show current status before updating
  const before = await accounts
    .find({ username: { $in: USERNAMES } }, { projection: { username: 1, status: 1 } })
    .toArray();

  console.log(`\nFound ${before.length} matching accounts:`);
  for (const a of before) {
    console.log(`  ${(a as any).username}  →  ${(a as any).status}`);
  }

  const result = await accounts.updateMany(
    { username: { $in: USERNAMES } },
    { $set: { status: "active" } }
  );

  console.log(`\nUpdated: ${result.modifiedCount} accounts set to active`);
  console.log(`Matched: ${result.matchedCount}`);

  if (result.matchedCount < USERNAMES.length - 1) {
    const foundNames = new Set(before.map((a: any) => a.username));
    const missing = USERNAMES.filter((u) => !foundNames.has(u));
    if (missing.length) {
      console.warn("\nNot found in DB (may already be correct or username differs):");
      for (const u of missing) console.warn("  " + u);
    }
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
