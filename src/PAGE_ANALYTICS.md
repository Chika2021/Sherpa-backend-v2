# Page analytics (super admin)

Shows the super admin every page each user opened, and which pages get the most traffic.

## Setup
1. Run `npm run db:sync` once - it creates the `page_views` table.
2. Add the tracker to the frontend (below).

## Frontend: report every route change
Next.js App Router - put this once in your root layout (client component), after the user is signed in:

```tsx
'use client';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

export function PageTracker() {
  const pathname = usePathname();
  useEffect(() => {
    const token = localStorage.getItem('accessToken'); // use however you store the JWT
    if (!token || !pathname) return;
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/analytics/page-view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: pathname, title: document.title }),
      keepalive: true,
    }).catch(() => {});
  }, [pathname]);
  return null;
}
```
Render `<PageTracker />` inside the layout body. Adjust the API base URL / token lookup to match your app.

## API
`POST /api/v1/analytics/page-view`  `{ "path": "/dashboard/jobs/123", "title"?: "..." }`  (any signed-in user; super admin's own visits are not recorded)

Super admin only:
| Route | What it gives |
|---|---|
| `GET /admin/analytics/pages?from=&to=&tz=&role=&limit=` | Most visited pages: views, unique users, views per user, % share, last opened. Default last 7 days. `mostVisited` is the top page. |
| `GET /admin/analytics/pages/trend?page=/dashboard/jobs/:id` | Views per day for one page |
| `GET /admin/users/:id/pages?from=&to=&tz=&search=&page=&pageSize=` | EVERY page one user opened, newest first, with date and time, plus their top 10 pages |
| `GET /admin/analytics/day?date=&tz=&search=&role=` | Everyone's pages for one day, grouped by user |

Ids in paths (uuids, numbers) are grouped as `:id`, so `/dashboard/jobs/abc` and `/dashboard/jobs/xyz` count as one page `/dashboard/jobs/:id` in the rankings; the user view still shows the exact path.

## Clearing activity to free space (super admin)
`GET /admin/activity/storage` - rows, size on disk and oldest record for page views and login visits.

`DELETE /admin/activity?confirm=DELETE` - deletes ALL recorded activity (page views and login visits). Cannot be undone.
- `&target=pages` or `&target=logins` limits it to one kind (default `all`).
- `&olderThanDays=90` keeps the last 90 days and deletes only older records.
- Visits that are still open (user online now) are kept. Disk space is handed back right away (TRUNCATE / VACUUM FULL).
The "User activity" page in the backend dashboard has a "Storage and cleanup" card that does this with a button.

## Total app storage (super admin)
`GET /admin/storage` (dashboard page: `/admin/storage.html`) returns:
- the grand total (database + files on the server) and the server disk (when the platform reports it)
- the database total, how much is your tables vs. system, and `% of limit` if `DB_STORAGE_LIMIT_MB` is set
- **space per feature** (Resumes, Applications, User activity, Payments...) with each feature's tables: size, data, indexes, rows, average row size, dead rows, last clean-up. Which table belongs to which feature is in `src/admin/storage-features.ts`; a table not listed there shows under "Other", so the total is always complete
- the uploads / generated / audio / dashboard folders
- growth over time (7 and 30 days, average per day, days until your limit) from readings taken about every 6 hours into the `storage_snapshots` table

Run `npm run db:sync` once to create `storage_snapshots` (the page works without it, just without the growth chart).
`?deep=1` also counts `node_modules` and `dist`; `?refresh=1` skips the one-minute cache.
