import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JobSourceSettingsService } from './job-source-settings.service';
import { UpdateJobSourceSettingsDto } from './dto/update-job-source-settings.dto';

@UseGuards(JwtAuthGuard)
@Controller('job-sources')
export class JobSourceSettingsController {
  constructor(private settingsService: JobSourceSettingsService) {}

  @Get('settings')
  get() {
    return this.settingsService.getSettings();
  }

  // body: { "adzunaEnabled": true, "weAreDevelopersEnabled": false, "arcDevEnabled": true }
  @Put('settings')
  update(@Body() dto: UpdateJobSourceSettingsDto) {
    return this.settingsService.updateSettings(dto);
  }
}
