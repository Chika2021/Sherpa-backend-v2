/**
 * The super admin is a BACKEND-ONLY account. It is operated from the dashboard served by this backend
 * (https://<api-host>/admin) or by calling the API directly (curl, Postman, a server script) - never from
 * the customer-facing frontend app.
 *
 * How it is enforced: a browser always attaches an `Origin` header to a cross-origin request, and page
 * JavaScript cannot remove or forge it. So a request is treated as "from the backend" when
 *   - it has no Origin header (curl, Postman, server-to-server, plain navigations), or
 *   - its Origin is this backend itself (the Origin's host equals the request's Host header - a browser
 *     page cannot set Host), or
 *   - SUPER_ADMIN_ALLOWED_ORIGINS is set and the Origin is in that list. When that variable IS set it
 *     replaces the host check, so ONLY those origins are accepted. Use it if the frontend and the backend
 *     share one domain, or if your /admin page is served from a different host.
 *       SUPER_ADMIN_ALLOWED_ORIGINS=https://api.example.com,http://localhost:3000
 *
 * Anything else (the frontend's origin, `Origin: null`) is refused. A super admin token typed into the
 * frontend therefore gets 401 on every route, and the super admin cannot sign in from it either.
 */
type HeaderBag = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const normalizeOrigin = (o: string) => o.trim().replace(/\/+$/, '').toLowerCase();

export function isBackendRequest(req: { headers: HeaderBag } | undefined, allowedOriginsCsv?: string): boolean {
  const origin = first(req?.headers?.origin);
  if (!origin) return true;

  const allowed = (allowedOriginsCsv ?? '').split(',').map(normalizeOrigin).filter(Boolean);
  if (allowed.length) return allowed.includes(normalizeOrigin(origin));

  try {
    return new URL(origin).host.toLowerCase() === (first(req?.headers?.host) ?? '').toLowerCase();
  } catch {
    return false; // "null" or garbage
  }
}

export const SUPER_ADMIN_BACKEND_ONLY_MESSAGE = 'The super admin can only be used from the backend, not from the frontend app.';
