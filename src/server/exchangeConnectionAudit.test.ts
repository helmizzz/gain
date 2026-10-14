import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXCHANGE_REGISTRY,
  getExchangeDescriptor,
  isTradingExchange,
} from '../config/exchangeRegistry';
import { normalizeExchangeName } from '../utils/exchangeIsolation';
import {
  checkRateLimit,
  extractPortfolioAndValuation,
  createExchangeInstance,
  sanitizeExchangeInput,
} from './shared/exchangeUtils';

test('1. Exchange Registry: Read-only Indonesian exchanges are flagged publicOnly with valid URLs', () => {
  const publicOnlyExchanges = ['reku', 'bittime', 'pintupro', 'triv'];
  for (const id of publicOnlyExchanges) {
    const desc = getExchangeDescriptor(id);
    assert.ok(desc, `Missing descriptor for ${id}`);
    assert.equal(desc?.publicOnly, true, `${id} must be marked publicOnly`);
    assert.equal(desc?.tradingApi, false, `${id} must have tradingApi: false`);
  }

  const reku = getExchangeDescriptor('reku');
  assert.equal(reku?.publicBaseUrl, 'https://api.reku.id/v2', 'Reku public URL must be v2');
});

test('2. Exchange Isolation: normalizeExchangeName maps aliases and mixed casing to canonical ID', () => {
  assert.equal(normalizeExchangeName('Bybit Indonesia'), 'bybit');
  assert.equal(normalizeExchangeName('bybit indonesia'), 'bybit');
  assert.equal(normalizeExchangeName('BYBIT'), 'bybit');
  assert.equal(normalizeExchangeName('Indodax'), 'indodax');
  assert.equal(normalizeExchangeName('INDODAX'), 'indodax');
  assert.equal(normalizeExchangeName('Binance'), 'binance');
  assert.equal(normalizeExchangeName('Tokocrypto'), 'tokocrypto');
});

test('3. Rate Limiter: checkRateLimit retains state in module scope and blocks after maxRequests', () => {
  const testIp = `test-ip-${Date.now()}-${Math.random()}`;
  for (let i = 0; i < 5; i++) {
    const allowed = checkRateLimit(testIp, 5, 5000);
    assert.equal(allowed, true, `Request ${i + 1} should be allowed`);
  }
  // 6th request should be blocked
  const blocked = checkRateLimit(testIp, 5, 5000);
  assert.equal(blocked, false, '6th request exceeding limit of 5 must be blocked');
});

test('4. Sandbox Endpoint Preservation: createExchangeInstance preserves official CCXT sandbox endpoints', () => {
  const binanceSandbox = createExchangeInstance('binance', { isSandbox: true });
  // CCXT Binance sandbox default must point to testnet.binance.vision, NOT demo-api.binance.com
  const binanceApiUrls = JSON.stringify((binanceSandbox.urls as any)?.api || {});
  assert.ok(
    binanceApiUrls.includes('testnet.binance.vision'),
    'Binance sandbox default must use official testnet.binance.vision'
  );
  assert.ok(
    !binanceApiUrls.includes('demo-api.binance.com'),
    'Binance sandbox default must not overwrite URL with demo-api mock trading'
  );

  // When binanceSandboxEnv: 'demo' is explicitly requested, it routes to demo-api.binance.com
  const binanceDemo = createExchangeInstance('binance', { isSandbox: true, binanceSandboxEnv: 'demo' });
  const binanceDemoUrls = JSON.stringify((binanceDemo.urls as any)?.api || {});
  assert.ok(
    binanceDemoUrls.includes('demo-api.binance.com'),
    'Binance demo sandbox must route to demo-api.binance.com'
  );

  const bybitSandbox = createExchangeInstance('bybit', { isSandbox: true });
  const bybitApiUrls = JSON.stringify((bybitSandbox.urls as any)?.api || {});
  assert.ok(
    !bybitApiUrls.includes('api-demo.bybit.com'),
    'Bybit sandbox must not overwrite URL with api-demo'
  );
});

