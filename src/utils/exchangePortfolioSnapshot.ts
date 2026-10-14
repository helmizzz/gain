import type { ConnectedExchangeConfig, ExchangeName, UserWallet } from '../types';

export interface PortfolioSnapshotCandidate {
  exchange: ExchangeName;
  isSandbox: boolean;
  usdtBalance: number;
  usdtAvailable: number;
  usdtTotalBalance: number;
  totalPortfolioUsdt: number;
  rawAssetCount: number;
  unvaluedDefaultAssetCount: number;
  valuationScope?: ConnectedExchangeConfig['valuationScope'];
  portfolioAssets: NonNullable<ConnectedExchangeConfig['portfolioAssets']>;
  portfolioAsOf: number;
}

export interface SnapshotGateState {
  latestRequestSeq: number;
  lastAcceptedRequestSeq: number;
  lastAcceptedAsOf: number;
  lastAcceptedAt: number;
  consecutiveEmptySnapshots: number;
}

export interface SnapshotDecision {
  accept: boolean;
  reason: string;
  nextState: SnapshotGateState;
}

export const EMPTY_SNAPSHOT_GRACE_MS = 120_000;

export function snapshotKey(exchange: ExchangeName, isSandbox: boolean): string {
  return `${String(exchange).toUpperCase()}:${isSandbox ? 'TESTNET' : 'LIVE'}`;
}

export function hasMeaningfulPortfolio(config?: Pick<ConnectedExchangeConfig, 'usdtTotalBalance' | 'totalPortfolioUsdt' | 'portfolioAssets'> | null): boolean {
  if (!config) return false;
  return (
    Number(config.usdtTotalBalance || 0) > 0 ||
    Number(config.totalPortfolioUsdt || 0) > 0 ||
    (Array.isArray(config.portfolioAssets) && config.portfolioAssets.some((asset) => Number(asset?.total || 0) > 0))
  );
}

export function isEmptyPortfolioSnapshot(candidate: PortfolioSnapshotCandidate): boolean {
  return (
    Number(candidate.usdtTotalBalance || 0) <= 0 &&
    Number(candidate.usdtAvailable || 0) <= 0 &&
    Number(candidate.totalPortfolioUsdt || 0) <= 0 &&
    Number(candidate.rawAssetCount || 0) <= 0 &&
    (!Array.isArray(candidate.portfolioAssets) || candidate.portfolioAssets.every((asset) => Number(asset?.total || 0) <= 0))
  );
}

export function createSnapshotGateState(): SnapshotGateState {
  return {
    latestRequestSeq: 0,
    lastAcceptedRequestSeq: 0,
    lastAcceptedAsOf: 0,
    lastAcceptedAt: 0,
    consecutiveEmptySnapshots: 0,
  };
}

export function nextRequestSequence(state: SnapshotGateState): { requestSeq: number; nextState: SnapshotGateState } {
  const requestSeq = state.latestRequestSeq + 1;
  return { requestSeq, nextState: { ...state, latestRequestSeq: requestSeq } };
}

