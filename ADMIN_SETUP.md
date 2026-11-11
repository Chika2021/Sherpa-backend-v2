# Admin dashboard, helpdesk, chatbot & contact form

## What was added
| Area | Where |
|---|---|
| Admin API (stats, users, live stream, token grants) | `src/admin/` |
| Helpdesk (tickets + replies, public contact form) | `src/support/` + 2 new entities |
| Chatbot (knowledge-base + AI answers) | `src/chatbot/` (edit `chatbot.knowledge.ts`) |
| Live event bus | `src/realtime/` |
| Admin dashboard UI | `public/admin/index.html` -> `https://<api-host>/admin` |
| Homepage contact section + chat bubble + user helpdesk | `public/widget/sherpar-widget.js` |

Modified existing files: `app.module.ts`, `entities/index.ts`, `entities/user.entity.ts` (role, suspended, lastLoginAt),
`auth/auth.service.ts` (live event on sign-up, suspended check, role in response, lastLoginAt),
`auth/strategies/jwt.strategy.ts` (suspended users rejected), `mail/mail.service.ts` (sendNotification, providerName).

## Setup
1. Copy `src/` and `public/` into your project (the `public/` folder sits next to `src/`, i.e. `process.cwd()/public`).
   If you build to Docker/Render, make sure `public/` is copied into the image.
2. Env vars:
   - `ADMIN_EMAILS=you@example.com` - existing accounts with these emails become admins on next start.
   - or `ADMIN_EMAIL` + `ADMIN_PASSWORD` - creates the admin account if it doesn't exist (remove the password afterwards).
   - `SUPPORT_INBOX_EMAIL` (optional) - where "new ticket" alerts go (defaults to the first ADMIN_EMAILS).
   - `FRONTEND_URL` (already used for password reset) - used in reply emails.
3. Database: new columns/tables are created automatically when `DB_SYNCHRONIZE` is on (default outside production).
   In production run `npm run db:sync` once.
4. Open `https://<api-host>/admin` and sign in with the admin account.

## Homepage contact section + chatbot
Add to your homepage (any framework), where the section should appear:
```html
<div id="sherpar-contact"></div>
<script src="https://<api-host>/widget/sherpar-widget.js" data-token-key="accessToken" data-app-url="https://<your-app>" defer></script>
```
- `data-token-key`: the localStorage key where your frontend stores the login JWT (lets logged-in users see the Helpdesk tab).
- The script also adds the floating chat button on every page it is included on - put it in your global layout.
- Chatbot links use routes guessed from the backend (`/jobs`, `/tokens`, ...). Edit `path` values in `src/chatbot/chatbot.knowledge.ts`.

## Endpoints
Public: `POST /api/v1/support/contact`, `POST /api/v1/chatbot/message`, `GET /api/v1/chatbot/welcome`
User (JWT): `POST|GET /support/tickets`, `GET /support/tickets/:id`, `POST /support/tickets/:id/reply`, `GET /support/tickets/unread-count`
Admin (JWT + role ADMIN): `GET /admin/overview|signups|system|users|users/:id|stream`, `PATCH /admin/users/:id`,
`POST /admin/users/:id/tokens`, `GET /admin/support/summary|tickets|tickets/:id`, `POST /admin/support/tickets/:id/reply`, `PATCH /admin/support/tickets/:id/status`

## Notes
- Live counter: Server-Sent Events. Updates instantly on registration (same server process) and re-checks the DB every 10s,
  so it stays right even with several instances. If you put a proxy/CDN in front, disable response buffering for `/api/v1/admin/stream`.
- Replies to visitors (no account) are delivered by email, so configure `BREVO_API_KEY`/`RESEND_API_KEY`. The dashboard's App info tab shows whether mail is configured.
- Not compiled against your dependencies here (no node_modules in the upload): run `npm run build` once and send me any error.
