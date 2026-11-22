/**
 * Account roles.
 *   SUPER_ADMIN  full control, including App info and every account except other super admins. Only ever
 *                created from the SUPER_ADMIN_* environment variables (see AdminBootstrapService).
 *   MANAGEMENT   created by the super admin. Can create, update and delete USER, TESTER and STAFF accounts
 *                (never admins, management or super admins) and can see payments. No App info, no helpdesk.
 *   ADMIN        dashboard: overview (without revenue), users and helpdesk are read-only. Can also create, read,
 *                update and delete local job boards (the job links kept per country).
 *   STAFF        sees the countdown (total user count) and nothing else.
 *   TESTER       own tester dashboard (/dashboard/tester/*) plus the /tester/* API. Sees nothing about other users.
 *   USER         a normal customer account.
 */
export const ROLES = ['USER', 'TESTER', 'STAFF', 'ADMIN', 'MANAGEMENT', 'SUPER_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that exist as assignable values. SUPER_ADMIN is deliberately not in this list. */
export const ASSIGNABLE_ROLES = ['USER', 'TESTER', 'STAFF', 'ADMIN', 'MANAGEMENT'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * Which account roles each actor may create, edit, suspend and delete.
 * Loosen MANAGEMENT here (e.g. add 'ADMIN') if you want management to manage admins too.
 */
export const MANAGEABLE_BY: Record<'SUPER_ADMIN' | 'MANAGEMENT', readonly Role[]> = {
  SUPER_ADMIN: ['USER', 'TESTER', 'STAFF', 'ADMIN', 'MANAGEMENT'],
  MANAGEMENT: ['USER', 'TESTER', 'STAFF'],
};

export const manageableRoles = (actorRole: string): readonly Role[] =>
  (MANAGEABLE_BY as Record<string, readonly Role[]>)[actorRole] ?? [];

// ---------------------------------------------------------------------------------------------------------
// Dashboard access. Every role except USER can sign in to the frontend dashboard, and each one lands on
// its OWN dashboard. The backend tells the frontend where to send them (see `dashboardFor`), so the
// redirect rule lives in one place. Change a path here if your frontend routes are named differently.
// ---------------------------------------------------------------------------------------------------------

/** Roles that may sign in to the dashboard (POST /auth/admin-login). Everyone except USER. */
export const DASHBOARD_ROLES = ['TESTER', 'STAFF', 'ADMIN', 'MANAGEMENT', 'SUPER_ADMIN'] as const;
export type DashboardRole = (typeof DASHBOARD_ROLES)[number];

export interface DashboardInfo {
  /** Stable key for the frontend: 'tester' | 'staff' | 'admin' | 'management' | 'super-admin'. */
  key: string;
  /** Frontend route to redirect to right after login. */
  path: string;
  /** Human label for the page title / sidebar header. */
  label: string;
  /** What this role can do. Show or hide navigation items with these; the API enforces the same rules. */
  permissions: readonly string[];
}

export const DASHBOARDS: Record<DashboardRole, DashboardInfo> = {
  SUPER_ADMIN: {
    key: 'super-admin',
    // Served by THIS backend (public/admin), not by the frontend app. The super admin is backend-only:
    // see common/super-admin-access.ts.
    path: '/admin',
    label: 'Super Admin',
    permissions: ['overview', 'signups', 'live-stream', 'users.read', 'users.write', 'tokens.grant', 'tokens.deduct', 'activity.view', 'payments', 'helpdesk.read', 'helpdesk.reply', 'flags.read', 'flags.review', 'system', 'local-job-boards', 'countdown', 'tester'],
  },
  ADMIN: {
    key: 'admin',
    path: '/dashboard/admin',
    label: 'Admin',
    permissions: ['overview', 'signups', 'live-stream', 'users.read', 'helpdesk.read', 'flags.read', 'flags.review', 'local-job-boards', 'countdown'],
  },
  MANAGEMENT: {
    key: 'management',
    path: '/dashboard/management',
    label: 'Management',
    permissions: ['overview', 'signups', 'live-stream', 'users.read', 'users.write', 'payments', 'countdown'],
  },
  STAFF: {
    key: 'staff',
    path: '/dashboard/staff',
    label: 'Staff',
    permissions: ['countdown'],
  },
  TESTER: {
    key: 'tester',
    path: '/dashboard/tester',
    label: 'Tester',
    permissions: ['tester.overview', 'tester.bug-reports'],
  },
};

export const isDashboardRole = (role: unknown): role is DashboardRole =>
  typeof role === 'string' && (DASHBOARD_ROLES as readonly string[]).includes(role);

/** The dashboard a role belongs to, or null for a normal USER account. */
export const dashboardFor = (role: unknown): DashboardInfo | null => (isDashboardRole(role) ? DASHBOARDS[role] : null);
