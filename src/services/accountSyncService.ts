import { UserWallet, TradingPosition, TransactionRecord, TradeRecord, ConnectedExchangeConfig } from '../types';
import { initialWallet, initialPositions, initialTransactions } from '../data/appData';
import { isValidMemberId, reserveMemberId } from './memberService';
import { validateFinancialAction } from '../utils/serverValidation';
import { postJson, getJson } from '../api/httpClient';
import { runtimeBotToTradingPosition, normalizeBotRuntimeState } from '../utils/botRuntimePositions';

export type AccountSyncPageCursor = any;
export type FirestorePageCursor = AccountSyncPageCursor;

export interface AccountSyncPage<T> {
  items: T[];
  cursor: AccountSyncPageCursor | null;
  hasMore: boolean;
}
export type FirestorePage<T> = AccountSyncPage<T>;

export const HISTORY_PAGE_SIZE = 50;
export const FIRESTORE_HISTORY_PAGE_SIZE = HISTORY_PAGE_SIZE;
const MAINTENANCE_PAGE_SIZE = 100;

function omitUndefinedFields<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  ) as T;
}

export async function initUserProfile(
  user: {
    uid: string;
    displayName?: string | null;
    email?: string | null;
    emailVerified?: boolean;
  },
  registrationData?: {
    sponsorId?: string;
    sponsorName?: string;
    desiredUsername?: string;
  }
) {
  if (!user || !user.uid) {
    throw new Error('Sesi belum siap untuk registrasi.');
  }

  const googleEmail = user.email || 'user@gainkoin.io';
  const googleName =
    registrationData?.desiredUsername ||
    user.displayName ||
    googleEmail.split('@')[0] ||
    'Member GAIN';

  const sponsorId = registrationData?.sponsorId || '';

  const cleanMemberId = await reserveMemberId(user.uid);

  await postJson(
    '/api/account/bootstrap',
    {
      memberId: cleanMemberId,
      username: googleName,
      sponsorId,
    },
    undefined
  );

  const localKey = `gain_wallet_${user.uid}`;

  const newWallet: UserWallet = {
    ...initialWallet,
    username: googleName,
    email: googleEmail,
    memberId: cleanMemberId,
    depositAddress: '',
    role: 'user',
    sponsorId,
    sponsorName: registrationData?.sponsorName || '',
    accountStatus: 'non-active',
    activationFeeUsdt: 150,
    liquidBalance: 0,
    availableCash: 0,
    gasReserve: 0,
    emailVerified: user.emailVerified === true,
  };

  if (typeof window !== 'undefined') {
    localStorage.setItem(localKey, JSON.stringify(newWallet));
  }

  return {
    memberId: cleanMemberId,
  };
}

