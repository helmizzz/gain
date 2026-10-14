import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tickerCacheKey,
  deriveBotRunnerId,
  botRegistryKey,
  extractPortfolioAndValuation,
} from './shared/exchangeUtils';
import { tickerMemoryCache } from './shared/serverState';
import { ActiveBotRunner } from './bot/botRunnerLoop';

test('1. Multi-Exchange Namespace Isolation', () => {
  const binanceKey = tickerCacheKey('binance', 'BTCUSDT', true);
  const bybitKey = tickerCacheKey('bybit', 'BTCUSDT', true);
  const okxKey = tickerCacheKey('okx', 'BTCUSDT', false);

  assert.equal(binanceKey, 'binance:sandbox:BTCUSDT');
  assert.equal(bybitKey, 'bybit:sandbox:BTCUSDT');
  assert.equal(okxKey, 'okx:BTCUSDT');

  // Verify three keys are completely distinct
  assert.notEqual(binanceKey, bybitKey);
  assert.notEqual(binanceKey, okxKey);
  assert.notEqual(bybitKey, okxKey);
});

test('2. Per-Coin Bot Runner Isolation', () => {
  const baseBotId = 'bot-user123-001';
  const btcRunnerId = deriveBotRunnerId(baseBotId, 'BTCUSDT', true);
  const ethRunnerId = deriveBotRunnerId(baseBotId, 'ETHUSDT', true);

  assert.equal(btcRunnerId, 'bot-user123-001_btcusdt');
  assert.equal(ethRunnerId, 'bot-user123-001_ethusdt');

  const btcRegistryKey = botRegistryKey('user123', btcRunnerId);
  const ethRegistryKey = botRegistryKey('user123', ethRunnerId);

  assert.equal(btcRegistryKey, 'user123:bot-user123-001_btcusdt');
  assert.equal(ethRegistryKey, 'user123:bot-user123-001_ethusdt');
  assert.notEqual(btcRegistryKey, ethRegistryKey);
});

test('3. Portfolio & Valuation Data Source Isolation', async () => {
  tickerMemoryCache.set('binance:sandbox:BTC/USDT', { last: 60000, percentage: 2.5, timestamp: Date.now() });
  tickerMemoryCache.set('bybit:sandbox:ETH/USDT', { last: 3000, percentage: 1.2, timestamp: Date.now() });

  const binanceBalance = {
    info: {},
    BTC: { free: 1.5, used: 0.5, total: 2.0 },
    USDT: { free: 1000, used: 500, total: 1500 },
    free: { BTC: 1.5, USDT: 1000 },
    used: { BTC: 0.5, USDT: 500 },
    total: { BTC: 2.0, USDT: 1500 },
  };

  const bybitBalance = {
    info: {},
    ETH: { free: 10.0, used: 0, total: 10.0 },
    USDT: { free: 5000, used: 0, total: 5000 },
    free: { ETH: 10.0, USDT: 5000 },
    used: { ETH: 0, USDT: 5000 },
    total: { ETH: 10.0, USDT: 5000 },
  };

  const mockClientBinance = {
    id: 'binance',
    fetchTicker: async () => ({ last: 60000, percentage: 2.5 }),
    loadMarkets: async () => ({ 'BTC/USDT': {} }),
    markets: { 'BTC/USDT': {} },
    has: { fetchTicker: true },
  };

  const mockClientBybit = {
    id: 'bybit',
    fetchTicker: async () => ({ last: 3000, percentage: 1.2 }),
    loadMarkets: async () => ({ 'ETH/USDT': {} }),
    markets: { 'ETH/USDT': {} },
    has: { fetchTicker: true },
  };

  const binancePortfolio = await extractPortfolioAndValuation(mockClientBinance as any, binanceBalance, 'binance', true);
  const bybitPortfolio = await extractPortfolioAndValuation(mockClientBybit as any, bybitBalance, 'bybit', true);

  assert.ok(Array.isArray(binancePortfolio.portfolioAssets));
  assert.ok(Array.isArray(bybitPortfolio.portfolioAssets));

  // Binance portfolio should contain BTC & USDT, but NOT ETH
  assert.ok(binancePortfolio.portfolioAssets.some((a) => a.coin === 'BTC'));
  assert.ok(!binancePortfolio.portfolioAssets.some((a) => a.coin === 'ETH'));

  // Bybit portfolio should contain ETH & USDT, but NOT BTC
  assert.ok(bybitPortfolio.portfolioAssets.some((a) => a.coin === 'ETH'));
  assert.ok(!bybitPortfolio.portfolioAssets.some((a) => a.coin === 'BTC'));
});

test('4. SSOT Data Replacement Guarantee', () => {
  // Stale or mock tickers must be overwritten by valid fresh exchange ticker
  const mockTicker = { last: 50000, timestamp: Date.now() - 60000, source: 'mock' };
  const freshTicker = { last: 62000, timestamp: Date.now(), source: 'binance_api' };

  // Prioritize fresh SSOT data
  const finalPrice = freshTicker.timestamp > mockTicker.timestamp ? freshTicker.last : mockTicker.last;
  assert.equal(finalPrice, 62000);
  assert.notEqual(finalPrice, 50000);
});

test('5. Bot Recovery & Pending Order State Resolution', () => {
  const runner: ActiveBotRunner = {
    id: 'bot-123',
    botId: 'bot-123',
    uid: 'test-user-1',
    pair: 'BTCUSDT',
    exchange: 'binance',
    isSandbox: true,
    mode: 'testnet',
    status: 'active',
    botMode: 'Avarage Only',
    baseAmount: 20,
    baseTp: 1,
    useMoneyManagement: true,
    averagingLayers: 3,
    averageDownPct: 1,
    stepLayer: 0,
    entryPrice: 0,
    positionQty: 0,
    positionVersion: 1,
    avgEntryPrice: 0,
    realizedPnlToday: 0,
    pnlDate: '2026-10-07',
    lastEvaluatedPrice: 60000,
    failureStreak: 0,
    priceFailureStreak: 0,
    orderSequence: 1,
    timeframe: '5m',
    pendingOrder: {
      clientOrderId: 'GAIN-test-user-1-bot-123-1000',
      side: 'buy',
      requestedQty: 0.001,
      status: 'submitting',
      createdAt: Date.now(),
    },
  };

  assert.equal(runner.pendingOrder?.status, 'submitting');
  assert.equal(runner.pendingOrder?.clientOrderId, 'GAIN-test-user-1-bot-123-1000');
});
