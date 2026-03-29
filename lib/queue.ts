import { Queue } from "bullmq";
import IORedis from "ioredis";

const QUEUE_NAME = process.env.UPLOAD_QUEUE_NAME || "tiktok-upload";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);

if (!REDIS_HOST) throw new Error("Missing REDIS_HOST in environment variables");
if (!REDIS_PORT || Number.isNaN(REDIS_PORT)) throw new Error("Invalid REDIS_PORT in environment variables");

export const redisConnection = new IORedis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null,
});

export type UploadJobPayload = {
  uploadId: string;
  accountId: string;
  username: string;
  session: string;
  proxy?: string;
  videoPath: string;
  caption: string;
  musicQuery?: string;
  uploadDocId?: string;
};

export const uploadQueue = new Queue<UploadJobPayload>(QUEUE_NAME, {
  connection: redisConnection,
});

export { QUEUE_NAME };

