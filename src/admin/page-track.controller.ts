import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PageAnalyticsService } from './page-analytics.service';
import { TrackPageViewDto } from './page-analytics.dto';

/** Called by the frontend on every route change so the super admin can see which pages people open. */
@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class PageTrackController {
  constructor(private pages: PageAnalyticsService) {}

  @Post('page-view')
  track(@CurrentUser() user: { id: string; role?: string }, @Body() dto: TrackPageViewDto) {
    return this.pages.record(user, dto);
  }
}
