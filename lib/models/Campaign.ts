import { Schema, model, models } from "mongoose";

/** Multi-video, multi-account scheduled uploads with waves and optional repeat cycles. */
const CampaignSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** Same as Upload.uploadId — folder under storage/tmp-uploads */
    uploadId: { type: String, required: true, unique: true, index: true },
    accountIds: [{ type: Schema.Types.ObjectId, ref: "Account" }],
    /** Relative paths under batch dir, e.g. videos/0.mp4 */
    videoRelPaths: [{ type: String, required: true }],
    captions: [{ type: String, required: true }],
    /** One TikTok sound search for every video in the campaign (preferred). */
    musicQuery: { type: String, required: false },
    /** @deprecated legacy per-line sound; use `musicQuery` */
    musicQueries: [{ type: String, required: false }],
    /** Per account: permutation of indices into videoRelPaths (shuffle or identity). */
    perAccountVideoOrder: [[{ type: Number, required: true }]],
    captionMode: { type: String, enum: ["same", "per_video", "ai_unique_each"], default: "per_video" },
    parallelism: { type: Number, required: true },
    staggerSeconds: { type: Number, default: 0 },
    cycleGapSeconds: { type: Number, default: 0 },
    repeatForever: { type: Boolean, default: false },
    /** Full passes (all accounts, all videos). Ignored when `repeatForever` is true. Default 1 = run once. */
    maxCycles: { type: Number, default: 1, min: 1 },
    /** First account index for the wave we are filling (0, parallelism, 2*parallelism, …). */
    waveStartAccountIndex: { type: Number, default: 0 },
    /** How many accounts in the current wave finished all their videos. */
    accountsFinishedInWave: { type: Number, default: 0 },
    cycle: { type: Number, default: 0 },
    scheduledStartAt: { type: Date, default: null },
    status: { type: String, enum: ["active", "paused", "completed"], default: "active" },
  },
  { timestamps: true }
);

export type CampaignDoc = {
  _id: string;
  ownerId: string;
  uploadId: string;
  accountIds: string[];
  videoRelPaths: string[];
  captions: string[];
  musicQuery?: string | null;
  musicQueries?: string[];
  perAccountVideoOrder: number[][];
  captionMode: "same" | "per_video" | "ai_unique_each";
  parallelism: number;
  staggerSeconds: number;
  cycleGapSeconds: number;
  repeatForever: boolean;
  /** Omitted on older documents; treat as 1. */
  maxCycles?: number;
  waveStartAccountIndex: number;
  accountsFinishedInWave: number;
  cycle: number;
  status: string;
};

export const CampaignModel = models.Campaign || model("Campaign", CampaignSchema);