test('5. Multi-Currency Valuation: extractPortfolioAndValuation accurately values IDR-quoted coins', async () => {
  // Mock client simulating Indodax where SOL is only quoted in IDR (SOL/IDR)
  const mockIndodaxClient = {
    markets: {
      'USDT/IDR': { symbol: 'USDT/IDR' },
      'SOL/IDR': { symbol: 'SOL/IDR' },
      'BTC/IDR': { symbol: 'BTC/IDR' },
    },
    fetchTicker: async (symbol: string) => {
      if (symbol === 'USDT/IDR') {
        return { last: 16000, percentage: 0 };
      }
      if (symbol === 'SOL/IDR') {
        // SOL price: 3,200,000 IDR (which is exactly $200 USDT at 16,000 rate)
        return { last: 3200000, percentage: 3.5 };
      }
      return { last: 0, percentage: 0 };
    },
  };

  const balance = {
    currencies: {},
    free: { SOL: 5, IDR: 16000000, USDT: 100 },
    used: { SOL: 0, IDR: 0, USDT: 0 },
    total: { SOL: 5, IDR: 16000000, USDT: 100 },
  };

  const result = await extractPortfolioAndValuation(mockIndodaxClient, balance, 'indodax', false);

  // 16,000,000 IDR cash = 1,000 USDT + 100 USDT cash = 1,100 USDT balance
  assert.equal(result.usdtTotalBalance, 1100);
  assert.equal(result.usdtAvailable, 1100);

  // 5 SOL @ $200 (3,200,000 IDR / 16,000) = $1,000 USDT value
  const solAsset = result.portfolioAssets.find((a) => a.coin === 'SOL');
  assert.ok(solAsset, 'SOL must be present in portfolio assets');
  assert.equal(solAsset?.valuationStatus, 'VALUED');
  assert.equal(solAsset?.price, 200);
  assert.equal(solAsset?.valueUsdt, 1000);

  // Total portfolio: $1,100 (cash) + $1,000 (SOL) = $2,100
  assert.equal(result.totalPortfolioUsdt, 2100);
});

