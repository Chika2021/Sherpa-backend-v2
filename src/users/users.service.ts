import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { assertValidId } from '../database/db-utils';

const EDITABLE_FIELDS = ['firstName', 'lastName', 'phone', 'location', 'linkedinUrl', 'portfolioUrl'] as const;

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private users: Repository<User>) {}

  private sanitize(user: User) {
    const { passwordHash, passwordResetTokenHash, passwordResetExpiresAt, ...safe } = user.toJSON() as any;
    return safe;
  }

  async getProfile(userId: string) {
    assertValidId(userId, 'User');
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');
    return this.sanitize(user);
  }

  async updateProfile(
    userId: string,
    data: Partial<{
      firstName: string;
      lastName: string;
      phone: string;
      location: string;
      linkedinUrl: string;
      portfolioUrl: string;
    }>,
  ) {
    assertValidId(userId, 'User');

    // Only the profile fields below can be changed through this endpoint. (The body is an
    // untyped object, so anything else - tokens, passwordHash, email - is deliberately ignored.)
    const patch: Record<string, string | null> = {};
    for (const key of EDITABLE_FIELDS) {
      const value = (data as any)?.[key];
      if (value === null) patch[key] = null;
      else if (typeof value === 'string') patch[key] = value;
      else if (typeof value === 'number' || typeof value === 'boolean') patch[key] = String(value);
    }

    if (Object.keys(patch).length > 0) {
      await this.users.update({ id: userId }, patch);
    }
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');
    return this.sanitize(user);
  }
}
