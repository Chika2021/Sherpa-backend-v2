import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimiter, clientIp } from '../common/rate-limiter';
import { ChatbotService } from './chatbot.service';
import { ChatMessageDto } from './chatbot.dto';
import { QUICK_SUGGESTIONS } from './chatbot.knowledge';

const limiter = new RateLimiter(20, 60 * 1000); // 20 messages / minute / IP

/** Public on purpose: visitors can ask questions before they have an account. */
@Controller('chatbot')
export class ChatbotController {
  constructor(private bot: ChatbotService) {}

  @Get('welcome')
  welcome() {
    return {
      reply: "Hi! I'm the Sherpar assistant. Ask me anything about the app - I can also connect you with our support team.",
      suggestions: QUICK_SUGGESTIONS,
    };
  }

  @Post('message')
  message(@Body() dto: ChatMessageDto, @Req() req: Request) {
    limiter.check(clientIp(req));
    return this.bot.reply(dto.message, dto.history ?? []);
  }
}
