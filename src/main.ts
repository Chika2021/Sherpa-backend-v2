import { setDefaultResultOrder } from 'dns';
import { setDefaultAutoSelectFamily } from 'net';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { configureOutboundNetwork } from './config/outbound-network';

// Node's fetch (undici) tries IPv6 first when a host resolves to both an A
// and AAAA record (Google's APIs, most CDNs, etc. do). On a lot of cloud
// VMs/containers the box advertises an IPv6 address that isn't actually
// routable to the outside world, so the IPv6 attempt hangs/reset and only
// then falls back to IPv4 - or on some networks it doesn't fall back
// cleanly at all and the whole request just throws a bare "fetch failed"
// with no useful detail. Forcing IPv4-first resolution is the standard fix
// for exactly this symptom (see https://github.com/nodejs/node/issues/40702)
// and costs nothing on networks that are IPv6-clean. Must run before any
// outbound requests are made (Gemini calls, database connection, etc.).
setDefaultResultOrder('ipv4first');
// `ipv4first` above only reorders the addresses dns.lookup() returns - it
// does NOT stop Node's newer dual-stack "Happy Eyeballs" behavior
// (autoSelectFamily, on by default since Node 18.13/20) from still racing
// the IPv6 address in parallel with IPv4. On a network that cleanly REJECTS
// IPv6 instantly (curl sees "Network is unreachable" immediately, most home/
// office networks with no IPv6 route), that race is harmless. But on a
// network/container where the IPv6 address is reachable-looking but a black
// hole (packets just vanish, no rejection, no response - common on cloud
// VMs/Docker), that stalled IPv6 attempt alone can burn the whole request
// timeout before IPv4 ever gets tried, surfacing as a bare "This operation
// was aborted"/"fetch failed" with no other clue. Disabling the race
// entirely makes every outbound connection behave like curl above: try one
// address, in the order ipv4first already set, no dual-stack racing at all.
setDefaultAutoSelectFamily(false);
configureOutboundNetwork();

async function bootstrap() {
  // rawBody: true preserves the raw request bytes on req.rawBody alongside
  // normal JSON parsing - needed to verify the Paystack webhook's HMAC
  // signature, which is computed over the exact bytes Paystack sent, not the
  // re-serialized parsed body.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableCors();
  app.setGlobalPrefix('api/v1');

  const port = process.env.PORT || 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🚀 Job Apply backend running on http://localhost:${port}/api/v1`);
}
bootstrap();
