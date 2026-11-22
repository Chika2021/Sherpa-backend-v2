/**
 * Thresholds for the suspicious-activity rules (see monitoring.service.ts). All in one place so you can tune
 * them without touching logic. A rule only RAISES A FLAG for an admin to review - except the referral blocks,
 * which live in src/tokens/token-pricing.config.ts and in ReferralsService.
 */
export const MONITORING = {
  /** Several accounts created from the same network (IP) in a short time. */
  sameIpSignups: { windowHours: 24, threshold: 3, highAt: 6 },
  /** The same browser/device used for several accounts (flagged when it reaches `threshold` OTHER accounts). */
  sameDeviceAccounts: { threshold: 2, highAt: 4 },
  /** Many wrong-password attempts against one account. */
  failedLogins: { windowMinutes: 15, threshold: 8 },
  /** An unusually fast burst of AI generations (one token each), which looks like a script, not a person. */
  rapidUsage: { windowMinutes: 10, threshold: 40 },
  /** Several failed payment attempts in a row (card testing). */
  failedPayments: { windowMinutes: 60, threshold: 4 },
  /** One referrer bringing in many friends very quickly. */
  referralVelocity: { hourlyThreshold: 5, dailyThreshold: 10 },
  /** Several friends of the same referrer who signed up from the same IP (MEDIUM) / the same device (HIGH). */
  referralRing: { sameIpFriends: 3, sameDeviceFriends: 2, windowHours: 24 },
  /** How often the background sweep looks for patterns that no single request shows. */
  sweepEveryMinutes: 15,
  /** Email the admins about flags of this severity and above (LOW ones only appear in the dashboard and bell). */
  emailFromSeverity: 'MEDIUM' as 'LOW' | 'MEDIUM' | 'HIGH',
} as const;

export const SEVERITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;
