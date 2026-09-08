import type { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Blob storage. S3 API against MinIO locally and R2 in production — the
 * only difference is the endpoint, which is why this is the S3 client and
 * not the MinIO SDK. R2 has no egress fee, and reprocessing re-reads every
 * original repeatedly.
 */

const ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
export const BUCKET = process.env.S3_BUCKET ?? "memwe-blobs";

export const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: process.env.S3_REGION ?? "us-east-1",
  // MinIO serves path-style; R2 and S3 accept it too.
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "memwe",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "memwedevsecret",
  },
});

/**
 * Blob keys are content-addressed by document, never by filename. User
 * filenames are attacker-controlled and collide; a uuid does neither.
 */
export function blobKey(orgId: string, documentId: string): string {
  return `org/${orgId}/doc/${documentId}`;
}

export async function putObject(
  key: string,
  body: Buffer | string,
  contentType?: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ...(contentType ? { ContentType: contentType } : {}),
    }),
  );
}

export async function getObject(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const stream = res.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/**
 * Presigned PUT. The file goes browser -> storage directly; it never
 * passes through the API. That is what keeps a 50MB upload from occupying
 * an API worker for the duration of the transfer.
 */
export async function presignedPut(
  key: string,
  contentType: string,
  expiresIn = 900,
): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn },
  );
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key, Range: "bytes=0-0" }));
    return true;
  } catch {
    return false;
  }
}

/** Copy completed uploads away from the still-valid public PUT key. */
export async function copyObject(from: string, to: string): Promise<void> {
  await s3.send(
    new CopyObjectCommand({
      Bucket: BUCKET,
      Key: to,
      CopySource: `${BUCKET}/${from.split("/").map(encodeURIComponent).join("/")}`,
    }),
  );
}
