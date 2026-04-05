/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { randomBytes } from "crypto";
import Busboy from "busboy";
import { Readable } from "stream";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { userHasAccountAccess } from "@/lib/accountAccess";
import { AccountModel } from "@/lib/models/Account";
import { CampaignModel } from "@/lib/models/Campaign";
import { UploadModel } from "@/lib/models/Upload";
import { ensureMongoUploadRunnerStarted } from "@/lib/mongoUploadRunner";
import { enqueueCampaignWave, shuffleVideoIndices } from "@/lib/campaignJobQueue";
import { getUploadParallelAdminCap } from "@/lib/uploadParallelConfig";

export const maxDuration = 600;
export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
    }

    const uploadId = `campaign-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const batchDir = path.join(process.cwd(), "storage", "tmp-uploads", uploadId);
    const videosDir = path.join(batchDir, "videos");
    await fsp.mkdir(videosDir, { recursive: true });

    let accountIds: string[] = [];
    let captions: string[] = [];
    /** Legacy: JSON array from old clients; first non-empty line used if `musicQuery` absent */
    let musicQueries: string[] = [];
    let musicQuerySingle = "";
    let parallelism = 5;
    let staggerSeconds = 0;
    let cycleGapSeconds = 60;
    let repeatForever = false;
    let maxCycles = 1;
    let shufflePerAccount = false;
    let captionMode: "same" | "per_video" | "ai_unique_each" = "per_video";
    let scheduledStartAt = "";

    const videoWrites: Promise<void>[] = [];
    let videoIndex = 0;

    const headersObj = Object.fromEntries(request.headers.entries());
    const busboy = Busboy({
      headers: headersObj as any,
      limits: { files: 64 },
    }) as any;

    let resolveDone!: () => void;
    let rejectDone!: (e: unknown) => void;
    const donePromise = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    busboy.on("field", (name: string, val: string) => {
      if (name === "accountIds") {
        try {
          const parsed = JSON.parse(val);
          accountIds = Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          accountIds = [];
        }
      }
      if (name === "captions") {
        try {
          const parsed = JSON.parse(val);
          captions = Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          captions = [];
        }
      }
      if (name === "musicQueries") {
        try {
          const parsed = JSON.parse(val);
          musicQueries = Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          musicQueries = [];
        }
      }
      if (name === "musicQuery") musicQuerySingle = String(val ?? "").trim();
      if (name === "parallelism") {
        const n = Number.parseInt(String(val || "").trim(), 10);
        if (Number.isFinite(n)) parallelism = Math.max(1, Math.min(32, n));
      }
      if (name === "staggerSeconds") {
        const n = Number.parseFloat(String(val ?? "").trim());
        if (Number.isFinite(n)) staggerSeconds = Math.min(86_400, Math.max(0, n));
      }
      if (name === "cycleGapSeconds") {
        const n = Number.parseFloat(String(val ?? "").trim());
        if (Number.isFinite(n)) cycleGapSeconds = Math.min(86_400 * 7, Math.max(0, n));
      }
      if (name === "repeatForever") {
        const s = String(val ?? "").trim().toLowerCase();
        repeatForever = s === "1" || s === "true" || s === "on" || s === "yes";
      }
      if (name === "maxCycles") {
        const n = Number.parseInt(String(val ?? "").trim(), 10);
        if (Number.isFinite(n)) maxCycles = Math.min(10_000, Math.max(1, n));
      }
      if (name === "shufflePerAccount") {
        const s = String(val ?? "").trim().toLowerCase();
        shufflePerAccount = s === "1" || s === "true" || s === "on" || s === "yes";
      }
      if (name === "captionMode") {
        const m = String(val ?? "").trim();
        if (m === "same" || m === "per_video" || m === "ai_unique_each") captionMode = m;
      }
      if (name === "scheduledStartAt") scheduledStartAt = String(val ?? "").trim();
    });

    busboy.on("file", (fieldname: string, fileStream: any, info: any) => {
      if (fieldname !== "videos" && fieldname !== "video") {
        fileStream.resume();
        return;
      }
      const idx = videoIndex++;
      const dest = path.join(videosDir, `${idx}.mp4`);
      const ws = fs.createWriteStream(dest);
      fileStream.pipe(ws);
      videoWrites.push(
        new Promise<void>((resolve, reject) => {
          ws.on("finish", () => resolve());
          ws.on("error", reject);
          fileStream.on("error", reject);
        })
      );
    });

    busboy.on("error", (err: unknown) => rejectDone(err));
    busboy.on("finish", async () => {
      try {
        await Promise.all(videoWrites);
        resolveDone();
      } catch (e) {
        rejectDone(e);
      }
    });

    if (!request.body) {
      return NextResponse.json({ error: "Missing request body" }, { status: 400 });
    }
    const nodeStream = Readable.fromWeb(request.body as any);
    nodeStream.pipe(busboy);
    await donePromise;

    if (videoIndex === 0) {
      return NextResponse.json({ error: "Upload at least one video (field: videos)" }, { status: 400 });
    }
    if (accountIds.length === 0) {
      return NextResponse.json({ error: "Select at least one account" }, { status: 400 });
    }

    await connectDB();
    const ownerId = (user as { _id: mongoose.Types.ObjectId })._id;
    const isAdmin = (user as { role?: string }).role === "admin";

    const accounts = await AccountModel.find({
      _id: { $in: accountIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).lean();
    if (accounts.length !== accountIds.length) {
      return NextResponse.json({ error: "One or more accounts not found" }, { status: 403 });
    }
    for (const a of accounts) {
      if (!isAdmin && !userHasAccountAccess(a as { ownerId?: unknown; ownerIds?: unknown }, ownerId)) {
        return NextResponse.json({ error: "One or more accounts are not yours" }, { status: 403 });
      }
    }

    const V = videoIndex;
    if (captions.length === 0 && (captionMode as string) !== "ai_unique_each") {
      return NextResponse.json(
        { error: "Provide captions JSON array (one per video, or one string for same mode)" },
        { status: 400 }
      );
    }
    const mode = captionMode as string;
    if (mode === "same" && captions.length >= 1) {
      const first = captions[0] || "";
      captions = Array.from({ length: V }, () => first);
    } else if (mode === "per_video" && captions.length === 1 && V > 1) {
      const one = captions[0] || "";
      captions = Array.from({ length: V }, () => one);
    } else if (mode === "per_video" && captions.length > 0 && captions.length !== V) {
      return NextResponse.json(
        { error: `captions must have ${V} entries for per_video (or one entry to reuse for all)` },
        { status: 400 }
      );
    }
    if (
      mode === "ai_unique_each" &&
      (captions.length === 0 || captions.every((c) => !String(c ?? "").trim()))
    ) {
      captions = Array.from({ length: V }, () => "TikTok post");
    }
    while (captions.length < V) captions.push(captions[captions.length - 1] ?? "");
    const legacyMusicFirst =
      musicQueries.map((s) => String(s ?? "").trim()).find(Boolean) || "";
    const musicQueryFinal = (musicQuerySingle || legacyMusicFirst).trim();
    // Mongoose `captions: [{ type: String, required: true }]` rejects empty strings
    captions = captions.map((c) => {
      const t = String(c ?? "").trim();
      return t || "TikTok post";
    });

    const videoRelPaths = Array.from({ length: V }, (_, i) => `videos/${i}.mp4`);

    const perAccountVideoOrder: number[][] = [];
    for (let i = 0; i < accountIds.length; i++) {
      const seed = `${uploadId}:${accountIds[i]}`;
      perAccountVideoOrder.push(
        shufflePerAccount ? shuffleVideoIndices(V, seed) : Array.from({ length: V }, (_, j) => j)
      );
    }

    let scheduled: Date | undefined;
    if (scheduledStartAt) {
      const t = new Date(scheduledStartAt).getTime();
      if (Number.isNaN(t)) {
        return NextResponse.json({ error: "Invalid scheduledStartAt" }, { status: 400 });
      }
      scheduled = new Date(t);
    }

    await UploadModel.updateMany(
      {
        accountId: { $in: accountIds.map((id) => new mongoose.Types.ObjectId(id)) },
        status: "pending",
        uploadId: { $ne: uploadId },
      },
      { $set: { status: "failed", error: "superseded_by_campaign" } }
    );

    const created = await CampaignModel.create({
      ownerId,
      uploadId,
      accountIds: accountIds.map((id) => new mongoose.Types.ObjectId(id)),
      videoRelPaths,
      captions,
      ...(musicQueryFinal ? { musicQuery: musicQueryFinal } : {}),
      musicQueries: [],
      perAccountVideoOrder,
      captionMode,
      parallelism,
      staggerSeconds,
      cycleGapSeconds,
      repeatForever,
      maxCycles: Math.max(1, Math.min(10_000, maxCycles)),
      waveStartAccountIndex: 0,
      accountsFinishedInWave: 0,
      cycle: 0,
      status: "active",
      scheduledStartAt: scheduled ?? null,
    });

    await enqueueCampaignWave(created.toObject());

    const serverCap = getUploadParallelAdminCap();
    console.log("[CampaignAPI] created", {
      uploadId,
      videoCount: V,
      accountCount: accountIds.length,
      parallelismRequested: parallelism,
      serverParallelCap: serverCap,
      ...(serverCap < parallelism
        ? {
            warning: `UPLOAD_PARALLEL_BATCH_SIZE caps concurrent jobs at ${serverCap}; raise it (or unset for 32) to run ${parallelism} accounts in parallel.`,
          }
        : {}),
    });

    ensureMongoUploadRunnerStarted();

    return NextResponse.json({
      ok: true,
      uploadId,
      videoCount: V,
      accountCount: accountIds.length,
      parallelism,
      serverParallelCap: serverCap,
      effectiveParallelism: Math.min(parallelism, serverCap),
      shufflePerAccount,
      captionMode,
      repeatForever,
      maxCycles: Math.max(1, Math.min(10_000, maxCycles)),
      cycleGapSeconds,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Campaign create failed" },
      { status: 500 }
    );
  }
}
