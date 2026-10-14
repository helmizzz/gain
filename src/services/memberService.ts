import { postJson, getJson } from '../api/httpClient';
import { NetworkMember } from '../types';

export interface DirectoryMember {
  memberId: string;
  userId: string;
  username: string;
  accountStatus: 'active' | 'non-active';
  memberStatus?: 'active' | 'suspended' | 'closed';
  licenseStatus?: 'none' | 'active' | 'suspended' | 'expired';
  vipTier?: string;
  emailMasked: string;
  sponsorId?: string;
  sponsorName?: string;
  joinedAt: string;
  role?: string;
}

export function isValidMemberId(value: unknown): value is string {
  return typeof value === 'string' && /^GN-\d{5}$/.test(value);
}

/** Reserve a permanent sequential ID. The counter transaction serializes concurrent registrations. */
export async function reserveMemberId(userId: string): Promise<string> {
  const result = await postJson<{ success: true; memberId: string }>('/api/account/reserve-member-id', {});
  return result.memberId;
}

/**
 * Look up member in directory by Member ID (e.g. "GN-00001").
 */
export async function lookupMemberInDirectory(
  memberIdInput: string
): Promise<DirectoryMember | null> {
  const cleanId = memberIdInput.trim().toUpperCase();
  if (!cleanId) return null;

  try {
    const result = await getJson<{ success: boolean; member: DirectoryMember }>(`/api/account/lookup-member/${encodeURIComponent(cleanId)}`);
    return result.member || null;
  } catch {
    // Return null if not found or API not implemented yet
    return null;
  }
}

export async function fetchDirectReferrals(): Promise<NetworkMember[]> {
  try {
    const result = await getJson<{ success:boolean; members:Array<any> }>('/api/referrals/direct');
    return result.members.map((m) => ({
      id: String(m.memberId),
      memberId: String(m.memberId),
      name: String(m.username || 'Member'),
      emailMasked: '',
      sponsorId: '',
      joinDate: String(m.joinedAt || ''),
      accountStatus: m.accountStatus === 'active' ? 'active' : 'non-active',
      ...(m.memberStatus ? { memberStatus: m.memberStatus } : {}),
      ...(m.licenseStatus ? { licenseStatus: m.licenseStatus } : {}),
      ...(typeof m.bonusYieldUsdt === 'number' ? { bonusYieldUsdt: m.bonusYieldUsdt } : {}),
    }));
  } catch {
    return [];
  }
}

/** Subscribe to real direct referrals from the authoritative PostgreSQL API. */
export function subscribeToDirectReferrals(userId: string | undefined, _userMemberId: string, onUpdate: (members: NetworkMember[]) => void, onError: () => void): () => void {
  if (!userId || userId.startsWith('gain-usr-')) { onUpdate([]); return () => {}; }
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fetch = async () => {
    if (disposed) return;
    try { onUpdate(await fetchDirectReferrals()); }
    catch { onError(); }
    if (!disposed) timer = setTimeout(fetch, 10000);
  };
  void fetch();
  return () => { disposed = true; if (timer) clearTimeout(timer); };
}

export function subscribeToMemberDirectory(
  onUpdate: (members: DirectoryMember[]) => void,
  onError: () => void,
): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fetch = async () => {
    if (disposed) return;
    try { 
      const res = await getJson<{ success: boolean, members: DirectoryMember[] }>('/api/account/directory');
      if (res.success && res.members) onUpdate(res.members);
    }
    catch { onError(); }
    if (!disposed) timer = setTimeout(fetch, 10000);
  };
  void fetch();
  return () => { disposed = true; if (timer) clearTimeout(timer); };
}
