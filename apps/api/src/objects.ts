// The object store, addressed only as an S3-compatible endpoint (Garage in development; anything speaking S3 later).
// Nothing outside this file knows which store it is. Keys: t/<tenant_id>/<sha256> for a tenant's pictures and
// c/<sha256> for the operator's template pictures.
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const bucket = process.env.S3_BUCKET ?? 'pos-images';
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:53900',
  region: process.env.S3_REGION ?? 'garage',
  forcePathStyle: true, // bucket in the path, not the host name: works with Garage and with any self-hosted store
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'GK000000000000000000000001',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '0'.repeat(63) + '1',
  },
});

export const tenantKey = (tenantId: string, sha256: string) => `t/${tenantId}/${sha256}`;
export const catalogKey = (sha256: string) => `c/${sha256}`;

export const putObject = (key: string, body: Buffer, contentType: string) =>
  s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })).then(() => undefined);

export async function getObject(key: string): Promise<Buffer | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  } catch (e) {
    if ((e as { name?: string }).name === 'NoSuchKey') return null;
    throw e;
  }
}

/** Server-side copy: the bytes never pass through the API. */
export const copyObject = (from: string, to: string) =>
  s3.send(new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: `${bucket}/${from}` })).then(() => undefined);

export const deleteObject = (key: string) => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).then(() => undefined);

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === 'NotFound') return false;
    throw e;
  }
}

export const closeObjects = () => s3.destroy();
