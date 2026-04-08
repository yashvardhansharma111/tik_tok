const mongoose = require("mongoose");
try { require("dotenv").config(); } catch { /* env already set or dotenv not available */ }

async function fix() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: "tiktok_automation" });
  const col = mongoose.connection.collection("accounts");

  const doc = await col.findOne({ username: "30sectomars" });
  if (!doc) {
    console.log("No account found with username '30sectomars' — already fixed or not present.");
    process.exit(0);
  }

  console.log("Found account:", { _id: String(doc._id), username: doc.username });

  const result = await col.updateOne(
    { _id: doc._id },
    { $set: { username: "ruth7fw324hg" } }
  );

  console.log(
    result.modifiedCount === 1
      ? "SUCCESS — username reverted to 'ruth7fw324hg'"
      : "NO CHANGE"
  );

  await mongoose.disconnect();
}

fix().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
