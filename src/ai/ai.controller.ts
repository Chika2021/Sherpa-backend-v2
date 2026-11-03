import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { GeminiService } from './gemini.service';

/**
 * GET /ai/status - tells you which AI is configured and which one actually
 * answered the most recent request (Gemini + model, or the Cerebras backup),
 * plus any model currently cooling down after a quota (429) error.
 * Handy for a small "AI: Gemini (model)" badge in the UI.
 */
@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(private gemini: GeminiService) {}

  @Get('status')
  status() {
    return this.gemini.getAiStatus();
  }
}