export function subscribeToUserWallet(
  userId: string,
  onUpdate: (wallet: UserWallet) => void
) {
  if (!userId) return () => {};
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let depositProvisionAttempted = false;
  const fetchState = async () => {
    if (disposed) return;
    try {
      const state = await getJson<any>('/api/account/state');
      const data = state.wallet || {};
      let autoProvisionedDepositAddress = String(data.deposit_address || '').trim();
      if (!autoProvisionedDepositAddress && !depositProvisionAttempted) {
        depositProvisionAttempted = true;
        try {
          const addressResponse = await getJson<any>('/api/wallet/deposit-address');
          autoProvisionedDepositAddress = String(addressResponse?.address || '').trim();
        } catch {
          // Fail closed; the Deposit modal can retry when the provider/readiness is fixed.
        }
      }

      const connectedExchanges = Array.isArray(data.connectedExchanges)
        ? data.connectedExchanges
        : [];

      const serverActiveExchange = String(data.activeExchange || '').trim();
      const activeConfig =
        connectedExchanges.find(
          (item: any) =>
            String(item?.exchange || '').toLowerCase() === serverActiveExchange.toLowerCase()
        ) ||
        (data.connectedExchange?.exchange &&
        String(data.connectedExchange.exchange).toLowerCase() === serverActiveExchange.toLowerCase()
          ? data.connectedExchange
          : null);

      const connectedExchange = activeConfig
        ? { ...activeConfig, isActive: true, dataSource: 'EXCHANGE_API' as const }
        : null;
      const preferredExchangeName = serverActiveExchange || String(connectedExchange?.exchange || '').trim();

      const syncedAllocatedAssetUsdt = connectedExchange
        ? Number(
            (Array.isArray(connectedExchange.portfolioAssets)
              ? connectedExchange.portfolioAssets.reduce(
                  (sum: number, asset: any) => sum + Math.max(0, Number(asset?.valueUsdt || 0)),
                  0
                )
              : 0).toFixed(2)
          )
        : 0;
      const derivedAllocatedAssetUsdt =
        syncedAllocatedAssetUsdt > 0
          ? syncedAllocatedAssetUsdt
          : connectedExchange
            ? Math.max(
                0,
                Number(connectedExchange.totalPortfolioUsdt || 0) -
                  Number(connectedExchange.usdtBalance || 0)
              )
            : 0;

      const resolvedConnectedExchanges = connectedExchanges.map((item: any) => ({
        ...item,
        isActive:
          String(item?.exchange || '').toLowerCase() ===
          String(connectedExchange?.exchange || preferredExchangeName).toLowerCase(),
      }));
      if (
        connectedExchange &&
        !resolvedConnectedExchanges.some(
          (item: any) =>
            String(item?.exchange || '').toLowerCase() ===
            String(connectedExchange.exchange || '').toLowerCase()
        )
      ) {
        resolvedConnectedExchanges.unshift(connectedExchange);
      }

      onUpdate({
        ...initialWallet,
        emailVerified: true,
        liquidBalance: Number(data.available_balance ?? 0),
        availableCash: Number(data.available_balance ?? 0),
        gasReserve: Number(data.gas_reserve ?? 0),
        totalInflow: Number(data.total_inflow ?? 0),
        totalOutflow: Number(data.total_outflow ?? 0),
        nonCashGasBonus: Number(data.non_cash_gas_bonus ?? 0),
        withdrawableTradingYield: Number(data.withdrawable_trading_yield ?? 0),
        memberId: data.member_id || initialWallet.memberId,
        email: initialWallet.email,
        depositAddress: autoProvisionedDepositAddress,
        username: initialWallet.username,
        memberStatus: (data.member_status || data.status || 'active') as any,
        licenseStatus: (data.license_status || 'NONE').toString().toLowerCase() === 'active' ? 'active' : 'none',
        licenseTier: data.license_tier || undefined,
        licenseType: data.license_type || undefined,
        licenseName: data.license_name || undefined,
        maxActiveBots: data.max_active_bots ? Number(data.max_active_bots) : undefined,
        licenseExpiresAt: data.license_expires_at || null,
        accountStatus: String(data.license_status || 'NONE').toUpperCase() === 'ACTIVE' ? 'active' : 'non-active',
        twoFactorEnabled: Boolean(data.two_factor_enabled),
        connectedExchange,
        connectedExchanges: resolvedConnectedExchanges,
        activeExchange: connectedExchange?.exchange || preferredExchangeName || null,
        allocatedAssetUsdt: derivedAllocatedAssetUsdt,
      });
    } catch {
      // Keep the last UI snapshot; authoritative state remains on the server.
    }
    if (!disposed) timer = setTimeout(fetchState, 5000);
  };
  void fetchState();
  return () => { disposed = true; if (timer) clearTimeout(timer); };
}

export function subscribeToUserPositions(
  userId: string,
  exchange: string,
  onUpdate: (positions: TradingPosition[]) => void
) {
  if (!userId || userId.startsWith('usr-')) {
    return () => {};
  }
  const normalizedExchange = String(exchange || '').trim().toLowerCase();
  if (!normalizedExchange) {
    onUpdate([]);
    return () => {};
  }
  
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fetchPositions = async () => {
    if (disposed) return;
    try {
      const res = await getJson<any>('/api/bot/engine-status');
      const rawBots = (res && (res.botsList || res.bots)) || [];
      if (Array.isArray(rawBots) && (rawBots.length > 0 || res?.engineRunning)) {
        const list = rawBots.filter((b: any) => b.exchange.toLowerCase() === normalizedExchange);
        const mapped = list.map((bot: any) =>
          runtimeBotToTradingPosition(normalizeBotRuntimeState(bot))
        );
        onUpdate(mapped);
      }
    } catch (err) {
      console.warn('Failed to fetch positions', err);
    }
    if (!disposed) timer = setTimeout(fetchPositions, 5000);
  };
  void fetchPositions();
  return () => { disposed = true; if (timer) clearTimeout(timer); };
}

export function subscribeToUserTransactions(
  userId: string,
  onUpdate: (transactions: TransactionRecord[]) => void,
  onPageInfo?: (cursor: any, hasMore: boolean) => void
) {
  if (!userId || userId.startsWith('usr-')) {
    return () => {};
  }
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fetchTransactions = async () => {
    if (disposed) return;
    try {
      const res = await getJson<any>(`/api/wallet/transactions?limit=${HISTORY_PAGE_SIZE}&offset=0`);
      if (res && Array.isArray(res.transactions)) {
        const list = res.transactions.filter((data: any) => {
          return !data.id.startsWith('tx-ex-')
            && !data.id.startsWith('tx-dc-')
            && !data.title?.includes('Sinkronisasi API')
            && !data.title?.includes('Pemutusan Sambungan');
        });
        onUpdate(list);
        onPageInfo?.({ offset: HISTORY_PAGE_SIZE }, res.hasMore);
      }
    } catch (err) {
      console.warn('Failed to fetch transactions', err);
    }
    if (!disposed) timer = setTimeout(fetchTransactions, 10000);
  };
  void fetchTransactions();
  return () => { disposed = true; if (timer) clearTimeout(timer); };
}

