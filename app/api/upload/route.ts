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
import { AccountModel } from "@/lib/models/Account";
import { UploadModel } from "@/lib/models/Upload";
import { ensureMongoUploadRunnerStarted } from "@/lib/mongoUploadRunner";
import { accountFilterForUser } from "@/lib/accountAccess";

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
      if (name === "accountIds") {
        try {
          const parsed = JSON.parse(val);
          accountIds = Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          accountIds = [];
        }
      }
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
    const access = accountFilterForUser(user);
    const accounts = await AccountModel.find({
      _id: { $in: accountIds.map((id) => new mongoose.Types.ObjectId(id)) },
      ...access,
    }).lean();
    if (accounts.length !== accountIds.length) {
      return NextResponse.json({ error: "One or more accounts not found or not yours" }, { status: 403 });
    }

    const oidAccountIds = accountIds.map((id) => new mongoose.Types.ObjectId(id));
    await UploadModel.updateMany(
      {
        ownerId,
        accountId: { $in: oidAccountIds },
        status: "pending",
        uploadId: { $ne: uploadId },
      },
      { $set: { status: "failed", error: "superseded_by_new_batch" } }
    );

    const normalizedMusicQuery = musicQuery.trim();
    console.log("[UploadAPI] parsed request", {
      uploadId,
      accountCount: accountIds.length,
      hasMusicQuery: normalizedMusicQuery.length > 0,
      musicQuery: normalizedMusicQuery || "(none)",
    });

    const uploadDocs = await Promise.all(
      accounts.map((a: any) =>
        UploadModel.create({
          ownerId,
          uploadId,
          accountId: a._id,
          videoFileName: videoDisplayName,
          caption,
          ...(normalizedMusicQuery ? { musicQuery: normalizedMusicQuery } : {}),
          status: "pending",
          timestamp: new Date(),
        })
      )
    );

    // Auto-start the Mongo runner inside the Next.js server (no extra terminal).
    ensureMongoUploadRunnerStarted();

    return NextResponse.json({
      ok: true,
      success: true,
      processed: uploadDocs.length,
      uploadId,
      musicQuery: normalizedMusicQuery || null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 500 }
    );
  }
}
