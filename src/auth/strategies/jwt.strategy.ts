import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/user.entity';
import { isUuid } from '../../database/db-utils';
import { isBackendRequest } from '../../common/super-admin-access';
import { SessionTrackerService } from '../session-tracker.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly superAdminOrigins: string;

  constructor(
    config: ConfigService,
    @InjectRepository(User) private users: Repository<User>,
    private tracker: SessionTrackerService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET'),
      passReqToCallback: true,
    });
    this.superAdminOrigins = config.get<string>('SUPER_ADMIN_ALLOWED_ORIGINS') ?? '';
  }

  async validate(req: { headers: Record<string, string | string[] | undefined> }, payload: { sub: string; email: string }) {
    // A token issued before the move to Postgres carries a Mongo id - treat it as unauthenticated.
    if (!isUuid(payload?.sub)) return null;
    const user = await this.users.findOneBy({ id: payload.sub });
    if (!user || user.suspended) return null;
    // Super admin is backend-only: the same token sent from the frontend app's origin is rejected (401).
    if (user.role === 'SUPER_ADMIN' && !isBackendRequest(req, this.superAdminOrigins)) return null;
    // Count this request as activity (fire-and-forget: tracking never blocks or fails a request).
    void this.tracker.touch({ id: user.id, role: user.role });
    const { passwordHash, passwordResetTokenHash, passwordResetExpiresAt, ...safeUser } = user.toJSON() as any;
    return safeUser;
  }
}
