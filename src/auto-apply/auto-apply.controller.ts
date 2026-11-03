import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AutoApplyService } from './auto-apply.service';

@UseGuards(JwtAuthGuard)
@Controller('auto-apply')
// Auto Apply runs in the user's browser now; these endpoints only expose the history of earlier batches.
export class AutoApplyController {
  constructor(private autoApplyService: AutoApplyService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.autoApplyService.listForUser(userId);
  }

  @Get(':id')
  getStatus(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.autoApplyService.getStatus(userId, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.autoApplyService.cancel(userId, id);
  }
}