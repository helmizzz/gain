import { postJson, getJson } from './httpClient';

async function token() { return undefined; }

export async function processWalletActivation(payload: Record<string, unknown>) {
  const key = String(payload.idempotencyKey || `activation-${crypto.randomUUID()}`);
  const body = { ...payload, idempotencyKey: key };
  return postJson<Record<string, any>>('/api/wallet/process-activation', body, undefined, await token(), { 'Idempotency-Key': key });
}
export async function verifyOnChainDeposit(payload: Record<string, unknown>) {
  return postJson<Record<string, any>>('/api/wallet/verify-deposit', payload, undefined, await token());
}
export async function submitWithdrawal(payload: Record<string, unknown>) {
  const key = String(payload.idempotencyKey || '');
  return postJson<Record<string, any>>('/api/wallet/submit-withdraw', payload, undefined, await token(), key ? { 'Idempotency-Key': key } : undefined);
}
export async function getWithdrawalAddresses() {
  return getJson<Record<string, any>>('/api/wallet/withdrawal-addresses', await token());
}
export async function getWithdrawalPolicy() {
  return getJson<Record<string, any>>('/api/wallet/withdrawal-policy', await token());
}
export async function getDepositAddress() {
  return getJson<Record<string, any>>('/api/wallet/deposit-address', await token());
}
export async function getDepositPolicy() {
  return getJson<Record<string, any>>('/api/wallet/deposit-policy', await token());
}
export async function enrollWithdrawalAddress(payload: Record<string, unknown>) {
  return postJson<Record<string, any>>('/api/wallet/withdrawal-addresses', payload, undefined, await token());
}
export async function topUpGas(payload: Record<string, unknown>) {
  const key = String(payload.idempotencyKey || `gas-${Date.now()}-${Math.random().toString(36).slice(2,10)}`);
  return postJson<Record<string, any>>('/api/wallet/topup-gas', { ...payload, idempotencyKey: key }, undefined, await token(), { 'Idempotency-Key': key });
}
export async function transferToMember(payload: Record<string, unknown>) {
  const key = String(payload.idempotencyKey || '');
  return postJson<Record<string, any>>('/api/member/transfer', payload, undefined, await token(), key ? { 'Idempotency-Key': key } : undefined);
}
export async function getProfitShare() {
  return getJson<Record<string, any>>('/api/wallet/profit-share', await token());
}
export async function getGasAutoRefill() {
  return getJson<Record<string, any>>('/api/wallet/auto-refill', await token());
}
export async function setGasAutoRefill(payload: { enabled: boolean; thresholdUsdt: number; refillUsdt: number; maxDailyUsdt: number }) {
  return postJson<Record<string, any>>('/api/wallet/auto-refill', payload, undefined, await token());
}

export async function getUserTransactions(params?: { limit?: number; offset?: number }) {
  const query = params ? `?limit=${params.limit || 50}&offset=${params.offset || 0}` : '';
  return getJson<Record<string, any>>(`/api/wallet/transactions${query}`, await token());
}