export async function fetchOlderUserTransactions(
  userId: string,
  cursor: any,
  pageSize = HISTORY_PAGE_SIZE
): Promise<AccountSyncPage<TransactionRecord>> {
  if (!userId) {
    return { items: [], cursor: null, hasMore: false };
  }
  try {
    const offset = cursor?.offset || 0;
    const res = await getJson<any>(`/api/wallet/transactions?limit=${pageSize}&offset=${offset}`);
    
    let items = Array.isArray(res.transactions) ? res.transactions : [];
    items = items.filter((data: any) => {
      return !data.id.startsWith('tx-ex-')
        && !data.id.startsWith('tx-dc-')
        && !data.title?.includes('Sinkronisasi API')
        && !data.title?.includes('Pemutusan Sambungan');
    });

    return {
      items,
      cursor: { offset: offset + pageSize },
      hasMore: res.hasMore || false,
    };
  } catch (error) {
    console.warn('Failed to fetch older transactions', error);
    return { items: [], cursor: null, hasMore: false };
  }
}

export async function updateUserWallet(userId: string, partial: Partial<UserWallet>) {
  if (!userId) return;
  const key = `gain_wallet_${userId}`;
  if (typeof window !== 'undefined') {
    let current: Partial<UserWallet> = {};
    try { current = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
    localStorage.setItem(key, JSON.stringify({ ...current, ...partial }));
  }
  const safe: Record<string, unknown> = {};
  for (const field of ['username', 'preferences'] as const) if (field in partial) safe[field] = (partial as any)[field];
  if (Object.keys(safe).length) {
    await postJson('/api/account/profile', safe).catch(() => {});
  }
}

export async function addTransactionToFirestore(userId: string, tx: TransactionRecord) {
  if (!userId) return;
  if (typeof window !== 'undefined') {
    const key = `gain_transactions_${userId}`;
    let current: TransactionRecord[] = [];
    try { current = JSON.parse(localStorage.getItem(key) || '[]'); } catch {}
    localStorage.setItem(key, JSON.stringify([tx, ...current.filter((item) => item.id !== tx.id)].slice(0, 100)));
  }
}

export async function updatePositionInFirestore(userId: string, pos: TradingPosition) {
  // Compatibility no-op. Runtime position projections are written by the backend.
  void userId;
  void pos;
}

export async function deletePositionFromFirestore(userId: string, target: string | TradingPosition) {
  // Compatibility no-op. Positions are maintained by the backend.
  void userId;
  void target;
}

export async function saveConnectedExchangeToFirestore(userId: string, config: ConnectedExchangeConfig) {
  // Compatibility no-op: PostgreSQL is authoritative for exchange configuration.
  void userId;
  void config;
}

export async function setActiveExchangeInFirestore(userId: string, exchange: string) {
  if (!userId) return;
  const normalized = String(exchange || '').trim();
  if (!normalized) return;
  await postJson('/api/account/active-exchange', { exchange: normalized });
}

export async function disconnectSingleExchangeFromFirestore(userId: string, exchange: string) {
  // Compatibility no-op. Backend credential revocation is the source of truth.
  void userId;
  void exchange;
}

export async function disconnectExchangeFromFirestore(userId: string, exchange?: string) {
  void userId;
  void exchange;
}

export async function syncRealPortfolioAssetsToFirestore(userId: string, portfolioAssets: Array<Record<string, unknown>>, exchangeName: string, isSandbox: boolean) {
  // Compatibility no-op. Portfolio data is live exchange API state in React Query.
  void userId;
  void portfolioAssets;
  void exchangeName;
  void isSandbox;
}

export async function addTradeRecordToFirestore(userId: string, trade: TradeRecord) {
  // Trade history is authoritative from the backend PostgreSQL path.
  void userId;
  void trade;
}

// Clean aliases
export const addTransactionToStore = addTransactionToFirestore;
export const updatePositionInStore = updatePositionInFirestore;
export const deletePositionFromStore = deletePositionFromFirestore;
export const saveConnectedExchangeToStore = saveConnectedExchangeToFirestore;
export const setActiveExchangeInStore = setActiveExchangeInFirestore;
export const disconnectSingleExchangeFromStore = disconnectSingleExchangeFromFirestore;
export const disconnectExchangeFromStore = disconnectExchangeFromFirestore;
export const syncRealPortfolioAssetsToStore = syncRealPortfolioAssetsToFirestore;
export const addTradeRecordToStore = addTradeRecordToFirestore;
