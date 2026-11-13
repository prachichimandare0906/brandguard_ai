import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { ConfigurationError, StorageUnavailableError } from '../errors.js';

export interface ObjectStorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
}

export interface StoredObjectPayload {
  orgId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

export interface StoredObjectLocation {
  provider: 's3';
  bucket: string;
  objectKey: string;
}

export function readObjectStorageConfigFromEnv(): ObjectStorageConfig | null {
  const bucket = (process.env.OBJECT_STORAGE_BUCKET || '').trim();
  const accessKeyId = (process.env.OBJECT_STORAGE_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY || '').trim();
  const endpoint = (process.env.OBJECT_STORAGE_ENDPOINT || '').trim() || undefined;
  const region = (process.env.OBJECT_STORAGE_REGION || (endpoint ? 'us-east-1' : '')).trim();
  const forcePathStyle = (process.env.OBJECT_STORAGE_FORCE_PATH_STYLE || '').trim().toLowerCase() === 'true';
  const rawPrefix = (process.env.OBJECT_STORAGE_PREFIX || '').trim().replace(/^\/+|\/+$/g, '');

  if (!bucket && !accessKeyId && !secretAccessKey) {
    return null;
  }

  if (!bucket || !accessKeyId || !secretAccessKey || !region) {
    throw new ConfigurationError(
      'Incomplete object storage configuration. Set OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_REGION, OBJECT_STORAGE_ACCESS_KEY_ID, and OBJECT_STORAGE_SECRET_ACCESS_KEY.'
    );
  }

  return {
    bucket,
    region,
    endpoint,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    prefix: rawPrefix,
  };
}

export function sanitizeFilename(fileName: string): string {
  const baseName = fileName.split(/[\\/]/).pop() || '';
  const cleaned = baseName
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return cleaned || 'document.bin';
}

export class ObjectStorageService {
  private readonly config: ObjectStorageConfig | null;
  private readonly client: S3Client | null;

  constructor(config?: ObjectStorageConfig | null, customClient?: S3Client) {
    this.config = config === undefined ? readObjectStorageConfigFromEnv() : config;

    if (this.config && customClient) {
      this.client = customClient;
    } else if (this.config) {
      this.client = new S3Client({
        region: this.config.region,
        endpoint: this.config.endpoint,
        forcePathStyle: this.config.forcePathStyle,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
      });
    } else {
      this.client = null;
    }
  }

  isConfigured(): boolean {
    return Boolean(this.config && this.client);
  }

  getBucket(): string | null {
    return this.config?.bucket ?? null;
  }

  buildOrgObjectKey(orgId: string, fileId: string, fileName: string): string {
    const safeOrg = orgId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeName = sanitizeFilename(fileName);
    const relativeKey = `orgs/${safeOrg}/assets/${fileId}-${safeName}`;
    return this.config?.prefix ? `${this.config.prefix}/${relativeKey}` : relativeKey;
  }

  private assertConfigured(): { config: ObjectStorageConfig; client: S3Client } {
    if (!this.config || !this.client) {
      throw new StorageUnavailableError(
        'S3-compatible object storage is not configured. Set OBJECT_STORAGE_BUCKET and credentials.'
      );
    }
    return { config: this.config, client: this.client };
  }

  async uploadObject(payload: StoredObjectPayload): Promise<StoredObjectLocation> {
    const { config, client } = this.assertConfigured();
    const objectKey = this.buildOrgObjectKey(payload.orgId, payload.fileId, payload.fileName);

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: objectKey,
          Body: payload.buffer,
          ContentType: payload.mimeType,
          Metadata: {
            orgid: payload.orgId,
            fileid: payload.fileId,
          },
        })
      );

      return {
        provider: 's3',
        bucket: config.bucket,
        objectKey,
      };
    } catch (err: any) {
      throw new StorageUnavailableError('Failed to store document in object storage.', { cause: err });
    }
  }

  async downloadObject(objectKey: string): Promise<Buffer> {
    const { config, client } = this.assertConfigured();

    try {
      const res = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: objectKey,
        })
      );

      if (!res.Body) {
        throw new StorageUnavailableError('Object storage returned an empty body.');
      }

      const bytes = await res.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err: any) {
      if (err instanceof StorageUnavailableError) throw err;
      throw new StorageUnavailableError('Failed to retrieve document from object storage.', { cause: err });
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    const { config, client } = this.assertConfigured();

    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: objectKey,
        })
      );
    } catch (err: any) {
      throw new StorageUnavailableError('Failed to delete document from object storage.', { cause: err });
    }
  }

  async healthCheck(): Promise<{ configured: boolean; status: 'ok' | 'unconfigured' }> {
    if (!this.config || !this.client) {
      return { configured: false, status: 'unconfigured' };
    }

    try {
      await this.client.send(
        new HeadBucketCommand({
          Bucket: this.config.bucket,
        })
      );
      return { configured: true, status: 'ok' };
    } catch (err: any) {
      throw new StorageUnavailableError('Object storage bucket health check failed.', { cause: err });
    }
  }
}
