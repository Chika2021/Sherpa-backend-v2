# Apply by email

New flow inside the Applications module. The user types the job title, description and requirements; the app
generates a tailored resume + cover letter and drafts the email. The user reviews/edits, then presses Send.
Nothing is sent without the explicit `send` call.

`:id` is always the APPLICATION id.

| Step | Request | Notes |
|---|---|---|
| Create | `POST /api/v1/applications/email` `{ jobTitle, jobDescription, requirements?, company?, location?, recipientEmail?, recipientEmails?, recipientName?, resumeId? }` | 3 tokens (resume + cover letter + email). Returns the application with `documents`, `emailApplication` (subject, body, recipientEmail, status) and `mailConfigured`. |
| View | `GET /applications/email/:id` | Same shape. |
| Edit | `PATCH /applications/email/:id` `{ recipientEmail?, recipientEmails?, recipientName?, subject?, body? }` | Blocked once sent. |
| Rewrite email | `POST /applications/email/:id/regenerate-email` `{ instructions?, recipientName? }` | 1 token. e.g. "shorter, more formal". |
| Rewrite documents | `POST /applications/email/:id/regenerate-documents` | 2 tokens. Old versions are removed after the new ones exist. Also the retry path if the first generation failed. |
| Send | `POST /applications/email/:id/send` `{ recipientEmail?, subject?, body?, sendCopyToMe?, resend? }` | Edits in the body are saved first. Attaches the latest resume + cover letter (.docx). Marks the application SUBMITTED. |

Existing endpoints that changed: `GET /applications` and `GET /applications/:id` now include `emailApplication`
for applications made this way. `DELETE /applications/:id` removes the email row too.

## Several recipients and job location
- `recipientEmails` is an array of up to 5 addresses; ONE email (documents attached) goes to all of them, so they all see each
  other in the To line. `recipientEmail` (single) still works and always mirrors the first address. Duplicates are removed and
  `PATCH { recipientEmails: [] }` clears the list. Responses include `recipientEmails` on `emailApplication`.
- `location` (city / country / "Remote") is saved on the job and given to the AI when it writes the resume, cover letter and email.

## How the email is sent
- From the app's verified sender (`MAIL_FROM_EMAIL`), shown as "<Applicant> via Sherpha", with **Reply-To set to the applicant**
  (the email on their resume, else their account email). Employers' replies reach the applicant, not the app.
- A hidden BCC copy goes to the account email unless `sendCopyToMe: false`.
- Needs `BREVO_API_KEY` or `RESEND_API_KEY` (or SMTP locally). With none configured, `send` returns 503 and says so; it never pretends to have sent.
- Limits: 10 sends/hour and 30/day per user (in-memory, per server instance), a second send needs `resend: true`, 4 MB attachment cap.

## Database
New table `email_applications` (entity `EmailApplication`). It is created on startup when `DB_SYNCHRONIZE` is on,
otherwise run `npm run db:sync`.
