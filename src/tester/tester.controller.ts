import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TokensService } from '../tokens/tokens.service';
import { FREE_SIGNUP_TOKENS } from '../tokens/token-pricing.config';

/**
 * API for the tester screen. There is deliberately NO tester UI served from this backend - the tester
 * interface lives in the frontend app and talks to these endpoints (it can also use the normal app APIs,
 * because a tester is a regular account with an extra role). Add new tester endpoints here.
 * Sign in with POST /auth/login; the response includes `user.role` so the frontend can route testers.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TESTER', 'SUPER_ADMIN')
@Controller('tester')
export class TesterController {
  constructor(private tokens: TokensService) {}

  /** Who am I, and what can I do. */
  @Get('me')
  me(@CurrentUser() user: any) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      role: user.role,
      tokens: user.tokens,
      lastLoginAt: user.lastLoginAt ?? null,
      createdAt: user.createdAt,
    };
  }

  /** Non-secret settings a tester screen needs to show what environment it is pointed at. */
  @Get('config')
  config() {
    return {
      environment: process.env.NODE_ENV ?? 'development',
      apiVersion: 'v1',
      freeSignupTokens: FREE_SIGNUP_TOKENS,
      pricing: this.tokens.pricing(),
    };
  }
}
