import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

export type RealtimeEvent =
  | { type: 'user.registered'; user: { id: string; email: string; name: string; createdAt: Date } }
  | { type: 'user.deleted'; userId: string }
  | { type: 'ticket.new'; ticket: { id: string; subject: string; name: string; email: string; source: string } }
  | { type: 'ticket.updated'; ticket: { id: string; status: string; awaitingAdmin: boolean } };

/**
 * In-process event bus. Services publish (AuthService on sign-up, SupportService on ticket activity)
 * and the admin dashboard's live stream subscribes. In-memory means it covers a single server
 * instance; the stream also re-reads the database every few seconds, so counts stay correct even
 * if you scale out or users are created by another process.
 */
@Injectable()
export class RealtimeService {
  private readonly subject = new Subject<RealtimeEvent>();

  get events$(): Observable<RealtimeEvent> {
    return this.subject.asObservable();
  }

  publish(event: RealtimeEvent): void {
    this.subject.next(event);
  }
}
