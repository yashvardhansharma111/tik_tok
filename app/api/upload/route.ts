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
import { UploadModel } from "@/lib/models/Upload";
import { ensureMongoUploadRunnerStarted } from "@/lib/mongoUploadRunner";
import { generateTikTokCaption } from "@/lib/aiCaption";

export const maxDuration = 600;
export const runtime = "nodejs";

function safeDisplayName(name: string) {
  const base = name?.trim() || "video.mp4";
  return base.replace(/[^\w.\- ]/g, "_").slice(0, 120);
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
    }

    const uploadId = `batch-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const batchDir = path.join(process.cwd(), "storage", "tmp-uploads", uploadId);
    await fsp.mkdir(batchDir, { recursive: true });

    let caption = "";
    let musicQuery = "";
    let accountIds: string[] = [];
    let parallelism = 4;
    let staggerSeconds = 0;
    let scheduledStartAt = "";
    let uniqueCaptionPerAccount = false;
    let captionTopic = "";
    let videoPath = "";
    let videoDisplayName = "video.mp4";

    const headersObj = Object.fromEntries(request.headers.entries());
    const busboy = Busboy({
      headers: headersObj as any,
      limits: { files: 1 },
    }) as any;

    let resolveDone!: () => void;
    let rejectDone!: (e: unknown) => void;
    const donePromise = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    let fileWritePromise: Promise<void> | null = null;
    busboy.on("field", (name: string, val: string) => {
      if (name === "caption") caption = val;
      if (name === "musicQuery") musicQuery = val;
      if (name === "parallelism") {
        const n = Number.parseInt(String(val || "").trim(), 10);
        if (Number.isFinite(n)) parallelism = Math.max(1, Math.min(32, n));
      }
      if (name === "accountIds") {
        try {
          const parsed = JSON.parse(val);
          accountIds = Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          accountIds = [];
        }
      }
      if (name === "staggerSeconds") {
        const n = Number.parseFloat(String(val ?? "").trim());
        if (Number.isFinite(n)) staggerSeconds = Math.min(86_400, Math.max(0, n));
      }
      if (name === "scheduledStartAt") scheduledStartAt = String(val ?? "").trim();
      if (name === "uniqueCaptionPerAccount") {
        const s = String(val ?? "").trim().toLowerCase();
        uniqueCaptionPerAccount = s === "1" || s === "true" || s === "on" || s === "yes";
      }
      if (name === "captionTopic") captionTopic = String(val ?? "").trim();
    });

    busboy.on("file", (fieldname: string, fileStream: any, info: any) => {
      if (fieldname !== "video") {
        fileStream.resume();
        return;
      }

      // busboy's 3rd arg is typically either a string filename or an info object
      // depending on busboy version/types.
      const actualFilename =
        typeof info === "string" ? info : typeof info?.filename === "string" ? info.filename : "";

      videoDisplayName = safeDisplayName(actualFilename || "video.mp4");
      // Always write a stable file name for the worker: storage/tmp-uploads/<uploadId>/video.mp4
      videoPath = path.join(batchDir, "video.mp4");

      const ws = fs.createWriteStream(videoPath);
      fileStream.pipe(ws);

      fileWritePromise = new Promise<void>((resolve, reject) => {
        ws.on("finish", () => resolve());
        ws.on("error", reject);
        fileStream.on("error", reject);
      });
    });

    busboy.on("error", (err: unknown) => {
      rejectDone(err);
    });

    busboy.on("finish", async () => {
      try {
        if (fileWritePromise) await fileWritePromise;
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

    if (!videoPath || accountIds.length === 0) {
      return NextResponse.json({ error: "Video and at least one account are required" }, { status: 400 });
    }

    await connectDB();
    const ownerId = (user as { _id: mongoose.Types.ObjectId })._id;
    const accounts = await AccountModel.find({
      _id: { $in: accountIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).lean();
    if (accounts.length !== accountIds.length) {
      return NextResponse.json({ error: "One or more accounts not found" }, { status: 403 });
    }

    const isAdmin = (user as { role?: string }).role === "admin";
    for (const a of accounts) {
      if (!isAdmin && !userHasAccountAccess(a as { ownerId?: unknown; ownerIds?: unknown }, ownerId)) {
        return NextResponse.json({ error: "One or more accounts are not yours" }, { status: 403 });
      }
    }

    const byId = new Map(accounts.map((a: { _id: unknown }) => [String(a._id), a]));
    const ordered = accountIds.map((id) => byId.get(id)).filter(Boolean) as typeof accounts;
    if (ordered.length !== accountIds.length) {
      return NextResponse.json({ error: "Invalid account order" }, { status: 400 });
    }

    const staggerMs = Math.round(staggerSeconds * 1000);
    const hasSchedule = Boolean(scheduledStartAt);
    let baseMs = Date.now();
    if (hasSchedule) {
      const t = new Date(scheduledStartAt).getTime();
      if (Number.isNaN(t)) {
        return NextResponse.json({ error: "Invalid scheduledStartAt (use ISO date-time)" }, { status: 400 });
      }
      baseMs = t;
    }

    const oidAccountIds = accountIds.map((id) => new mongoose.Types.ObjectId(id));
    await UploadModel.updateMany(
      {
        accountId: { $in: oidAccountIds },
        status: "pending",
        uploadId: { $ne: uploadId },
      },
      { $set: { status: "failed", error: "superseded_by_new_batch" } }
    );

    const normalizedMusicQuery = musicQuery.trim();
    const normalizedParallelism = Math.max(1, Math.min(32, Number(parallelism || 4)));
    console.log("[UploadAPI] parsed request", {
      uploadId,
      accountCount: accountIds.length,
      hasMusicQuery: normalizedMusicQuery.length > 0,
      musicQuery: normalizedMusicQuery || "(none)",
      parallelism: normalizedParallelism,
      staggerSeconds,
      scheduledStartAt: hasSchedule ? scheduledStartAt : "(immediate)",
      uniqueCaptionPerAccount,
    });

    const nAccounts = ordered.length;
    let captions: string[] = [];
    if (uniqueCaptionPerAccount && nAccounts > 0) {
      const baseTopic =
        caption.trim() ||
        captionTopic ||
        normalizedMusicQuery ||
        `Short video file: ${videoDisplayName}`;
      try {
        for (let i = 0; i < nAccounts; i++) {
          const one = await generateTikTokCaption(baseTopic, {
            variationIndex: i,
            variationTotal: nAccounts,
          });
          captions.push(one);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Caption generation failed";
        return NextResponse.json(
          {
            error:
              msg.includes("GROQ_API_KEY") || msg.includes("Groq")
                ? "Unique captions require GROQ_API_KEY and a working Groq model. " + msg
                : msg,
          },
          { status: msg.includes("GROQ_API_KEY") ? 503 : 502 }
        );
      }
    }

    const uploadDocs = [];
    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i] as { _id: mongoose.Types.ObjectId };
      let notBefore: Date | null = null;
      if (staggerMs > 0) {
        notBefore = new Date(baseMs + i * staggerMs);
      } else if (hasSchedule) {
        notBefore = new Date(baseMs);
      }
      const rowCaption = uniqueCaptionPerAccount && captions[i] != null ? captions[i] : caption;
      const doc = await UploadModel.create({
        ownerId,
        uploadId,
        parallelism: normalizedParallelism,
        accountId: a._id,
        videoFileName: videoDisplayName,
        caption: rowCaption,
        ...(normalizedMusicQuery ? { musicQuery: normalizedMusicQuery } : {}),
        status: "pending",
        timestamp: new Date(),
        notBefore,
      });
      uploadDocs.push(doc);
    }

    // Auto-start the Mongo runner inside the Next.js server (no extra terminal).
    ensureMongoUploadRunnerStarted();

    return NextResponse.json({
      ok: true,
      success: true,
      processed: uploadDocs.length,
      uploadId,
      musicQuery: normalizedMusicQuery || null,
      parallelism: normalizedParallelism,
      staggerSeconds,
      scheduledStartAt: hasSchedule ? scheduledStartAt : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 500 }
    );
  }
}