export function decidePortfolioSnapshot(
  state: SnapshotGateState,
  candidate: PortfolioSnapshotCandidate,
  requestSeq: number,
  previousConfig?: ConnectedExchangeConfig | null,
  now = Date.now(),
): SnapshotDecision {
  const empty = isEmptyPortfolioSnapshot(candidate);
  const nextState = { ...state, latestRequestSeq: Math.max(state.latestRequestSeq, requestSeq) };

  if (requestSeq < state.latestRequestSeq) {
    return { accept: false, reason: 'STALE_REQUEST_SEQUENCE', nextState };
  }

  if (candidate.portfolioAsOf > 0 && state.lastAcceptedAsOf > 0 && candidate.portfolioAsOf < state.lastAcceptedAsOf) {
    return { accept: false, reason: 'STALE_PORTFOLIO_ASOF', nextState };
  }

  if (!empty) {
    return {
      accept: true,
      reason: 'VALID_NON_EMPTY_SNAPSHOT',
      nextState: {
        ...nextState,
        lastAcceptedRequestSeq: requestSeq,
        lastAcceptedAsOf: Math.max(candidate.portfolioAsOf, state.lastAcceptedAsOf),
        lastAcceptedAt: now,
        consecutiveEmptySnapshots: 0,
      },
    };
  }

  const previousIsMeaningful = hasMeaningfulPortfolio(previousConfig);
  const withinGrace = state.lastAcceptedAt > 0 && now - state.lastAcceptedAt < EMPTY_SNAPSHOT_GRACE_MS;
  const nextEmptyCount = state.consecutiveEmptySnapshots + 1;

  if (previousIsMeaningful && (withinGrace || nextEmptyCount < 3)) {
    return {
      accept: false,
      reason: withinGrace ? 'TRANSIENT_EMPTY_WITHIN_GRACE' : 'TRANSIENT_EMPTY_CONFIRMATION_REQUIRED',
      nextState: {
        ...nextState,
        consecutiveEmptySnapshots: nextEmptyCount,
      },
    };
  }

  return {
    accept: true,
    reason: 'CONFIRMED_EMPTY_SNAPSHOT',
    nextState: {
      ...nextState,
      lastAcceptedRequestSeq: requestSeq,
      lastAcceptedAsOf: Math.max(candidate.portfolioAsOf, state.lastAcceptedAsOf),
      lastAcceptedAt: now,
      consecutiveEmptySnapshots: 0,
    },
  };
}

const LIVE_FIELDS: Array<keyof ConnectedExchangeConfig> = [
  'usdtBalance',
  'usdtAvailable',
  'usdtTotalBalance',
  'totalPortfolioUsdt',
  'rawAssetCount',
  'unvaluedDefaultAssetCount',
  'valuationScope',
  'portfolioAssets',
  'portfolioAsOf',
  'portfolioSyncStatus',
  'lastSyncError',
  'lastSynced',
  'dataSource',
];

export function mergeServerWalletMetadataPreservingLiveExchange(previous: UserWallet | undefined, serverWallet: UserWallet): UserWallet {
  if (!previous) return serverWallet;

  const previousByExchange = new Map((previous.connectedExchanges || []).map((item) => [String(item.exchange).toLowerCase(), item]));
  const isServerPortfolioAuthoritative = (item?: ConnectedExchangeConfig | null) => Boolean(
    item?.portfolioAsOf &&
    item.portfolioSyncStatus &&
    item.portfolioSyncStatus !== 'SYNCING'
  );

  const mergeConfig = (serverConfig: ConnectedExchangeConfig | null | undefined): ConnectedExchangeConfig | undefined => {
    if (!serverConfig) return undefined;
    const prior = previousByExchange.get(String(serverConfig.exchange).toLowerCase())
      || (String(previous.connectedExchange?.exchange || '').toLowerCase() === String(serverConfig.exchange).toLowerCase() ? previous.connectedExchange : undefined);
    if (!prior || isServerPortfolioAuthoritative(serverConfig)) return serverConfig;
    const preserved: Partial<ConnectedExchangeConfig> = {};
    for (const field of LIVE_FIELDS) {
      const value = prior[field];
      if (value !== undefined) (preserved as any)[field] = value;
    }
    return { ...serverConfig, ...preserved };
  };

  const connectedExchanges = (serverWallet.connectedExchanges || []).map((item) => mergeConfig(item) || item);
  const connectedExchange = mergeConfig(serverWallet.connectedExchange) || serverWallet.connectedExchange;
  const activeExchange = serverWallet.activeExchange || connectedExchange?.exchange || previous.activeExchange;

  return {
    ...serverWallet,
    connectedExchange,
    connectedExchanges,
    activeExchange,
    allocatedAssetUsdt: connectedExchange?.totalPortfolioUsdt && connectedExchange?.usdtTotalBalance !== undefined
      ? Math.max(0, Number(connectedExchange.totalPortfolioUsdt) - Number(connectedExchange.usdtTotalBalance))
      : previous.allocatedAssetUsdt,
  };
}
