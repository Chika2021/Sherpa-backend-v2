import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { Role } from '../roles';

/** Use AFTER JwtAuthGuard. Fails closed: a route with no @Roles() is refused for everyone. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    const user = context.switchToHttp().getRequest().user;
    if (!allowed?.length || !allowed.includes(user?.role)) {
      throw new ForbiddenException('You do not have permission to do this');
    }
    return true;
  }
}
