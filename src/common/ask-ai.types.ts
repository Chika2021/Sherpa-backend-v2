/** One message in an "Ask AI" thread, as stored on an interview-prep session or skill course. */
export interface AskAiMessage {
  role: 'user' | 'assistant';
  content: string;
  // Interview question index / course module index this was asked about; null = the whole session/course.
  focusIndex: number | null;
  /** Stored inside a JSON column, so after a round-trip through the database this is an ISO string. */
  createdAt: Date | string;
}

/** Most messages kept per session/course; older ones are dropped so a record can't grow without bound. */
export const ASK_AI_MAX_STORED_MESSAGES = 60;
