import { Controller, Get } from '@nestjs/common';

/**
 * GET /api/v1/health - public, instant, touches nothing. Used by the keep-awake ping and is
 * handy as a Render "Health Check Path" or for an uptime monitor.
 */
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }
}
