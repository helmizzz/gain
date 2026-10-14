import { getJson, postJson, patchJson, deleteJson } from './httpClient';

async function getToken() {
    return undefined;}

export interface Voucher {
  id: string;
  code: string;
  discountType: 'PERCENTAGE' | 'FIXED';
  discountValue: number;
  maxUses: number | null;
  usedCount: number;
  applicableTier: 'all' | 'starter_6' | 'pro_12';
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVoucherPayload {
  code: string;
  discountType: 'PERCENTAGE' | 'FIXED';
  discountValue: number;
  maxUses?: number | null;
  applicableTier?: 'all' | 'starter_6' | 'pro_12';
  expiresAt?: string | null;
}

export interface ValidateVoucherResult {
  success: boolean;
  valid: boolean;
  voucher: {
    id: string;
    code: string;
    discountType: 'PERCENTAGE' | 'FIXED';
    discountValue: number;
    discountAmount: number;
    originalFee: number;
    finalFee: number;
  };
  message?: string;
}

export async function getAdminVouchers(): Promise<{ success: boolean; vouchers: Voucher[] }> {
  const token = await getToken();
  return getJson<{ success: boolean; vouchers: Voucher[] }>('/api/admin/vouchers', token);
}

export async function createAdminVoucher(payload: CreateVoucherPayload): Promise<{ success: boolean; voucher: Voucher }> {
  const token = await getToken();
  return postJson<{ success: boolean; voucher: Voucher }>('/api/admin/vouchers', payload, undefined, token);
}

export async function toggleAdminVoucherStatus(id: string, isActive: boolean): Promise<{ success: boolean; voucher: Voucher }> {
  const token = await getToken();
  return patchJson<{ success: boolean; voucher: Voucher }>(`/api/admin/vouchers/${id}/status`, { isActive }, token);
}

export async function deleteAdminVoucher(id: string): Promise<{ success: boolean }> {
  const token = await getToken();
  return deleteJson<{ success: boolean }>(`/api/admin/vouchers/${id}`, token);
}

export async function validateVoucher(code: string, tier: 'starter_6' | 'pro_12'): Promise<ValidateVoucherResult> {
  const token = await getToken();
  return postJson<ValidateVoucherResult>('/api/wallet/validate-voucher', { code, tier }, undefined, token);
}
