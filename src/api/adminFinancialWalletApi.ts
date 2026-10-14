import { getJson, postJson } from './httpClient';

async function token() { return undefined; }

export async function getFinancialWalletAdminOverview() {
  return getJson<Record<string, any>>('/api/admin/financial-wallet/overview', await token());
}

export async function getNativeBscWalletStatus() {
  return getJson<Record<string, any>>('/api/admin/financial-wallet/native-bsc/status', await token());
}

export async function getNativeBscUsers() {
  return getJson<Record<string, any>>('/api/admin/financial-wallet/native-bsc/users?limit=2000', await token());
}

export async function getNativeBscTransactions() {
  return getJson<Record<string, any>>('/api/admin/financial-wallet/native-bsc/transactions?limit=300', await token());
}

export async function configureNativeBscHotWallet(privateKey: string, address: string, enabled = true, autoWithdrawalMaxAmount = 50) {
  return postJson<Record<string, any>>('/api/admin/financial-wallet/native-bsc/hot-wallet', {
    privateKey,
    address,
    enabled,
    autoWithdrawalMaxAmount,
  }, undefined, await token());
}

export async function toggleNativeBscHotWallet(enabled: boolean, autoWithdrawalMaxAmount?: number) {
  return postJson<Record<string, any>>('/api/admin/financial-wallet/native-bsc/hot-wallet/toggle', { enabled, autoWithdrawalMaxAmount }, undefined, await token());
}
