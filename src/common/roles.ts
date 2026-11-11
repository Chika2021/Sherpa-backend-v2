/**
 * Account roles.
 *   SUPER_ADMIN  full control, including App info and every account except other super admins. Only ever
 *                created from the SUPER_ADMIN_* environment variables (see AdminBootstrapService).
 *   MANAGEMENT   created by the super admin. Can create, update and delete USER, TESTER and STAFF accounts
 *                (never admins, management or super admins) and can see payments. No App info, no helpdesk.
 *   ADMIN        read-only dashboard: overview (without revenue), users and helpdesk. Cannot change anything.
 *   STAFF        sees the countdown (total user count) and nothing else.
 *   TESTER       no dashboard access. Uses the /tester/* API from the separate frontend tester UI.
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
