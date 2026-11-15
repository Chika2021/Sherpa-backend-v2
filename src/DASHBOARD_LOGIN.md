# Dashboard login for every role

Everyone except USER can sign in to the frontend dashboard and lands on their own dashboard.

## Login
`POST /api/v1/auth/admin-login`  `{ "email": "...", "password": "..." }`

Response:
```json
{
  "accessToken": "...",
  "user": { "id": "...", "email": "...", "role": "TESTER", "tokens": 0 },
  "dashboard": { "key": "tester", "path": "/dashboard/tester", "label": "Tester", "permissions": ["tester.overview", "tester.bug-reports"] }
}
```
- Frontend: store `accessToken`, then `router.push(dashboard.path)`.
- A USER account gets `403 This account does not have dashboard access.` Wrong password is still `401`.
- `POST /auth/login` also returns `dashboard` (null for USER), so one login form can redirect too.
- `GET /api/v1/dashboard/me` returns `{ user, dashboard }` for a page refresh.

## Dashboards
| Role | key | path | API |
|------|-----|------|-----|
| SUPER_ADMIN | super-admin | /admin (served by the backend) | everything under /admin/* - backend only, see below |
| ADMIN | admin | /dashboard/admin | /admin/overview, /admin/users (read), /admin/support (read), /admin/local-job-boards |
| MANAGEMENT | management | /dashboard/management | GET /dashboard/management/overview, /admin/users (manage user/tester/staff), /admin/payments, /admin/stream |
| STAFF | staff | /dashboard/staff | GET /dashboard/staff/overview, /admin/countdown (+ /stream) |
| TESTER | tester | /dashboard/tester | GET /dashboard/tester/overview, GET/POST /dashboard/tester/bug-reports, /tester/me, /tester/config |

Paths live in `src/common/roles.ts` (`DASHBOARDS`) - rename them there if your frontend routes differ.
The API enforces every role server-side; `permissions` is only for showing/hiding menu items.
SUPER_ADMIN can open the tester, staff and management endpoints to preview them.

## Creating these accounts
Super admin: Dashboard > Users > Create (role TESTER / STAFF / ADMIN / MANAGEMENT).
Management can create USER, TESTER and STAFF only. No database changes are needed.

## Super admin is backend-only
The super admin is never used from the frontend app. It works from the dashboard served by this backend
(`https://<api-host>/admin`) or by calling the API directly (curl, Postman, a server script).

- A browser request from any other origin is refused: `POST /auth/login` and `/auth/admin-login` return
  `403 The super admin can only be used from the backend...`, and a super admin token sent from the frontend
  gets `401` on every route.
- Requests with no `Origin` header (curl, Postman, server scripts) and requests from the backend's own
  origin are allowed.
- Optional: `SUPER_ADMIN_ALLOWED_ORIGINS=https://api.example.com,http://localhost:3000` - when set, ONLY those
  origins are accepted (use it if the frontend and backend share a domain). Rule lives in `src/common/super-admin-access.ts`.
- Super admin accounts are still created only from the `SUPER_ADMIN_*` env vars.

## Tokens (super admin only)
`POST /api/v1/admin/users/:id/tokens`         `{ "amount": 10, "note": "goodwill" }`  -> `{ tokensCredited, balanceAfter }`
`POST /api/v1/admin/users/:id/tokens/deduct`  `{ "amount": 3, "note": "wrong grant" }` -> `{ tokensDebited, balanceAfter }`

- `amount` is always positive (0.01 - 100,000); the route decides add or subtract. `note` is optional (max 120 chars).
- Deducting more than the user has returns `400` and the balance is left alone - it never goes negative.
- Both are written to the user's token ledger as `ADJUSTMENT` rows (negative for a deduction), so they show in
  the user's history and the ledger still adds up to the balance. Deductions do NOT count as "tokens spent".
- Works on USER, TESTER, STAFF, ADMIN and MANAGEMENT accounts. Super admin accounts can't be targeted.

## User activity: logins per day and time in the app (super admin only)
Every sign-in is recorded in the new `user_sessions` table (one row per visit). **Run `npm run db:sync` once** to create it.

| Endpoint | Returns |
|---|---|
| `GET /api/v1/admin/activity/daily?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Africa/Lagos` | per day: `uniqueUsers`, `logins`, `sessions` (visits), `totalMinutes`, `avgMinutesPerSession`. Default: last 14 days, gaps filled with zeros |
| `GET /api/v1/admin/activity/day?date=YYYY-MM-DD&tz=&search=&role=` | everyone active that day: `firstLoginTime`, `lastSeenTime`, `totalDuration`, `online`, and each visit (`loginTime`, `leftTime`, `duration`) |
| `GET /api/v1/admin/users/:id/activity?limit=30&tz=` | one user's recent visits, newest first |

How "time in the app" is measured:
- A visit starts at sign-in (`source: LOGIN`), or when someone who is still signed in comes back after **30 minutes idle** (`source: RETURN`).
- It keeps going while the user makes authenticated requests. Duration = last activity - login. No frontend change is required.
- For exact times, the app can call `POST /auth/logout` when the user taps Sign out (stamps the end), and `POST /auth/heartbeat` about once a minute while the app is open and visible (keeps a read-only visit alive).
  Background polling by the app also counts as activity - if the app polls while the tab is hidden, durations will run long; pause the polling or rely on heartbeat only.
- "Days" are cut at midnight in `?tz=`, else `ACTIVITY_TIMEZONE` (env, e.g. `Africa/Lagos`), else UTC.
- The super admin's own activity is not tracked. Admin/staff/tester accounts are (filter with `&role=USER`).
- Page for this: `public/admin/activity.html` (served at `/admin/activity.html`; reuses the dashboard's sign-in).
