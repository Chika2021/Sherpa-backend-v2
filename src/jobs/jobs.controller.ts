import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JobsService } from './jobs.service';
import { SearchJobsDto } from './dto/search-jobs.dto';

@UseGuards(JwtAuthGuard)
@Controller('jobs')
export class JobsController {
  constructor(private jobsService: JobsService) {}

  // e.g. body: { "jobTypes": ["REMOTE", "FREELANCE"] }  -> browse by category
  // or:        { "query": "junior graphic designer" }    -> type the job you want
  @Post('search')
  search(@CurrentUser('id') userId: string, @Body() dto: SearchJobsDto) {
    return this.jobsService.search(userId, dto);
  }

  @Get('searches/:id')
  getSearch(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<Record<string, any>> {
    return this.jobsService.getSearch(userId, id);
  }

  @Get('saved')
  listSaved(@CurrentUser('id') userId: string) {
    return this.jobsService.listSaved(userId);
  }

  @Get(':id')
  getJob(@Param('id') id: string) {
    return this.jobsService.getJob(id);
  }

  @Post(':id/save')
  save(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.jobsService.saveJob(userId, id);
  }

  @Delete(':id/save')
  unsave(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.jobsService.unsaveJob(userId, id);
  }
}
