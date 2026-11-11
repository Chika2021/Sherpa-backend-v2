import { SetMetadata } from '@nestjs/common';
import type { Role } from '../roles';

export const ROLES_KEY = 'allowedRoles';

/**
 * Which roles may call a controller or a single route. A route-level @Roles() overrides the
 * controller-level one, so a controller can allow ADMIN to read and one route can narrow that to SUPER_ADMIN.
 * Use together with `@UseGuards(JwtAuthGuard, RolesGuard)`.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
