import { Body, Controller, Get, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { DbRetryInterceptor } from '../common/db-retry.interceptor';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ReferralsService } from './referrals.service';

class ReverseReferralDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

/** The signed-in user's invite link, and how their friends are doing. */
@UseGuards(JwtAuthGuard)
@Controller('referrals')
export class ReferralsController {
  constructor(private referrals: ReferralsService) {}

  /** { code, link, shareText, rewards, stats: { friendsJoined, friendsVerified, friendsPurchased, tokensEarned, ... }, friends[] } */
  @Get('me')
  me(@CurrentUser('id') userId: string) {
    return this.referrals.myReferral(userId);
  }
}

/** Referral audit for admins. Reversing rewards (a token deduction) is super admin only, like the other token corrections. */
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(DbRetryInterceptor)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/referrals')
export class ReferralsAdminController {
  constructor(private referrals: ReferralsService) {}

  /** ?userId= limits it to referrals where that user is the referrer or the friend. */
  @Get()
  list(@Query('userId') userId?: string) {
    return this.referrals.adminList(userId);
  }

  @Roles('SUPER_ADMIN')
  @Post(':id/reverse')
  reverse(@CurrentUser() actor: { id: string; role: string }, @Param('id') id: string, @Body() dto: ReverseReferralDto) {
    return this.referrals.reverse({ id: actor.id, role: actor.role }, id, dto.note);
  }
}
