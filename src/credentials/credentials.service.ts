import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EncryptionService } from '../common/crypto/encryption.service';
import { SiteCredential } from '../entities/site-credential.entity';
import { assertValidId, ownedBy } from '../database/db-utils';
import { CreateSiteCredentialDto } from './dto/create-site-credential.dto';

export interface DecryptedSiteCredential {
  username: string;
  password: string;
  loginUrl?: string;
  signupUrl?: string;
  autoSignupIfMissing: boolean;
}

@Injectable()
export class CredentialsService {
  constructor(
    @InjectRepository(SiteCredential) private credentials: Repository<SiteCredential>,
    private encryption: EncryptionService,
  ) {}

  async upsert(userId: string, dto: CreateSiteCredentialDto) {
    const domain = this.normalizeDomain(dto.domain);
    const encryptedPassword = this.encryption.encrypt(dto.password);

    assertValidId(userId, 'User');

    // Insert-or-update on the unique (userId, domain) pair. Fields left undefined
    // (label, loginUrl, signupUrl) are not touched on update, exactly as before.
    await this.credentials.upsert(
      {
        userId,
        domain,
        label: dto.label,
        username: dto.username,
        encryptedPassword,
        loginUrl: dto.loginUrl,
        signupUrl: dto.signupUrl,
        autoSignupIfMissing: dto.autoSignupIfMissing ?? false,
      },
      ['userId', 'domain'],
    );
    const credential = await this.credentials.findOneByOrFail({ userId, domain });

    return this.toSafeJSON(credential);
  }

  async listForUser(userId: string) {
    assertValidId(userId, 'User');
    const credentials = await this.credentials.find({ where: { userId }, order: { domain: 'ASC' } });
    return credentials.map((c) => this.toSafeJSON(c));
  }

  async remove(userId: string, id: string) {
    const existing = await this.credentials.findOneBy(ownedBy(id, userId, 'Credential'));
    if (!existing) throw new NotFoundException('Credential not found');
    await this.credentials.delete({ id: existing.id });
    return { removed: true };
  }

  /**
   * Internal use only - called from the auto-apply pipeline right before a
   * submission attempt. Returns the decrypted password, so this must never
   * be exposed through a controller; only listForUser()'s sanitized output
   * (via toSafeJSON) is safe to send to the client.
   */
  async findForDomain(userId: string, hostname: string): Promise<DecryptedSiteCredential | null> {
    const normalized = hostname.toLowerCase();
    assertValidId(userId, 'User');
    const credentials = await this.credentials.find({ where: { userId } });
    const match = credentials.find((c) => normalized === c.domain || normalized.endsWith(`.${c.domain}`));
    if (!match) return null;

    this.credentials.update({ id: match.id }, { lastUsedAt: new Date() }).catch(() => undefined);

    return {
      username: match.username,
      password: this.encryption.decrypt(match.encryptedPassword),
      loginUrl: match.loginUrl,
      signupUrl: match.signupUrl,
      autoSignupIfMissing: match.autoSignupIfMissing,
    };
  }

  private normalizeDomain(domain: string): string {
    return domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
  }

  private toSafeJSON(doc: SiteCredential) {
    const json: any = doc.toJSON();
    delete json.encryptedPassword; // never leaves the server, not even to the credential's own owner
    return json;
  }
}
