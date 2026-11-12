import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, retry, throwError, timer } from 'rxjs';
import { isTransientConnectionError } from '../database/transient-errors';

const RETRIES = 2;

/**
 * Re-runs a READ (GET) request when the database connection it was using got dropped
 * ("Connection terminated unexpectedly" - the Supabase pooler closes idle connections).
 * The second attempt gets a fresh connection from the pool and normally succeeds, so the
 * admin dashboard stops showing random 500s. Writes (POST/PATCH/DELETE) are never retried.
 */
@Injectable()
export class DbRetryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ method?: string }>();
    if (req?.method !== 'GET') return next.handle();

    return next.handle().pipe(
      retry({
        count: RETRIES,
        delay: (error, attempt) =>
          isTransientConnectionError(error) ? timer(250 * attempt) : throwError(() => error),
      }),
    );
  }
}
