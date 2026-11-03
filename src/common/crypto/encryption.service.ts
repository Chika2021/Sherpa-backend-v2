import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const IV_LENGTH = 12; // recommended IV size for AES-GCM
const AUTH_TAG_LENGTH = 16;

/**
 * Reversible encryption for secrets we need to type back into a real login
 * form later (site passwords) - unlike user account passwords, which are
 * one-way hashed with bcrypt (see AuthService) because we only ever need to
 * *verify* those, never read them back.
 *
 * Requires CREDENTIALS_ENCRYPTION_KEY: a base64-encoded 32-byte key, e.g.
 * generated with `openssl rand -base64 32`. Keep this out of source control
 * and treat it like any other production secret - anyone with this key and
 * DB access can decrypt every stored site password. Rotating it will make
 * previously-stored credentials undecryptable, so back it up somewhere safe
 * (a secrets manager, not just a .env file on one machine).
 *
 * The key is only read/validated the first time encrypt/decrypt is actually
 * called, not at app boot, so services that don't touch site credentials
 * don't require this env var to be set.
 */
@Injectable()
export class EncryptionService {
  private key: Buffer | null = null;

  constructor(private config: ConfigService) {}

  encrypt(plaintext: string): string {
    const key = this.getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Pack iv + authTag + ciphertext into one opaque base64 blob so callers
    // only ever have to store/pass around a single string column.
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  decrypt(payload: string): string {
    const key = this.getKey();
    const raw = Buffer.from(payload, 'base64');
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    try {
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString('utf8');
    } catch {
      // Wrong key (e.g. it was rotated) or corrupted data - GCM's auth tag
      // check failing throws here, and the raw crypto error isn't useful to
      // whoever's debugging this.
      throw new InternalServerErrorException(
        'Could not decrypt stored credential - CREDENTIALS_ENCRYPTION_KEY may have changed since it was saved.',
      );
    }
  }

  private getKey(): Buffer {
    if (this.key) return this.key;
    const raw = this.config.get<string>('CREDENTIALS_ENCRYPTION_KEY');
    if (!raw) {
      throw new InternalServerErrorException(
        'CREDENTIALS_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and set it as an env var before storing site credentials.',
      );
    }
    const keyBuffer = Buffer.from(raw, 'base64');
    if (keyBuffer.length !== 32) {
      throw new InternalServerErrorException(
        'CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes. Generate one with `openssl rand -base64 32`.',
      );
    }
    this.key = keyBuffer;
    return this.key;
  }
}
