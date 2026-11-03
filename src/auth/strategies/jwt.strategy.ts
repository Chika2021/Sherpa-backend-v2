import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/user.entity';
import { isUuid } from '../../database/db-utils';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @InjectRepository(User) private users: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: { sub: string; email: string }) {
    // A token issued before the move to Postgres carries a Mongo id - treat it as unauthenticated.
    if (!isUuid(payload?.sub)) return null;
    const user = await this.users.findOneBy({ id: payload.sub });
    if (!user) return null;
    const { passwordHash, passwordResetTokenHash, passwordResetExpiresAt, ...safeUser } = user.toJSON() as any;
    return safeUser;
  }
}