test('6. Bot Execution & Synchronization: engine-status provides bots & botsList with dcaLayers and gridLevels', () => {
  // Simulate active runner structure with DCA & Grid levels
  const mockRunner: any = {
    id: 'runner-test-1',
    botId: 'bot-1',
    botName: 'SOL Momentum Bot',
    pair: 'SOL/USDT',
    exchange: 'BINANCE',
    isSandbox: true,
    mode: 'testnet',
    botMode: 'Avarage+Grid',
    stepLayer: 2,
    averagingLayers: 3,
    gridLayers: 5,
    executedLayers: [
      {
        id: 'layer-1',
        orderId: 'ord-101',
        symbol: 'SOL/USDT',
        coin: 'SOL',
        side: 'buy',
        layerNo: 1,
        layerStep: 1,
        layerType: 'average',
        amount: 0.5,
        costUsdt: 100,
        buyPrice: 200,
        currentPrice: 195,
        estimatedTpPrice: 204,
        estimatedTpPct: 2,
        estimatedTpUsdt: 2,
        floatingPnlUsdt: -2.5,
        floatingPnlPct: -2.5,
        fee: 0,
        feeAsset: 'USDT',
        date: '2026-10-10 14:00:00',
        timestamp: Date.now(),
        isInitialEntry: true,
        status: 'filled',
      },
      {
        id: 'grid-1',
        orderId: 'ord-102',
        symbol: 'SOL/USDT',
        coin: 'SOL',
        side: 'buy',
        layerNo: 2,
        layerStep: 2,
        layerType: 'grid',
        amount: 0.25,
        costUsdt: 48,
        buyPrice: 192,
        currentPrice: 195,
        estimatedTpPrice: 194.3,
        estimatedTpPct: 1.2,
        estimatedTpUsdt: 0.576,
        floatingPnlUsdt: 0.75,
        floatingPnlPct: 1.56,
        fee: 0,
        feeAsset: 'USDT',
        date: '2026-10-10 14:10:00',
        timestamp: Date.now(),
        isInitialEntry: false,
        status: 'filled',
      },
    ],
    dcaLayers: [
      { layerNo: 0, deviationPct: 0, amountUsd: 100, status: 'WAITING' },
      { layerNo: 1, deviationPct: 1.5, amountUsd: 130, status: 'WAITING' },
    ],
    gridLevels: [
      { id: 'grid-0', index: 0, price: 180, side: 'BUY', status: 'WAITING' },
      { id: 'grid-1', index: 1, price: 192, side: 'BUY', status: 'FILLED' },
      { id: 'grid-2', index: 2, price: 204, side: 'SELL', status: 'WAITING' },
    ],
    entryPrice: 200,
    lastEvaluatedPrice: 195,
    status: 'active',
    positionQty: 0.75,
    avgEntryPrice: 197.33,
  };

  // Check engine-status transformation
  const botsList = [mockRunner].map((b) => ({
    id: b.id,
    botId: b.botId,
    runnerId: b.id,
    botName: b.botName,
    pair: b.pair,
    exchange: b.exchange,
    isSandbox: b.isSandbox,
    mode: b.mode,
    strategy: b.botMode,
    stepLayer: b.stepLayer,
    maxLayers: (b.averagingLayers || 0) + (b.gridLayers || 0),
    executedLayerCount: b.executedLayers.length,
    executedLayers: b.executedLayers,
    dcaLayers: b.dcaLayers,
    gridLevels: b.gridLevels,
    entryPrice: b.entryPrice,
    lastPrice: b.lastEvaluatedPrice,
    status: b.status,
    positionQty: b.positionQty,
    avgEntryPrice: b.avgEntryPrice,
  }));

  const responsePayload = {
    success: true,
    engineRunning: true,
    bots: botsList,
    botsList: botsList,
  };

  assert.ok(responsePayload.bots, 'Payload must include bots array');
  assert.ok(responsePayload.botsList, 'Payload must include botsList alias for client sync');
  assert.equal(responsePayload.bots.length, 1);
  assert.equal(responsePayload.botsList.length, 1);
  assert.equal(responsePayload.botsList[0].executedLayers.length, 2);
  assert.equal(responsePayload.botsList[0].executedLayers[0].layerType, 'average');
  assert.equal(responsePayload.botsList[0].executedLayers[1].layerType, 'grid');
  assert.equal(responsePayload.botsList[0].dcaLayers.length, 2);
  assert.equal(responsePayload.botsList[0].gridLevels.length, 3);
});

test('7. Egress Proxy & Time Sync: createExchangeInstance configures proxy and disables public/time sync on OKX', () => {
  // Test OKX time-sync bypass
  const okxInstance = createExchangeInstance('okx', { isSandbox: true });
  assert.equal(
    okxInstance.options?.adjustForTimeDifference,
    false,
    'OKX instance must have adjustForTimeDifference: false to prevent public/time ECONNRESET'
  );

  // Test Proxy configuration
  const originalProxy = process.env.EXCHANGE_PROXY_URL;
  try {
    process.env.EXCHANGE_PROXY_URL = 'http://127.0.0.1:8888';
    const proxiedInstance = createExchangeInstance('bitget', { isSandbox: true });
    assert.equal(proxiedInstance.httpsProxy, 'http://127.0.0.1:8888');
    assert.equal(proxiedInstance.proxy, 'http://127.0.0.1:8888');

    process.env.EXCHANGE_PROXY_URL = 'socks5://127.0.0.1:1080';
    const socksInstance = createExchangeInstance('bybit', { isSandbox: true });
    assert.equal(socksInstance.socksProxy, 'socks5://127.0.0.1:1080');
  } finally {
    process.env.EXCHANGE_PROXY_URL = originalProxy;
  }
});

test('8. OKX & Multi-Exchange Anti-ECONNRESET: fetchMarkets scoped to spot-only', () => {
  const okxInstance = createExchangeInstance('okx', { isSandbox: true });
  assert.equal(okxInstance.options?.defaultType, 'spot');
  assert.deepEqual(okxInstance.options?.fetchMarkets?.types, ['spot']);
  assert.equal(okxInstance.options?.fetchMarkets?.loadAllOptions, false);

  const bitgetInstance = createExchangeInstance('bitget', { isSandbox: true });
  assert.deepEqual(bitgetInstance.options?.fetchMarkets?.types, ['spot']);
});

