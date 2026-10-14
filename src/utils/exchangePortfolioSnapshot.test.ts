import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotGateState, decidePortfolioSnapshot, isEmptyPortfolioSnapshot, mergeServerWalletMetadataPreservingLiveExchange, snapshotKey } from './exchangePortfolioSnapshot';
import { initialWallet } from '../data/appData';

const base = {
  exchange: 'Binance' as const,
  isSandbox: true,
  isConnected: true,
  apiKeyMasked: 'API_CONNECTED',
  lastSynced: 'now',
  usdtBalance: 1000,
  usdtAvailable: 900,
  usdtTotalBalance: 1000,
  totalPortfolioUsdt: 1200,
  rawAssetCount: 2,
  unvaluedDefaultAssetCount: 0,
  valuationScope: 'DEFAULT_12_COINS' as const,
  portfolioAssets: [{ coin: 'BTC', pair: 'BTC/USDT', free: 0.01, used: 0, total: 0.01, price: 20000, change24h: 0, valueUsdt: 200, valuationStatus: 'VALUED' as const }],
  portfolioAsOf: 100,
};

test('snapshot key separates sandbox and live contexts', () => {
  assert.notEqual(snapshotKey('Binance', true), snapshotKey('Binance', false));
});

test('empty transient snapshot does not overwrite a recent meaningful balance', () => {
  const state = createSnapshotGateState();
  const first = decidePortfolioSnapshot(state, base, 1, undefined, 1000);
  assert.equal(first.accept, true);
  const empty = { ...base, usdtBalance: 0, usdtAvailable: 0, usdtTotalBalance: 0, totalPortfolioUsdt: 0, rawAssetCount: 0, portfolioAssets: [], portfolioAsOf: 120 };
  const second = decidePortfolioSnapshot(first.nextState, empty, 2, base, 2000);
  assert.equal(second.accept, false);
  assert.equal(second.reason, 'TRANSIENT_EMPTY_WITHIN_GRACE');
});

test('repeated empty snapshots stay protected during the grace window', () => {
  const empty = { ...base, usdtBalance: 0, usdtAvailable: 0, usdtTotalBalance: 0, totalPortfolioUsdt: 0, rawAssetCount: 0, portfolioAssets: [], portfolioAsOf: 200 };
  let state = createSnapshotGateState();
  const first = decidePortfolioSnapshot(state, base, 1, undefined, 1000);
  state = first.nextState;
  const e1 = decidePortfolioSnapshot(state, empty, 2, base, 2000);
  state = e1.nextState;
  const e2 = decidePortfolioSnapshot(state, empty, 3, base, 3000);
  assert.equal(e1.accept, false);
  assert.equal(e2.accept, false);
});

test('older request cannot overwrite a newer snapshot', () => {
  const state = { ...createSnapshotGateState(), latestRequestSeq: 3, lastAcceptedRequestSeq: 3, lastAcceptedAsOf: 300, lastAcceptedAt: 3000 };
  const result = decidePortfolioSnapshot(state, { ...base, portfolioAsOf: 250 }, 2, base, 4000);
  assert.equal(result.accept, false);
  assert.equal(result.reason, 'STALE_REQUEST_SEQUENCE');
});

test('server metadata refresh preserves live portfolio snapshot', () => {
  const previous = {
    ...initialWallet,
    activeExchange: 'Binance' as const,
    connectedExchange: {
      exchange: 'Binance' as const, isConnected: true, isSandbox: true, apiKeyMasked: 'API_CONNECTED',
      usdtBalance: 1000, usdtAvailable: 900, usdtTotalBalance: 1000, totalPortfolioUsdt: 1200,
      portfolioAssets: base.portfolioAssets, portfolioAsOf: 100, portfolioSyncStatus: 'LIVE' as const, dataSource: 'EXCHANGE_API' as const, lastSynced: 'now',
    },
    connectedExchanges: [],
  };
  const serverWallet = {
    ...previous,
    connectedExchange: { ...previous.connectedExchange, usdtBalance: 0, usdtAvailable: 0, usdtTotalBalance: 0, totalPortfolioUsdt: undefined, portfolioAssets: [], portfolioAsOf: undefined, portfolioSyncStatus: 'SYNCING' as const },
    connectedExchanges: [{ ...previous.connectedExchange, usdtBalance: 0, usdtAvailable: 0, usdtTotalBalance: 0, totalPortfolioUsdt: undefined, portfolioAssets: [], portfolioAsOf: undefined, portfolioSyncStatus: 'SYNCING' as const }],
  } as any;
  const merged = mergeServerWalletMetadataPreservingLiveExchange(previous, serverWallet);
  assert.equal(merged.connectedExchange?.usdtTotalBalance, 1000);
  assert.equal(merged.connectedExchange?.totalPortfolioUsdt, 1200);
  assert.equal(merged.connectedExchange?.portfolioAssets?.length, 1);
});

test('empty snapshot helper recognizes zero-valued portfolio', () => {
  assert.equal(isEmptyPortfolioSnapshot({ ...base, usdtBalance: 0, usdtAvailable: 0, usdtTotalBalance: 0, totalPortfolioUsdt: 0, rawAssetCount: 0, portfolioAssets: [] }), true);
});
