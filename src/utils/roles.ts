import { getJson } from '../api/httpClient';

export const USER_ROLES = ['member', 'support', 'admin', 'super_admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function normalizeRole(role?: string | null): UserRole {
  if (!role) return 'member';
  const normalized = role.toString().trim().toLowerCase();
  if (normalized === 'super_admin' || normalized === 'superadmin') return 'super_admin';
  if (normalized === 'admin' || normalized === 'administrator') return 'admin';
  if (normalized === 'support' || normalized === 'support_user') return 'support';
  return 'member';
}

export function isAdminRole(role?: string | null): boolean {
  const normalized = normalizeRole(role);
  return normalized === 'admin' || normalized === 'super_admin';
}

export async function resolveCurrentUserRole(): Promise<UserRole> {
  try {
    const data = await getJson<any>('/api/account/state');
    return normalizeRole(data?.wallet?.role);
  } catch {
    return 'member';
  }
}