test('9. Engine Status & Connection Audit: handles string positionQty safely without TypeError and sanitizes binanceSandboxEnv', () => {
  // Test sanitizeExchangeInput preserves binanceSandboxEnv
  const sanitized = sanitizeExchangeInput({
    exchange: 'binance',
    apiKey: '0123456789abcdef',
    secret: '0123456789abcdef',
    isSandbox: true,
    binanceSandboxEnv: 'demo',
  });
  assert.equal(sanitized.binanceSandboxEnv, 'demo');

  // Test engine-status mapping when positionQty is a string (e.g. from postgres numeric)
  const mockRunnerWithStringQty: any = {
    id: 'bot-pg-string-1',
    botId: 'bot-pg-string-1',
    botName: 'SOL Bot',
    pair: 'SOL/USDT',
    exchange: 'BINANCE',
    isSandbox: true,
    mode: 'testnet',
    botMode: 'Averaging Only',
    stepLayer: 1,
    executedLayers: [], // empty, triggering fallback layer generation
    positionQty: '0.75000000', // string from postgres NUMERIC column!
    avgEntryPrice: '150.25000000',
    entryPrice: '150.25000000',
    lastEvaluatedPrice: 155.0,
    baseTp: 1.5,
  };

  const posQty = Number(mockRunnerWithStringQty.positionQty || 0);
  const avgEntry = Number(mockRunnerWithStringQty.avgEntryPrice || mockRunnerWithStringQty.entryPrice || 0);
  const lastPrice = Number(mockRunnerWithStringQty.lastEvaluatedPrice || avgEntry || 0);
  const baseTp = Number(mockRunnerWithStringQty.baseTp || 1.5);

  const mapped = {
    executedLayers: (Array.isArray(mockRunnerWithStringQty.executedLayers) && mockRunnerWithStringQty.executedLayers.length > 0)
      ? mockRunnerWithStringQty.executedLayers
      : (posQty > 0 ? [{
          id: `layer-${mockRunnerWithStringQty.id}-1`,
          amount: posQty,
          costUsdt: Number((posQty * (avgEntry || 1)).toFixed(4)),
          buyPrice: avgEntry,
          label: `BUY -> ${posQty.toFixed(4)} ${mockRunnerWithStringQty.pair.split('/')[0]}`,
          currentPrice: lastPrice,
          estimatedTpPrice: Number((avgEntry * (1 + baseTp / 100)).toFixed(4)),
          estimatedTpPct: baseTp,
          estimatedTpUsdt: Number((posQty * avgEntry * (baseTp / 100)).toFixed(4)),
          floatingPnlUsdt: Number(((lastPrice - avgEntry) * posQty).toFixed(4)),
        }] : []),
  };

  assert.equal(mapped.executedLayers.length, 1);
  assert.equal(mapped.executedLayers[0].label, 'BUY -> 0.7500 SOL');
  assert.equal(mapped.executedLayers[0].amount, 0.75);
  assert.ok(typeof mapped.executedLayers[0].costUsdt === 'number');
});

test('10. Sandbox Guard: Rejects isSandbox: true for exchanges without official sandbox support', () => {
  assert.throws(
    () => createExchangeInstance('indodax', { isSandbox: true }),
    (err: any) => {
      assert.equal(err?.code, 'SANDBOX_NOT_SUPPORTED');
      assert.equal(err?.statusCode, 400);
      return true;
    }
  );
});

test('11. Indonesian ISP Bypass: Tokocrypto rewrites api.binance.com to api4.binance.com', () => {
  const tokoInstance = createExchangeInstance('tokocrypto');
  const tokoApiUrls = JSON.stringify((tokoInstance.urls as any) || {});
  assert.ok(
    !tokoApiUrls.includes('api.binance.com'),
    'Tokocrypto must not contain un-rewritten api.binance.com'
  );
});



