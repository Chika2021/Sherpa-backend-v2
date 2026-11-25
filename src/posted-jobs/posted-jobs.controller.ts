import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PostedJobsService } from './posted-jobs.service';
import { CreatePostedJobDto, ListPostedJobsQueryDto, UpdatePostedJobDto } from './posted-jobs.dto';

/**
 * Jobs posted by members.
 *
 *   POST   /posted-jobs          post a job (needs an expiresAt; the post is deleted automatically when it passes)
 *   GET    /posted-jobs          browse everyone's live posts  ?search= &jobType= &page= &limit=
 *   GET    /posted-jobs/mine     the signed-in member's own live posts
 *   GET    /posted-jobs/:id      one live post
 *   PATCH  /posted-jobs/:id      edit your own post (any field, including the expiry date)
 *   DELETE /posted-jobs/:id      delete your own post
 */
@UseGuards(JwtAuthGuard)
@Controller('posted-jobs')
export class PostedJobsController {
  constructor(private postedJobs: PostedJobsService) {}

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreatePostedJobDto) {
    return this.postedJobs.create(userId, dto);
  }

  @Get()
  list(@CurrentUser('id') userId: string, @Query() query: ListPostedJobsQueryDto) {
    return this.postedJobs.listPublic(userId, query);
  }

  // Must stay above ':id' so "mine" is not read as an id.
  @Get('mine')
  mine(@CurrentUser('id') userId: string) {
    return this.postedJobs.listMine(userId);
  }

  @Get(':id')
  getOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.postedJobs.getOne(userId, id);
  }

  @Patch(':id')
  update(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: UpdatePostedJobDto) {
    return this.postedJobs.update(userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.postedJobs.remove(userId, id);
  }
}
