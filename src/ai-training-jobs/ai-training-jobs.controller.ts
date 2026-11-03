import { Body, Controller, Delete, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AiTrainingJobsService } from './ai-training-jobs.service';
import { SearchAiTrainingJobsDto } from './dto/search-ai-training-jobs.dto';
import { SavedAiTrainingJobsService } from './saved-ai-training-jobs.service';
import { DeleteSavedAiTrainingJobDto, SaveAiTrainingJobsDto } from './dto/saved-ai-training-jobs.dto';

// Same auth as the rest of the app. Remove @UseGuards if you want it public
// (then add a throttler - the upstream feeds have their own rate limits).
@UseGuards(JwtAuthGuard)
@Controller('ai-training-jobs')
export class AiTrainingJobsController {
  constructor(
    private service: AiTrainingJobsService,
    private saved: SavedAiTrainingJobsService,
  ) {}

  // GET /api/v1/ai-training-jobs?q=python&category=CODING_TRAINER&remote=true&limit=20&offset=0
  @Get()
  search(@Query() dto: SearchAiTrainingJobsDto) {
    return this.service.search(dto);
  }

  // Same search, streamed as newline-delimited JSON so the UI can show which
  // source is running and when it falls through to the next:
  //   {"type":"start","sources":["arbeitnow","jobicy",...]}
  //   {"type":"trying","source":"arbeitnow","step":1,"of":5}
  //   {"type":"attempt","attempt":{"source":"arbeitnow","found":0,"status":"ok"},"gathered":0}
  //   ...
  //   {"type":"done","result":{...same body as the plain GET...}}
  @Get('stream')
  async stream(@Query() dto: SearchAiTrainingJobsDto, @Res() res: any) {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no'); // stop nginx buffering the stream
    res.flushHeaders?.();

    let closed = false;
    res.on('close', () => (closed = true));

    try {
      for await (const event of this.service.searchStream(dto)) {
        if (closed) return; // user changed the search or left the page
        res.write(JSON.stringify(event) + '\n');
      }
    } catch (err) {
      if (!closed) res.write(JSON.stringify({ type: 'error', message: (err as Error).message }) + '\n');
    }
    if (!closed) res.end();
  }

  // GET /api/v1/ai-training-jobs/platforms  -> micro1, Outlier, DataAnnotation, ...
  @Get('platforms')
  platforms() {
    return this.service.platforms();
  }

  // ── Saved jobs (kept per user, so they are still there next time the app opens) ──

  // GET /api/v1/ai-training-jobs/saved  -> { total, jobs: [...] } newest first
  @Get('saved')
  listSaved(@CurrentUser('id') userId: string) {
    return this.saved.list(userId);
  }

  // POST /api/v1/ai-training-jobs/saved  { jobs: [ ...1 to 100 jobs ] }
  // One job = "Save"; several = "Save all". Already-saved jobs are left as they are.
  @Post('saved')
  save(@CurrentUser('id') userId: string, @Body() dto: SaveAiTrainingJobsDto) {
    return this.saved.save(userId, dto.jobs);
  }

  // DELETE /api/v1/ai-training-jobs/saved/all  -> removes every saved job
  // (declared as its own path so a missing ?id= can never wipe the list by accident)
  @Delete('saved/all')
  removeAllSaved(@CurrentUser('id') userId: string) {
    return this.saved.removeAll(userId);
  }

  // DELETE /api/v1/ai-training-jobs/saved?id=<job id>  -> removes one saved job
  @Delete('saved')
  removeSaved(@CurrentUser('id') userId: string, @Query() dto: DeleteSavedAiTrainingJobDto) {
    return this.saved.remove(userId, dto.id);
  }
}
