import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { RenameJobModel } from "@/lib/models/RenameJob";
import { AccountModel } from "@/lib/models/Account";

type RenameItem = {
  accountId: unknown;
  username: string;
  proposedName?: string;
  appliedUsername?: string;
  status: string;
  error?: string;
};

type RenameJobDoc = {
  _id: unknown;
  prompt: string;
  status: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  items?: RenameItem[];
};

function hasLikelyManualReconcileError(error?: string) {
  return /reconcile manually|tiktok may have updated/i.test(error || "");
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();

  const [jobsRaw, accountsRaw] = await Promise.all([
    RenameJobModel.find({}, { prompt: 1, status: 1, createdAt: 1, updatedAt: 1, items: 1 })
      .sort({ createdAt: -1 })
      .lean(),
    AccountModel.find({}, { username: 1 }).lean(),
  ]);

  const jobs = jobsRaw as RenameJobDoc[];
  const accountMap = new Map(
    (accountsRaw as Array<{ _id: unknown; username: string }>).map((a) => [String(a._id), a.username])
  );

  const rows = jobs.flatMap((job) =>
    (job.items || []).flatMap((item) => {
      const accountId = String(item.accountId);
      const currentMongoUsername = accountMap.get(accountId) || "";
      const proposedName = (item.proposedName || "").trim();
      const appliedUsername = (item.appliedUsername || "").trim();

      const mongoDiffersFromApplied =
        Boolean(appliedUsername) && currentMongoUsername && currentMongoUsername !== appliedUsername;
      const likelyChangedOnTikTokButNotMongo =
        item.status === "failed" &&
        Boolean(proposedName) &&
        currentMongoUsername !== proposedName &&
        hasLikelyManualReconcileError(item.error);

      const groqOnlyCandidate =
        Boolean(proposedName) &&
        !appliedUsername &&
        !likelyChangedOnTikTokButNotMongo &&
        item.status !== "done";

      if (!mongoDiffersFromApplied && !likelyChangedOnTikTokButNotMongo && !groqOnlyCandidate) {
        return [];
      }

      return [
        {
          jobId: String(job._id),
          accountId,
          prompt: job.prompt,
          jobStatus: job.status,
          createdAt: job.createdAt ?? null,
          updatedAt: job.updatedAt ?? null,
          previousUsername: item.username,
          currentMongoUsername,
          proposedName,
          appliedUsername,
          itemStatus: item.status,
          error: item.error || "",
          mismatchType: mongoDiffersFromApplied
            ? "mongo_differs_from_applied"
            : likelyChangedOnTikTokButNotMongo
              ? "likely_changed_on_tiktok_not_mongo"
              : "groq_candidate_only",
        },
      ];
    })
  );

  return NextResponse.json({
    total: rows.length,
    rows,
  });
}
