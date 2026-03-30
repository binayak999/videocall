import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { nanoid } from "nanoid";

let cachedClient: S3Client | null = null;

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`${name} is not set`);
  }
  return v;
}

/**
 * S3 API URL for PutObject — must be the real S3-compatible endpoint.
 * Custom “public” domains often are CDN-only; use Cloudflare’s host: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
 */
export function resolveR2S3Endpoint(): string {
  const raw = process.env.R2_ENDPOINT?.trim();
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  if (raw && raw.length > 0) {
    return raw.replace(/\/$/, "");
  }
  if (accountId && accountId.length > 0) {
    return `https://${accountId}.r2.cloudflarestorage.com`;
  }
  throw new Error(
    "Set R2_ENDPOINT (S3 API URL) or R2_ACCOUNT_ID (builds https://<id>.r2.cloudflarestorage.com). Public CDN hostnames are not the S3 API.",
  );
}

export function r2FailureMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}

export function getR2S3Client(): S3Client {
  if (cachedClient) {
    return cachedClient;
  }
  const endpoint = resolveR2S3Endpoint();
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  // Virtual-hosted URLs use https://<bucket>.<endpoint-host>/... — custom R2 domains rarely have DNS for that
  // (e.g. ENOTFOUND videoapp.videomedia.example.com). Path-style uses https://<endpoint>/<bucket>/key — default on.
  const forceEnv = process.env.R2_FORCE_PATH_STYLE?.trim().toLowerCase();
  const forcePathStyle = !(forceEnv === "false" || forceEnv === "0");
  cachedClient = new S3Client({
    region: process.env.R2_REGION?.trim() || "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle,
  });
  return cachedClient;
}

export function getRecordingsBucketName(): string {
  return requireEnv("R2_BUCKET_NAME");
}

export function buildRecordingObjectKey(meetingId: string): string {
  return `recordings/${meetingId}/${nanoid(18)}.webm`;
}

export function isRecordingKeyForMeeting(key: string, meetingId: string): boolean {
  if (key.includes("..") || key.includes("\\")) {
    return false;
  }
  const prefix = `recordings/${meetingId}/`;
  if (!key.startsWith(prefix) || key.length <= prefix.length) {
    return false;
  }
  const rest = key.slice(prefix.length);
  return rest.length > 0 && !rest.includes("/");
}

/** Strip codec suffixes so R2/S3 metadata stays simple and matches presigned PUT. */
export function normalizeRecordingContentType(headerValue: string): string {
  const base = headerValue.split(";")[0]?.trim() || "video/webm";
  if (base === "video/webm" || base === "video/mp4" || base === "video/quicktime") {
    return base;
  }
  return "video/webm";
}

export async function putRecordingObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const client = getR2S3Client();
  const bucket = getRecordingsBucketName();
  const ct = normalizeRecordingContentType(contentType);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: ct,
    }),
  );
}

export async function presignedPutRecording(
  key: string,
  contentType: string,
  expiresSec = 3600,
): Promise<string> {
  const client = getR2S3Client();
  const bucket = getRecordingsBucketName();
  const ct = normalizeRecordingContentType(contentType);
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: ct,
  });
  return getSignedUrl(client, cmd, { expiresIn: expiresSec });
}

export async function presignedGetRecording(key: string, expiresSec = 3600): Promise<string> {
  const client = getR2S3Client();
  const bucket = getRecordingsBucketName();
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, cmd, { expiresIn: expiresSec });
}

/** When the bucket is exposed via a public URL (custom domain or r2.dev). */
export function publicRecordingUrl(key: string): string | null {
  const base = process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (!base) {
    return null;
  }
  const encoded = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${base}/${encoded}`;
}
