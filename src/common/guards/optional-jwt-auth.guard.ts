import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Like JwtAuthGuard, but never rejects: a valid token sets `request.user`, anything else (no token, expired, suspended)
 * just leaves the request anonymous. For public pages that show a little more to a signed-in member.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }

  handleRequest<TUser = any>(_err: unknown, user: TUser | false): TUser | null {
    return user || null;
  }
}
