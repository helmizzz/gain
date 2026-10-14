import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import ccxt from 'ccxt';
import { randomUUID, createHash } from 'node:crypto';
import { ApiError } from '../shared/apiError';
import { EXCHANGE_REGISTRY, getExchangeDescriptor } from '../../config/exchangeRegistry';
import {
  requireFirebaseIdentity,
  requireSecuritySession,
  requireActiveLicense,
  requireDatabase,
  checkRedisRateLimit,
} from '../shared/authUtils';
import { decryptSensitiveString, verifyServerTotp } from '../shared/cryptoUtils';
import { logAuditEvent } from '../shared/observabilityUtils';
import {
  createOrderRecord,
  finalizeOrderWithFill,
  getTwoFactorSecretRecord,
  consumeTotpCounter,
  getLatestExchangeCertificationRun,
  dbQuery,
} from '../database';
import {
  SUPPORTED_EXCHANGES,
  DEFAULT_PORTFOLIO_COINS,
  EXCHANGE_CERT_STAGES,
  ExchangeCertificationStage,
  runAuthenticatedReadOnlyCertification,
  runSandboxDemoOrderCertification,
  runMicroLiveCertification,
  runCertificationReconciliation,
  fetchRekuPublicPrices,
  fetchBinancePublicSpotPrices,
  loadBotCredential,
  createExchangeInstance,
  tickerCacheKey,
  applyCircuitBreaker,
  ensureExchangeMarkets,
  isSupportedExchangeSymbol,
  withExchangeRetry,
  isDeterministicExchangeInputError,
  registerExchangeFailure,
  registerExchangeSuccess,
  assertRealExchangeCredentials,
  extractPortfolioAndValuation,
  sanitizeExchangeInput,
  runtimeLiveTradingEnabled,
  LIVE_TRADING_TESTNET_ONLY,
  EXCHANGE_TIMEOUT_MS,
  TICKER_CACHE_TTL_MS,
  checkRateLimit,
  sanitizeExchangeErrorMessage,
} from '../shared/exchangeUtils';
import { tickerMemoryCache, marketsMemoryCache, botExecutionMetrics } from '../shared/serverState';

const router = express.Router();

// Middleware: Guard against URL query credentials for all exchange endpoints
router.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.method === 'GET' && (req.query.apiKey || req.query.secret || req.query.password)) {
    return next(new ApiError(400, 'CREDENTIALS_IN_URL', 'validation', 'Exchange credentials must not be sent in URL query parameters.', 'Kredensial API tidak diizinkan dikirim melalui URL.'));
  }
  next();
});

// API: Exchange certification stages.
router.post('/api/exchange/certification/stage', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { identity } = await requireFirebaseIdentity(req);
    const exchange = String(req.body?.exchange || '').trim().toLowerCase();
    const stage = String(req.body?.stage || '').trim() as ExchangeCertificationStage;
    const descriptor = getExchangeDescriptor(exchange);
    if (!descriptor || !SUPPORTED_EXCHANGES.has(exchange)) return next(new ApiError(400, 'EXCHANGE_INVALID', 'validation', 'Exchange is invalid.', 'Exchange tidak valid.'));
    if (!EXCHANGE_CERT_STAGES.has(stage)) return next(new ApiError(400, 'CERTIFICATION_STAGE_INVALID', 'validation', 'Certification stage is invalid.', 'Tahap certification tidak valid.'));

    if (stage === 'authenticated_readonly') {
      const result = await runAuthenticatedReadOnlyCertification(identity.uid, exchange);
      return res.json(result);
    }
    if (stage === 'sandbox_demo_order') {
      await requireSecuritySession(req, identity.uid);
      const result = await runSandboxDemoOrderCertification(identity.uid, exchange);
      return res.json(result);
    }
    if (stage === 'micro_live_order') {
      const result = await runMicroLiveCertification(req, identity.uid, exchange);
      return res.json(result);
    }
    if (stage === 'reconcile' || stage === 'recovery') {
      const result = await runCertificationReconciliation(identity.uid, exchange, stage);
      return res.json(result);
    }
    return next(new ApiError(400, 'CERTIFICATION_STAGE_INVALID', 'validation', 'Certification stage is invalid.', 'Tahap certification tidak valid.'));
  } catch (error) {
    return next(error);
  }
});

router.get('/api/exchange/certification/latest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { identity } = await requireFirebaseIdentity(req);
    const exchange = String(req.query?.exchange || '').trim().toLowerCase();
    const descriptor = getExchangeDescriptor(exchange);
    if (!descriptor) return next(new ApiError(400, 'EXCHANGE_INVALID', 'validation', 'Exchange is invalid.', 'Exchange tidak valid.'));
    const stages: Record<string, unknown> = {};
    for (const stage of EXCHANGE_CERT_STAGES) stages[stage] = await getLatestExchangeCertificationRun(identity.uid, exchange, stage);
    return res.json({ success: true, exchange, stages });
  } catch (error) { return next(error); }
});

// API: Exchange certification (read-only by design; never places an order).
router.post('/api/exchange/certification', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireFirebaseIdentity(req);
    const exchange = String(req.body?.exchange || '').trim().toLowerCase();
    const descriptor = getExchangeDescriptor(exchange);
    if (!descriptor) return next(new ApiError(400, 'EXCHANGE_INVALID', 'validation', 'Exchange is invalid.', 'Exchange tidak valid.'));

    const startedAt = Date.now();
    if (descriptor.publicOnly && exchange === 'reku') {
      const payload = await fetchRekuPublicPrices(['BTC/IDR']);
      const btc = payload['BTC/IDR'];
      return res.json({
        success: Boolean(btc?.last > 0),
        exchange: descriptor.id,
        mode: 'READ_ONLY_PUBLIC_API',
        certificationMode: descriptor.certificationMode,
        checks: { publicApi: Boolean(btc?.last > 0), ticker: Boolean(btc?.last > 0), authenticated: false, trading: false },
        sample: btc ? { symbol: 'BTC/IDR', last: btc.last, quoteCurrency: btc.quoteCurrency, timestamp: btc.timestamp } : null,
        latencyMs: Date.now() - startedAt,
        note: descriptor.notes,
      });
    }

    if (descriptor.publicOnly || !descriptor.ccxtId) {
      return res.json({
        success: false,
        exchange: descriptor.id,
        mode: 'BLOCKED',
        certificationMode: descriptor.certificationMode,
        checks: { publicApi: false, authenticated: false, trading: false },
        latencyMs: Date.now() - startedAt,
        note: descriptor.notes,
      });
    }

    const identity = await requireFirebaseIdentity(req);
    const storedCredential = await loadBotCredential(identity.identity.uid, exchange);
    if (!storedCredential) {
      return next(new ApiError(409, 'EXCHANGE_CREDENTIALS_REQUIRED', 'authorization', `No active ${exchange} credentials are configured.`, 'Kredensial exchange aktif belum dikonfigurasi.'));
    }

    const client = createExchangeInstance(exchange, {
      apiKey: storedCredential.apiKey,
      secret: storedCredential.secret,
      password: storedCredential.password,
      isSandbox: storedCredential.isSandbox,
    });

    const checks: Record<string, boolean> = { publicApi: false, marketData: false, authenticated: false, balance: false, ordersRead: false, ticker: false, trading: false };
    await withExchangeRetry(exchange, 'certification.loadMarkets', () => client.loadMarkets());
    checks.publicApi = true;
    checks.marketData = true;
    const preferred = ['BTC/USDT', 'BTC/USDC', 'BTC/USD'];
    const symbol = preferred.find((candidate) => client.markets?.[candidate]);
    if (symbol) {
      const ticker: any = await withExchangeRetry(exchange, 'certification.fetchTicker', () => client.fetchTicker(symbol));
      checks.ticker = Number(ticker?.last) > 0;
    }
    const balance = await withExchangeRetry(exchange, 'certification.fetchBalance', () => client.fetchBalance());
    checks.authenticated = true;
    checks.balance = Boolean((balance as { total?: unknown } | null | undefined)?.total);
    if (client.has?.fetchOpenOrders && symbol) {
      await withExchangeRetry(exchange, 'certification.fetchOpenOrders', () => client.fetchOpenOrders(symbol));
      checks.ordersRead = true;
    }

    return res.json({
      success: Object.values(checks).filter(Boolean).length >= 4,
      exchange: descriptor.id,
      mode: storedCredential.isSandbox ? 'SANDBOX_OR_DEMO' : 'LIVE_READ_ONLY',
      certificationMode: descriptor.certificationMode,
      checks,
      sampleSymbol: symbol || null,
      latencyMs: Date.now() - startedAt,
      note: storedCredential.isSandbox ? 'Read-only certification; no order submitted.' : 'Live credentials verified read-only; no order submitted.',
    });
  } catch (error: any) {
    return next(error);
  }
});

// API: Supported Exchanges & Requirements
router.get('/api/exchange/supported', (_req: Request, res: Response) => {
  res.json({
    exchanges: EXCHANGE_REGISTRY.map((item) => ({
      id: item.id,
      name: item.name,
      requiresPassphrase: item.requiresPassphrase,
      spotSupported: item.tradingApi || item.publicApi,
      sandboxSupported: item.hasOfficialSandbox,
      publicApi: item.publicApi,
      authenticatedApi: item.authenticatedApi,
      tradingApi: item.tradingApi,
      certificationMode: item.certificationMode,
      quoteCurrencies: item.quoteCurrencies,
      notes: 'notes' in item ? item.notes : undefined,
      docsUrl: 'docsUrl' in item ? item.docsUrl : undefined,
      portalUrl: 'portalUrl' in item ? item.portalUrl : undefined,
    })),
  });
});

// API: Public Real-time Ticker
router.post('/api/exchange/fetch-ticker', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { exchange = 'bitget', symbol = 'BTC/USDT', isSandbox = false } = req.body;
    if (!SUPPORTED_EXCHANGES.has(String(exchange).toLowerCase().trim())) {
      return next(new ApiError(400, 'EXCHANGE_UNSUPPORTED', 'validation', `Unsupported exchange: ${exchange}.`, `Exchange "${exchange}" tidak didukung.`));
    }

    if (exchange === 'reku') {
      const map = await fetchRekuPublicPrices([symbol]);
      const ticker = map[symbol.toUpperCase()];
      if (!ticker) return res.json({ success: true, exchange, symbol, last: 0, percentage: 0, timestamp: Date.now(), degraded: true, warning: `Symbol ${symbol} tidak tersedia di Reku public market API.` });
      return res.json({ success: true, exchange, symbol, last: ticker.last, percentage: ticker.percentage, timestamp: ticker.timestamp, quoteCurrency: ticker.quoteCurrency, source: ticker.source });
    }

    const cacheKey = tickerCacheKey(exchange, symbol, isSandbox);
    const cached = tickerMemoryCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < 10000) {
      return res.json({
        success: true,
        exchange,
        symbol,
        last: cached.last,
        percentage: cached.percentage,
        timestamp: cached.timestamp,
        cached: true,
      });
    }

    if (!applyCircuitBreaker(String(exchange).toLowerCase().trim())) {
      return next(new ApiError(503, 'EXCHANGE_COOLDOWN', 'exchange', 'Exchange circuit breaker is open.', 'Exchange sementara dalam cooldown karena gagal berulang.'));
    }

    const client = createExchangeInstance(exchange, { isSandbox });
    try { await ensureExchangeMarkets(client); } catch { /* fetchTicker will provide the definitive exchange error */ }
    if (!isSupportedExchangeSymbol(client, symbol)) {
      return res.json({ success: true, exchange, symbol, last: 0, percentage: 0, timestamp: Date.now(), degraded: true, warning: `Symbol ${symbol} tidak tersedia di ${String(exchange).toUpperCase()} pada environment ini.` });
    }
    const ticker = await withExchangeRetry(String(exchange).toLowerCase().trim(), 'fetchTicker', async () => client.fetchTicker(symbol));

    if (ticker.last) {
      tickerMemoryCache.set(cacheKey, {
        last: Number(ticker.last),
        percentage: Number(ticker.percentage || 0),
        timestamp: Date.now(),
      });
    }

    res.json({
      success: true,
      exchange,
      symbol,
      last: ticker.last,
      high: ticker.high,
      low: ticker.low,
      percentage: ticker.percentage,
      baseVolume: ticker.baseVolume,
      quoteVolume: ticker.quoteVolume,
      timestamp: ticker.timestamp,
    });
  } catch (error: any) {
    const normalizedExchange = String(req.body?.exchange || 'binance').toLowerCase().trim();
    if (!isDeterministicExchangeInputError(error)) registerExchangeFailure(normalizedExchange);
    return next(error);
  }
});

router.post('/api/exchange/fetch-tickers-batch', async (req: Request, res: Response, next: NextFunction) => {
  const exchange = String(req.body?.exchange || 'binance').toLowerCase().trim();
  const inputSymbols = req.body?.symbols;
  const isSandbox = req.body?.isSandbox === true || req.body?.isSandbox === 'true';

  if (!SUPPORTED_EXCHANGES.has(exchange)) {
    return next(new ApiError(400, 'EXCHANGE_UNSUPPORTED', 'validation', `Unsupported exchange: ${exchange}.`, `Exchange "${exchange}" tidak didukung.`));
  }

  if (!Array.isArray(inputSymbols) || inputSymbols.length === 0 || inputSymbols.length > 30) {
    return next(new ApiError(400, 'TICKER_SYMBOLS_INVALID', 'validation', 'Ticker symbols must be a non-empty array with at most 30 entries.', 'Daftar simbol ticker tidak valid.'));
  }

  const symbols = [...new Set(inputSymbols.map((symbol: unknown) => String(symbol).trim().toUpperCase()))];
  if (symbols.some((symbol) => !/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,10}$/.test(symbol))) {
    return next(new ApiError(400, 'TICKER_SYMBOLS_INVALID', 'validation', 'One or more ticker symbols have an invalid format.', 'Format salah satu simbol ticker tidak valid.'));
  }

  try {
    const now = Date.now();
    const tickers: Record<string, { last: number; percentage: number; timestamp: number; source: string; quoteCurrency: string }> = {};
    const symbolsToFetch: string[] = [];
    let unresolvedSymbols: string[] = [];

    for (const symbol of symbols) {
      const cacheKey = tickerCacheKey(exchange, symbol, isSandbox);
      const cached = tickerMemoryCache.get(cacheKey);
      if (cached && now - cached.timestamp < TICKER_CACHE_TTL_MS) {
        tickers[symbol] = {
          last: cached.last,
          percentage: cached.percentage,
          timestamp: cached.timestamp,
          source: cached.source || 'exchange',
          quoteCurrency: cached.quoteCurrency || 'USDT',
        };
      } else {
        symbolsToFetch.push(symbol);
      }
    }

    const exchangeAvailable = applyCircuitBreaker(exchange);

    if (exchange === 'binance' && symbolsToFetch.length > 0) {
      try {
        const publicTickers = await fetchBinancePublicSpotPrices(symbolsToFetch, isSandbox);
        for (const [symbol, ticker] of Object.entries(publicTickers)) {
          tickers[symbol] = ticker;
          tickerMemoryCache.set(tickerCacheKey(exchange, symbol, isSandbox), ticker);
        }
        symbolsToFetch.splice(0, symbolsToFetch.length, ...symbolsToFetch.filter((symbol) => !tickers[symbol]));
      } catch (error: any) {
        console.warn('[BINANCE_PUBLIC_TICKER_PRIMARY_FAILED]', { requested: symbolsToFetch.length, message: String(error?.message || 'public ticker failed') });
      }
    }

    const descriptor = getExchangeDescriptor(exchange);
    if (descriptor?.ccxtId && symbolsToFetch.length > 0 && exchangeAvailable) {
      const client = createExchangeInstance(exchange, { isSandbox });
      try { await ensureExchangeMarkets(client); } catch { /* batch path degrades safely */ }
      const supportedSymbols = symbolsToFetch.filter((symbol) => isSupportedExchangeSymbol(client, symbol));
      const unsupportedSymbols = symbolsToFetch.filter((symbol) => !supportedSymbols.includes(symbol));
      if (unsupportedSymbols.length > 0) {
        botExecutionMetrics.tickerFailures += unsupportedSymbols.length;
      }
      symbolsToFetch.splice(0, symbolsToFetch.length, ...supportedSymbols);
      let batchResults: Record<string, any> = {};

      if (symbolsToFetch.length > 0 && client.has?.fetchTickers) {
        try {
          batchResults = await withExchangeRetry(exchange, 'fetchTickers', () => client.fetchTickers(symbolsToFetch));
        } catch {
          batchResults = {};
        }
      }

      unresolvedSymbols = [];
      for (const symbol of symbolsToFetch) {
        const ticker = batchResults[symbol];
        const last = Number(ticker?.last);
        if (Number.isFinite(last) && last > 0) {
          const timestamp = Number(ticker.timestamp) || Date.now();
          const percentage = Number(ticker.percentage) || 0;
          tickers[symbol] = { last, percentage, timestamp, source: exchange, quoteCurrency: 'USDT' };
          tickerMemoryCache.set(tickerCacheKey(exchange, symbol, isSandbox), { last, percentage, timestamp, source: exchange, quoteCurrency: 'USDT' });
        } else {
          unresolvedSymbols.push(symbol);
        }
      }

      if (unresolvedSymbols.length > 0) {
        const results = await Promise.allSettled(
          unresolvedSymbols.map((symbol) => withExchangeRetry(exchange, 'fetchTicker', () => client.fetchTicker(symbol)))
        );

        results.forEach((result, index) => {
          if (result.status !== 'fulfilled') return;
          const ticker: any = result.value;
          const last = Number(ticker?.last);
          if (!Number.isFinite(last) || last <= 0) return;

          const symbol = unresolvedSymbols[index];
          const timestamp = Number(ticker.timestamp) || Date.now();
          const percentage = Number(ticker.percentage) || 0;
          tickers[symbol] = { last, percentage, timestamp, source: exchange, quoteCurrency: 'USDT' };
          tickerMemoryCache.set(tickerCacheKey(exchange, symbol, isSandbox), { last, percentage, timestamp, source: exchange, quoteCurrency: 'USDT' });
        });
      }
    }

    unresolvedSymbols = symbols.filter((symbol) => !tickers[symbol]);

    if (exchange === 'reku' && unresolvedSymbols.length > 0) {
      try {
        const rekuTickers = await fetchRekuPublicPrices(unresolvedSymbols);
        for (const [symbol, ticker] of Object.entries(rekuTickers)) {
          tickers[symbol] = ticker;
          tickerMemoryCache.set(tickerCacheKey(exchange, symbol, isSandbox), ticker);
        }
        unresolvedSymbols = symbols.filter((symbol) => !tickers[symbol]);
      } catch (fallbackError: any) {
        console.warn('[REKU_PUBLIC_TICKER_FAILED]', {
          requested: unresolvedSymbols.length,
          message: String(fallbackError?.message || 'reku public ticker failed'),
        });
      }
    }

    if (unresolvedSymbols.length > 0) {
      try {
        const publicTickers = await fetchBinancePublicSpotPrices(unresolvedSymbols, isSandbox);
        for (const [symbol, ticker] of Object.entries(publicTickers)) {
          const resolvedTicker = {
            ...ticker,
            source: exchange === 'binance' ? ticker.source : `${exchange}-public-feed`,
          };
          tickers[symbol] = resolvedTicker;
          tickerMemoryCache.set(tickerCacheKey(exchange, symbol, isSandbox), resolvedTicker);
        }
        unresolvedSymbols = symbols.filter((symbol) => !tickers[symbol]);
      } catch (fallbackError: any) {
        console.warn('[PUBLIC_TICKER_FALLBACK_FAILED]', {
          exchange,
          sandbox: isSandbox,
          requested: symbols.length,
          message: String(fallbackError?.message || 'public ticker fallback failed'),
        });
      }
    }

    if (Object.keys(tickers).length === 0) {
      return res.json({
        success: true,
        exchange,
        source: 'unavailable',
        degraded: true,
        warning: 'Data harga sementara tidak tersedia dari exchange.',
        tickers: {},
      });
    }

    registerExchangeSuccess(exchange);
    const sources = [...new Set(Object.values(tickers).map((ticker) => ticker.source))];
    res.json({ success: true, exchange, source: sources.length === 1 ? sources[0] : 'mixed', degraded: unresolvedSymbols.length > 0, warning: unresolvedSymbols.length > 0 ? `Sebagian simbol tidak tersedia atau sementara gagal diambil: ${unresolvedSymbols.join(', ')}` : undefined, tickers });
  } catch (error: any) {
    return next(error);
  }
});

// API: Fetch Live Markets from CCXT Exchanger (fetchMarkets)
router.all('/api/exchange/markets', async (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  if (req.method === 'GET' && (req.query.apiKey || req.query.secret || req.query.password)) {
    return next(new ApiError(400, 'CREDENTIALS_IN_URL', 'validation', 'Exchange credentials must not be sent in URL query parameters.', 'Kredensial API tidak diizinkan dikirim melalui URL.'));
  }

  const query = req.method === 'POST' ? req.body : req.query;
  const rawExchange = (query.exchange || 'bitget').toString().trim();
  const desc = getExchangeDescriptor(rawExchange);
  const exchange = desc ? desc.id : rawExchange.toLowerCase();
  const isSandbox = query.isSandbox === true || query.isSandbox === 'true';
  const apiKey = query.apiKey ? query.apiKey.toString().trim() : undefined;
  const secret = query.secret ? query.secret.toString().trim() : undefined;
  const password = query.password ? query.password.toString().trim() : undefined;
  const forceRefresh = query.forceRefresh === true || query.forceRefresh === 'true';

  if (!SUPPORTED_EXCHANGES.has(exchange)) {
    return next(new ApiError(400, 'EXCHANGE_UNSUPPORTED', 'validation', `Unsupported exchange: ${rawExchange}.`, `Exchange "${rawExchange}" tidak didukung.`));
  }

  if (apiKey || secret) {
    await requireFirebaseIdentity(req);
    assertRealExchangeCredentials(apiKey, secret);
  }

  if (!applyCircuitBreaker(exchange)) {
    return next(new ApiError(503, 'EXCHANGE_COOLDOWN', 'exchange', 'Exchange circuit breaker is open.', 'Exchange sementara dalam cooldown karena gagal berulang.'));
  }

  const cacheKey = `markets:${exchange}:${isSandbox ? 'sandbox' : 'live'}`;
  const cached = marketsMemoryCache.get(cacheKey);

  if (!forceRefresh && cached && Date.now() - cached.timestamp < 300000) {
    return res.json({
      success: true,
      exchange: exchange.toUpperCase(),
      cached: true,
      latencyMs: Date.now() - startTime,
      totalMarkets: cached.markets.length,
      markets: cached.markets,
    });
  }

  try {
    if (exchange === 'reku') {
      if (apiKey || secret || password) {
        return next(new ApiError(400, 'REKU_PUBLIC_ONLY', 'validation', 'Reku market adapter is public read-only and does not accept credentials here.', 'Reku market certification saat ini read-only; jangan kirim credential.'));
      }
      const response = await fetch('https://api.reku.id/v2/coins', { headers: { Accept: 'application/json', 'User-Agent': 'GAIN-NiagaKoin/4.0.0' }, signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Reku coins HTTP ${response.status}`);
      const payload = await response.json() as any;
      const rows = Array.isArray(payload?.result) ? payload.result : Array.isArray(payload) ? payload : [];
      const spotMarkets = rows
        .filter((m: any) => m?.accountcode)
        .map((m: any) => ({
          symbol: `${String(m.accountcode).toUpperCase()}/IDR`,
          id: String(m.id ?? m.accountcode),
          base: String(m.accountcode).toUpperCase(),
          quote: 'IDR',
          active: Number(m.enablebuy) === 1 || Number(m.enablesell) === 1,
          spot: true,
          limits: { amount: { min: Number(m.minsend || 0) || 0.000001 }, cost: { min: 0 }, price: undefined },
          precision: { amount: Number(m.decimals ?? 8), price: Number(m.digits ?? 0) },
          info: { status: (Number(m.enablebuy) === 1 || Number(m.enablesell) === 1) ? 'TRADING' : 'HALT' },
        }));

      marketsMemoryCache.set(cacheKey, { timestamp: Date.now(), markets: spotMarkets });
      return res.json({ success: true, exchange: 'REKU', latencyMs: Date.now() - startTime, totalMarkets: spotMarkets.length, markets: spotMarkets, source: 'reku-public-api' });
    }

    const client = createExchangeInstance(exchange, { apiKey, secret, password, isSandbox });

    const rawMarkets = (await Promise.race([
      withExchangeRetry(exchange, 'fetchMarkets', () => client.fetchMarkets()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Koneksi timeout (7.5s) saat mengambil daftar pasar')), 7500)
      ),
    ])) as any[];

    const spotMarkets = (rawMarkets || [])
      .filter((m: any) => m && (m.spot || m.type === 'spot' || !m.type))
      .map((m: any) => ({
        symbol: m.symbol,
        id: m.id || m.symbol,
        base: m.base,
        quote: m.quote,
        active: m.active !== false && String(m.info?.status || m.info?.state || 'TRADING').toUpperCase() !== 'HALT' && String(m.info?.status || m.info?.state || 'TRADING').toUpperCase() !== 'BREAK',
        spot: true,
        limits: {
          amount: m.limits?.amount || { min: 0.001 },
          cost: m.limits?.cost || { min: 5 },
          price: m.limits?.price,
        },
        precision: {
          amount: m.precision?.amount,
          price: m.precision?.price,
        },
        info: {
          status: m.info?.status || m.info?.state || 'TRADING',
        },
      }));

    marketsMemoryCache.set(cacheKey, { timestamp: Date.now(), markets: spotMarkets });

    res.json({
      success: true,
      exchange: exchange.toUpperCase(),
      latencyMs: Date.now() - startTime,
      totalMarkets: spotMarkets.length,
      markets: spotMarkets,
    });
  } catch (error: any) {
    if (!isDeterministicExchangeInputError(error)) registerExchangeFailure(exchange);
    return next(error);
  }
});

// API: Test Exchange Connection & Authenticate
router.post('/api/exchange/test-connection', async (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  try {
    await requireFirebaseIdentity(req);
    const { exchange = 'bitget', apiKey, secret, password, isSandbox = false, binanceSandboxEnv } = sanitizeExchangeInput(req.body, { requirePassphrase: ['bitget', 'okx'].includes((req.body?.exchange || 'bitget').toString().toLowerCase().trim()) });

    if (!applyCircuitBreaker(exchange)) {
      return next(new ApiError(503, 'EXCHANGE_COOLDOWN', 'exchange', 'Exchange circuit breaker is open.', 'Exchange sementara dalam cooldown karena gagal berulang.'));
    }

    assertRealExchangeCredentials(apiKey, secret);

    let client: any;
    let detectedEnvName = isSandbox ? `${exchange.toUpperCase()} (Testnet Sandbox)` : `${exchange.toUpperCase()} (Live Real Spot)`;
    let detectedBinanceEnv: 'demo' | 'vision' | undefined = undefined;
    let balance: any;

    if (exchange === 'binance' && isSandbox) {
      const preferredEnv = binanceSandboxEnv === 'vision' ? 'vision' : 'demo';
      const fallbackEnv = preferredEnv === 'demo' ? 'vision' : 'demo';

      let primaryErr: any = null;
      let secondaryErr: any = null;

      // 1. Try preferred Spot environment
      try {
        const primaryClient = createExchangeInstance(exchange, { apiKey, secret, password, isSandbox, binanceSandboxEnv: preferredEnv });
        balance = await withExchangeRetry(exchange, 'fetchBalance', async () => primaryClient.fetchBalance());
        client = primaryClient;
        detectedBinanceEnv = preferredEnv;
        detectedEnvName = preferredEnv === 'demo'
          ? 'BINANCE (Spot Demo Mode: demo-api.binance.com)'
          : 'BINANCE (Spot Testnet Vision: testnet.binance.vision)';
      } catch (err: any) {
        primaryErr = err;
        const msg = String(err?.message || err || '');
        if (/api.?key|apikey|-2015|-2014|-2008|signature|invalid|unauthorized/i.test(msg)) {
          console.log(`[test-connection:binance-fallback] ${preferredEnv === 'demo' ? 'demo-api.binance.com' : 'testnet.binance.vision'} rejected credentials, trying ${fallbackEnv === 'demo' ? 'demo-api.binance.com' : 'testnet.binance.vision'}...`);
          try {
            const fallbackClient = createExchangeInstance(exchange, { apiKey, secret, password, isSandbox, binanceSandboxEnv: fallbackEnv });
            balance = await withExchangeRetry(exchange, 'fetchBalance', async () => fallbackClient.fetchBalance());
            client = fallbackClient;
            detectedBinanceEnv = fallbackEnv;
            detectedEnvName = fallbackEnv === 'demo'
              ? 'BINANCE (Spot Demo Mode: demo-api.binance.com)'
              : 'BINANCE (Spot Testnet Vision: testnet.binance.vision)';
          } catch (fbErr: any) {
            secondaryErr = fbErr;
          }
        } else {
          throw err;
        }
      }

      // If both Spot environments failed, run Derivatives / Futures Probe
      if (!client) {
        try {
          const futuresClient = new (ccxt as any).binance({
            apiKey: apiKey.trim(),
            secret: secret.trim(),
            enableRateLimit: false,
            options: { defaultType: 'future' },
          });
          if (typeof futuresClient.enableDemoTrading === 'function') {
            futuresClient.enableDemoTrading(true);
          } else {
            futuresClient.urls.api = { ...futuresClient.urls.api, ...futuresClient.urls.demo };
          }
          const fBal = await futuresClient.fetchBalance({ type: 'future' });
          if (fBal) {
            return next(new ApiError(
              400,
              'EXCHANGE_FUTURES_KEY_DETECTED',
              'authorization',
              'Binance Futures / Derivatives API key detected, but GAIN requires a Spot API key.',
              'API Key yang Anda masukkan terdeteksi valid di Binance Derivatives / Futures (demo-fapi.binance.com). Namun GAIN adalah bot SPOT TRADING (Averaging + Grid Spot). Bursa menolak order Spot karena kunci ini adalah kunci Futures. Silakan buat API Key baru dari menu Spot Trading akun Binance Anda atau centang izin Spot Trading.'
            ));
          }
        } catch {
          // Futures probe did not match
        }

        const demoErrMsg = String((preferredEnv === 'demo' ? primaryErr : secondaryErr)?.message || '');
        const visionErrMsg = String((preferredEnv === 'vision' ? primaryErr : secondaryErr)?.message || '');

        return next(new ApiError(
          401,
          'EXCHANGE_BINANCE_CREDENTIALS_REJECTED',
          'authorization',
          `Binance Spot API credentials rejected. Demo: ${demoErrMsg}, Vision: ${visionErrMsg}`,
          `Kredensial API Binance ditolak pada endpoint Spot Demo Mode (demo-api.binance.com) dan Spot Testnet (testnet.binance.vision).\n\n• Respon Spot Demo Mode: ${demoErrMsg || 'Invalid Api-Key ID'}\n• Respon Spot Testnet Vision: ${visionErrMsg || 'Invalid API-key / permissions'}\n\nPanduan Perbaikan:\n1. Pastikan API Key dibuat dari menu SPOT Trading (GAIN beroperasi khusus Spot DCA Averaging & Grid, bukan Futures/Derivatives).\n2. Di akun Binance (demo.binance.com), buka menu Demo Trading -> API Management untuk membuat Key Spot.\n3. Centang izin "Enable Reading" dan "Enable Spot & Margin Trading".\n4. Pilih opsi IP "Unrestricted" jika server dijalankan di komputer lokal (localhost).\n5. Pastikan Secret Key disalin lengkap tanpa spasi tambahan.`
        ));
      }
    } else {
      client = createExchangeInstance(exchange, { apiKey, secret, password, isSandbox });
      balance = await withExchangeRetry(exchange, 'fetchBalance', async () => client.fetchBalance());
    }

    const latency = Date.now() - startTime;

    const { currencies, portfolioAssets, usdtBalance, usdtAvailable, usdtTotalBalance, totalPortfolioUsdt, rawAssetCount, unvaluedDefaultAssetCount, valuationScope } =
      await extractPortfolioAndValuation(client, balance, exchange, isSandbox);

    res.json({
      success: true,
      message: `Koneksi ke ${detectedEnvName} berhasil diverifikasi!`,
      exchange: exchange.toUpperCase(),
      binanceSandboxEnv: detectedBinanceEnv,
      latencyMs: latency,
      portfolioAsOf: Date.now(),
      usdtBalance,
      usdtAvailable,
      usdtTotalBalance,
      totalPortfolioUsdt,
      rawAssetCount,
      unvaluedDefaultAssetCount,
      valuationScope,
      portfolioAssets,
      currencies,
      permissions: {
        spotTrading: true,
        readData: true,
        withdrawal: false,
      },
    });
    } catch (error: any) {
    const exchangeName = String(req.body?.exchange || 'bitget').toLowerCase().trim();
    const isSandbox = req.body?.isSandbox === true || req.body?.isSandbox === 'true';
    if (!isDeterministicExchangeInputError(error)) registerExchangeFailure(exchangeName);

    const rawMessage = String(error?.message || error || '');
    const lowerMessage = rawMessage.toLowerCase();
    console.warn(`[test-connection:failed] exchange=${exchangeName} isSandbox=${isSandbox}: ${rawMessage}`);

    if (/passphrase|ok-access-passphrase|50105/.test(lowerMessage)) {
      return next(new ApiError(
        401,
        'EXCHANGE_PASSPHRASE_INVALID',
        'authorization',
        `Passphrase validation failed for ${exchangeName}: ${rawMessage}`,
        `Passphrase API ${exchangeName.toUpperCase()} salah atau tidak cocok. Pastikan Anda memasukkan Passphrase yang dibuat saat membuat API Key di ${exchangeName.toUpperCase()} (bukan password login akun). Catatan: Untuk mode Testnet / Demo, pastikan API Key dibuat dari menu Demo Trading ${exchangeName.toUpperCase()}.`
      ));
    }

    if (/api.?key|apikey|-2015|-2014|-2008|50100|50111|signature|invalid api|key format invalid|unauthorized|authentication/.test(lowerMessage)) {
      const guidance = exchangeName === 'binance'
        ? `API Key atau Secret Key BINANCE tidak valid atau tidak memiliki izin Spot Trading. Catatan penting: (1) Pastikan 'Enable Spot & Margin Trading' dicentang di bursa, (2) Jika menjalankan server di komputer lokal, pastikan IP Access Restriction di Binance diatur ke 'Unrestricted', (3) Pastikan kredensial sesuai mode: Testnet/Demo vs Live.`
        : `API Key atau Secret Key ${exchangeName.toUpperCase()} tidak valid atau tidak memiliki izin Spot Trading. Pastikan kredensial sesuai dengan mode yang dipilih (${isSandbox ? 'Testnet/Demo' : 'Live'}).`;
      return next(new ApiError(
        401,
        'EXCHANGE_CREDENTIALS_INVALID',
        'authorization',
        `API Key validation failed for ${exchangeName}: ${rawMessage}`,
        guidance
      ));
    }

    if (/unauthorized ip|ip restriction|whitelist/.test(lowerMessage)) {
      return next(new ApiError(
        403,
        'EXCHANGE_IP_RESTRICTED',
        'authorization',
        `IP restriction for ${exchangeName}: ${rawMessage}`,
        `IP belum diizinkan di ${exchangeName.toUpperCase()}. Pastikan opsi 'Unrestricted IP' diaktifkan di pengaturan API bursa Anda.`
      ));
    }

    if (/econnreset|fetch failed|socket|etimedout|network/.test(lowerMessage)) {
      return next(new ApiError(
        503,
        'EXCHANGE_NETWORK_RESET',
        'exchange',
        `Network connection reset for ${exchangeName}: ${rawMessage}`,
        `Koneksi ke bursa ${exchangeName.toUpperCase()} terputus oleh jaringan ISP lokal (ECONNRESET). Mohon coba lagi beberapa saat atau aktifkan DNS 1.1.1.1 / WARP.`
      ));
    }

    return next(new ApiError(
      400,
      'EXCHANGE_CONNECTION_FAILED',
      'exchange',
      rawMessage,
      `Gagal memverifikasi koneksi ${exchangeName.toUpperCase()}: ${rawMessage}`
    ));
  }
});

// API: Fetch Real-Time Portfolio & Open Orders
router.post('/api/exchange/fetch-portfolio', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();

    const { identity } = await requireFirebaseIdentity(req);

    const requestedExchange = String(req.body?.exchange || 'binance')
      .toLowerCase()
      .trim();

    if (!SUPPORTED_EXCHANGES.has(requestedExchange)) {
      return next(new ApiError(
        400,
        'EXCHANGE_INVALID',
        'validation',
        `Exchange "${requestedExchange}" is not supported.`,
        `Exchange "${requestedExchange}" tidak didukung.`
      ));
    }

    const storedCredential = await loadBotCredential(identity.uid, requestedExchange);

    if (!storedCredential) {
      return next(new ApiError(
        409,
        'EXCHANGE_CREDENTIALS_REQUIRED',
        'authorization',
        'Encrypted exchange credentials are required.',
        'Simpan kredensial API exchange terlebih dahulu.'
      ));
    }

    const {
      apiKey,
      secret,
      password,
      isSandbox,
    } = storedCredential;

    assertRealExchangeCredentials(apiKey, secret);

    if (!applyCircuitBreaker(requestedExchange)) {
      return next(new ApiError(
        503,
        'EXCHANGE_COOLDOWN',
        'exchange',
        'Exchange circuit breaker is open.',
        'Exchange sementara dalam cooldown karena gagal berulang.'
      ));
    }

    const client = createExchangeInstance(requestedExchange, {
      apiKey,
      secret,
      password,
      isSandbox,
      binanceSandboxEnv: storedCredential.binanceSandboxEnv,
    });

    let balance: any;
    try {
      balance = await withExchangeRetry(
        requestedExchange,
        'fetchBalance',
        async () => client.fetchBalance()
      );
    } catch (balanceError: any) {
      const errStr = String(balanceError?.message || balanceError).toLowerCase();
      const errName = String(balanceError?.name || '').toLowerCase();
      // If it's an authentication error, bubble it up so user knows credentials need update
      if (/auth|key|secret|passphrase|signature|permission|ip restricted|50111|10003/.test(`${errName} ${errStr}`)) {
        throw balanceError;
      }
      // Transient network or connection reset: degrade gracefully rather than throwing 500
      return res.json({
        success: true,
        exchange: requestedExchange.toUpperCase(),
        isSandbox,
        degraded: true,
        warning: `Koneksi ke ${requestedExchange.toUpperCase()} sementara mengalami gangguan jaringan (${balanceError?.message || 'ECONNRESET'}). Sedang mencoba sinkronisasi ulang.`,
        usdtBalance: 0,
        usdtAvailable: 0,
        usdtTotalBalance: 0,
        totalPortfolioUsdt: 0,
        rawAssetCount: 0,
        unvaluedDefaultAssetCount: 0,
        valuationScope: 'DEFAULT_12_COINS',
        portfolioAssets: [],
        openOrders: [],
      });
    }

    const {
      currencies,
      portfolioAssets,
      usdtBalance,
      usdtAvailable,
      usdtTotalBalance,
      totalPortfolioUsdt,
      rawAssetCount,
      unvaluedDefaultAssetCount,
      valuationScope,
    } = await extractPortfolioAndValuation(
      client,
      balance,
      requestedExchange,
      isSandbox
    );

    let openOrders: any[] = [];

    try {
      openOrders = await client.fetchOpenOrders();
    } catch {
    }

    res.json({
      success: true,
      exchange: requestedExchange.toUpperCase(),
      isSandbox,
      usdtBalance,
      usdtAvailable,
      usdtTotalBalance,
      totalPortfolioUsdt,
      rawAssetCount,
      unvaluedDefaultAssetCount,
      valuationScope,
      portfolioAssets,
      currencies,
      openOrdersCount: openOrders.length,
      openOrders,
      portfolioAsOf: Date.now(),
    });
    registerExchangeSuccess(requestedExchange);
  } catch (error: any) {
    if (!(error instanceof ApiError) || error.statusCode >= 500) {
      if (!isDeterministicExchangeInputError(error)) {
        registerExchangeFailure(
          String(req.body?.exchange || 'binance').toLowerCase().trim()
        );
      }
    }

    return next(error);
  }
});

// API: Place Order (Spot Buy/Sell)
router.post('/api/exchange/place-order', async (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDatabase();
    const { identity } = await requireFirebaseIdentity(req);
    await requireSecuritySession(req, identity.uid);
    const requestedSandbox = Boolean(req.body?.isSandbox ?? true);
    if (!requestedSandbox && !runtimeLiveTradingEnabled) return next(new ApiError(403,'LIVE_TRADING_DISABLED','security','Live trading is disabled on this server.','Trading live belum diaktifkan oleh administrator.'));
    const { symbol, type = 'market', side = 'buy', amount, price } = req.body;
    const validatedExchange = String(req.body?.exchange || 'binance').toLowerCase().trim();
    if (!SUPPORTED_EXCHANGES.has(validatedExchange)) return next(new ApiError(400,'EXCHANGE_INVALID','validation','Exchange is not supported.','Exchange tidak didukung.'));
    const storedCredential = await loadBotCredential(identity.uid, validatedExchange);
    if (!storedCredential) return next(new ApiError(409,'EXCHANGE_CREDENTIALS_REQUIRED','authorization','Store exchange credentials before placing an order.','Simpan kredensial exchange terlebih dahulu.'));
    const { apiKey, secret, password, isSandbox: validatedSandbox } = storedCredential;

    if (!applyCircuitBreaker(validatedExchange)) {
      return next(new ApiError(503, 'EXCHANGE_COOLDOWN', 'exchange', 'Exchange circuit breaker is open.', 'Exchange sementara dalam cooldown karena gagal berulang.'));
    }

    const effectiveExchange = validatedExchange;
    const effectiveSandbox = validatedSandbox;
    if (!effectiveSandbox) await requireActiveLicense(identity.uid);
    if (LIVE_TRADING_TESTNET_ONLY && !effectiveSandbox) return next(new ApiError(403,'LIVE_TRADING_TESTNET_ONLY','security','This server is restricted to exchange testnet/sandbox orders.','Server ini masih dibatasi untuk order Testnet/Sandbox.'));
    if (!effectiveSandbox) {
      const security = await getTwoFactorSecretRecord(identity.uid);
      const otp = String(req.body?.otp2fa || '').trim();
      if (!security?.two_factor_enabled || !security.two_factor_secret_ciphertext || !security.two_factor_secret_iv || !security.two_factor_secret_auth_tag) return next(new ApiError(403,'TRADE_2FA_REQUIRED','authorization','Two-factor authentication is required for live exchange orders.','Aktifkan 2FA sebelum order live.'));
      const secret = decryptSensitiveString({ciphertext:security.two_factor_secret_ciphertext,iv:security.two_factor_secret_iv,authTag:security.two_factor_secret_auth_tag});
      const verification = verifyServerTotp(otp, secret, 1);
      if (!verification.valid || verification.counter === undefined || !(await consumeTotpCounter(identity.uid, verification.counter))) return next(new ApiError(403,'TRADE_2FA_INVALID','authorization','The TOTP code is invalid or already used.','Kode Google Authenticator tidak valid atau sudah digunakan.'));
    }

    if (!symbol || !side || !amount) {
      return next(new ApiError(400, 'ORDER_FIELDS_REQUIRED', 'validation', 'Order symbol, side, and amount are required.', 'Parameter symbol, side (buy/sell), dan amount wajib diisi.'));
    }

    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(`order:${clientIp}`, 15, 10000) || !(await checkRedisRateLimit(`order:${identity.uid}`, 15, 10))) {
      return next(new ApiError(429, 'ORDER_RATE_LIMITED', 'rate_limit', 'Order rate limit exceeded.', 'Rate limit order terlampaui. Harap tunggu beberapa saat sebelum mengeksekusi order baru.'));
    }

    const cleanSymbol = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,10}$/.test(cleanSymbol)) {
      return next(new ApiError(400, 'ORDER_SYMBOL_INVALID', 'validation', 'Order symbol has an invalid format.', 'Format symbol tidak valid (contoh yang benar: BTC/USDT).'));
    }

    const cleanSide = side.toString().toLowerCase().trim();
    if (cleanSide !== 'buy' && cleanSide !== 'sell') {
      return next(new ApiError(400, 'ORDER_SIDE_INVALID', 'validation', 'Order side must be buy or sell.', 'Side order hanya boleh "buy" atau "sell".'));
    }

    const cleanType = (type || 'market').toString().toLowerCase().trim();
    if (cleanType !== 'market' && cleanType !== 'limit') {
      return next(new ApiError(400, 'ORDER_TYPE_INVALID', 'validation', 'Order type must be market or limit.', 'Tipe order hanya boleh "market" atau "limit".'));
    }

    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > 1000000) {
      return next(new ApiError(400, 'ORDER_AMOUNT_INVALID', 'validation', 'Order amount is outside the accepted range.', 'Nilai amount tidak valid atau melebihi batas toleransi keamanan (0 < amount <= 1,000,000).'));
    }

    if (price !== undefined && price !== null) {
      const numPrice = Number(price);
      if (!Number.isFinite(numPrice) || numPrice <= 0 || numPrice > 2000000) {
        return next(new ApiError(400, 'ORDER_PRICE_INVALID', 'validation', 'Order price is outside the accepted range.', 'Nilai harga limit tidak valid.'));
      }
    }

    assertRealExchangeCredentials(apiKey, secret);
    const clientOrderId = `m${createHash('sha256').update(`${identity.uid}:${Date.now()}:${randomUUID()}`).digest('hex').slice(0, 30)}`;
    const cachedPrice = tickerMemoryCache.get(tickerCacheKey(effectiveExchange, cleanSymbol, effectiveSandbox))?.last;
    const finalPrice = price ? Number(price) : cachedPrice;
    if (!finalPrice || !Number.isFinite(finalPrice) || finalPrice <= 0) {
      return next(new ApiError(409, 'REAL_MARKET_PRICE_REQUIRED', 'exchange', 'A fresh exchange market price is required before placing an order.', 'Harga market real dari exchange wajib tersedia sebelum order dikirim.'));
    }
    const financialOrder = await createOrderRecord({ firebaseUid: identity.uid, exchange: effectiveExchange, symbol: cleanSymbol, side: cleanSide, orderType: cleanType, clientOrderId, idempotencyKey: String(req.header('Idempotency-Key') || clientOrderId), requestedQty: Number(amount), requestedPrice: finalPrice, expectedNotional: Number(amount) * finalPrice, status: 'SUBMITTED' });
    if (financialOrder.replayed) return res.status(409).json({ success:false, error:'Idempotent order already exists.', code:'IDEMPOTENT_ORDER_ALREADY_EXISTS', orderId:financialOrder.id });

    const client = createExchangeInstance(effectiveExchange, {
      apiKey,
      secret,
      password,
      isSandbox: effectiveSandbox,
      binanceSandboxEnv: storedCredential.binanceSandboxEnv,
    });

    try {
      if (!client.markets || Object.keys(client.markets).length === 0) {
        await client.loadMarkets();
      }
    } catch {}

    let finalAmount = Number(amount);
    if (client.markets && client.markets[cleanSymbol]) {
      try {
        finalAmount = Number(client.amountToPrecision(cleanSymbol, finalAmount));
      } catch {}
    }

    let orderPrice = price ? Number(price) : undefined;
    if (!orderPrice && cleanType === 'market' && cleanSide === 'buy' && ['indodax', 'bitget', 'bybit', 'okx'].includes(effectiveExchange)) {
      orderPrice = finalPrice;
    }

    let order: any = await withExchangeRetry(effectiveExchange, 'createOrder', async () => (
      client.createOrder(
        cleanSymbol,
        cleanType,
        cleanSide,
        finalAmount,
        orderPrice,
        { clientOrderId }
      )
    ));
    let orderStatus = String(order.status || '').toLowerCase();
    const terminalStatuses = new Set(['closed', 'filled', 'canceled', 'cancelled']);

    if (order.id && !terminalStatuses.has(orderStatus)) {
      order = await withExchangeRetry(effectiveExchange, 'fetchOrder', async () => client.fetchOrder(order.id, cleanSymbol));
      orderStatus = String(order.status || '').toLowerCase();
    }

    if (order.id && !terminalStatuses.has(orderStatus)) {
      await client.cancelOrder(order.id, cleanSymbol);
      order = await withExchangeRetry(effectiveExchange, 'fetchOrder', async () => client.fetchOrder(order.id, cleanSymbol));
      orderStatus = String(order.status || '').toLowerCase();
    }

    const filled = Number(order.filled) || 0;
    const fillPrice = Number(order.average || order.price) || 0;
    if (!order.id || filled <= 0 || fillPrice <= 0 || !terminalStatuses.has(orderStatus)) {
      return next(new ApiError(
        502,
        'ORDER_FILL_UNCONFIRMED',
        'exchange',
        'Exchange did not confirm a terminal order fill.',
        'Bursa belum mengonfirmasi fill order. Periksa open order dan saldo exchange sebelum mencoba lagi.'
      ));
    }

    await finalizeOrderWithFill({ orderId: financialOrder.id, exchangeOrderId: String(order.id), quantity: filled, price: fillPrice, quoteAmount: Number((filled * fillPrice).toFixed(10)), feeAmount: Number(order.fee?.cost || 0), feeAsset: order.fee?.currency ? String(order.fee.currency) : undefined });
        logAuditEvent(req, res, 'exchange.order.submitted', {
      exchange: effectiveExchange,
      symbol: cleanSymbol,
      side: cleanSide,
      sandbox: effectiveSandbox,
    });
    res.json({
      success: true,
      message: `Order ${side.toUpperCase()} ${symbol} berhasil dieksekusi di ${effectiveExchange.toUpperCase()} ${effectiveSandbox ? '(Testnet)' : ''}!`,
      orderId: order.id,
      status: filled < finalAmount ? 'partially_filled' : 'filled',
      filled,
      price: fillPrice,
      amount: order.amount,
      timestamp: order.timestamp,
    });
  } catch (error: any) {
    if (!isDeterministicExchangeInputError(error)) {
      registerExchangeFailure(String(req.body?.exchange || 'binance').toLowerCase().trim());
    }
    return next(error);
  }
});

// API: Fetch Trade History from Exchange
router.post('/api/exchange/fetch-trades', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { identity } = await requireFirebaseIdentity(req);
    const requestedExchange = String(req.body?.exchange || 'binance').trim().toLowerCase();

    if (!getExchangeDescriptor(requestedExchange)?.tradingApi) {
      return next(new ApiError(
        400,
        'EXCHANGE_INVALID',
        'validation',
        'Exchange is invalid.',
        'Exchange tidak valid.',
      ));
    }

    const symbol = typeof req.body?.symbol === 'string' && req.body.symbol.trim()
      ? req.body.symbol.trim()
      : undefined;

    const parsedLimit = Number(req.body?.limit ?? 30);
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(Math.floor(parsedLimit), 100))
      : 30;
    const parsedSince = Number(req.body?.since);
    const since = Number.isFinite(parsedSince) && parsedSince > 0 ? Math.floor(parsedSince) : undefined;
    const parsedUntil = Number(req.body?.until ?? req.body?.endTime);
    const until = Number.isFinite(parsedUntil) && parsedUntil > 0 ? Math.floor(parsedUntil) : undefined;

    if (!applyCircuitBreaker(requestedExchange)) {
      return next(new ApiError(
        503,
        'EXCHANGE_COOLDOWN',
        'exchange',
        'Exchange circuit breaker is open.',
        'Exchange sementara dalam cooldown karena gagal berulang.',
      ));
    }

    const storedCredential = await loadBotCredential(identity.uid, requestedExchange);

    if (!storedCredential) {
      return next(new ApiError(
        409,
        'EXCHANGE_CREDENTIALS_REQUIRED',
        'validation',
        `No active ${requestedExchange} exchange credentials are configured for this account.`,
        'Kredensial exchange aktif belum dikonfigurasi untuk akun ini.',
      ));
    }

    const resolvedExchange = storedCredential.exchange;
    const resolvedApiKey = storedCredential.apiKey;
    const resolvedSecret = storedCredential.secret;
    const resolvedPassword = storedCredential.password;
    const resolvedSandbox = storedCredential.isSandbox;

    const resetContext = await dbQuery<{ cutoff_at: string }>(
      `SELECT cutoff_at FROM exchange_context_resets
        WHERE user_id = (SELECT id FROM users WHERE firebase_uid = $1)
          AND upper(exchange) = upper($2)
          AND sandbox = $3
        LIMIT 1`,
      [identity.uid, resolvedExchange, resolvedSandbox],
    );
    const resetCutoff = resetContext.rows[0]?.cutoff_at ? new Date(resetContext.rows[0].cutoff_at).getTime() : 0;
    const effectiveSince = Math.max(since ?? 0, resetCutoff);

    const client = createExchangeInstance(resolvedExchange, {
      apiKey: resolvedApiKey,
      secret: resolvedSecret,
      password: resolvedPassword,
      isSandbox: resolvedSandbox,
      binanceSandboxEnv: storedCredential.binanceSandboxEnv,
    });

    const formattedTrades: Array<{
      id: string;
      orderId?: string;
      exchange: string;
      symbol: string;
      side: 'buy' | 'sell';
      type: string;
      price: number;
      amount: number;
      costUsdt: number;
      fee?: { cost: number; currency: string };
      timestamp: number;
      datetime: string;
      status: 'filled' | 'closed' | 'open' | 'canceled';
      isSandbox: boolean;
    }> = [];

    try { await ensureExchangeMarkets(client); } catch { /* trade history can attempt generic retrieval */ }
    if (symbol && !isSupportedExchangeSymbol(client, symbol)) {
      return res.json({ success: true, count: 0, trades: [], source: 'EXCHANGE_API', exchange: resolvedExchange, isSandbox: resolvedSandbox, degraded: true, warning: `Symbol ${symbol} tidak tersedia di ${resolvedExchange.toUpperCase()} pada environment ini.` });
    }

    // Query symbols dynamically from user's bots in database
    let userBotSymbols: string[] = [];
    try {
      const userBotsResult = await dbQuery<{ symbol: string }>(
        `SELECT DISTINCT upper(b.symbol) as symbol
           FROM bots b
           JOIN users u ON u.id = b.user_id
          WHERE u.firebase_uid = $1`,
        [identity.uid],
      );
      userBotSymbols = userBotsResult.rows.map((r) => r.symbol).filter(Boolean);
    } catch {
      // Fallback silently if query fails
    }

    const idrCandidates = ['BTC/IDR', 'ETH/IDR', 'USDT/IDR', 'DOGE/IDR', 'SOL/IDR', 'XRP/IDR'];
    const defaultBaseCandidates = [
      'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT',
      'ADA/USDT', 'AVAX/USDT', 'NEAR/USDT', 'SUI/USDT', 'LINK/USDT', 'TAO/USDT',
      'TIA/USDT', 'ZEC/USDT', 'HYPE/USDT', 'XAUT/USDT', 'ASTER/USDT',
    ];
    const candidatePool = Array.from(new Set([
      ...userBotSymbols,
      ...(resolvedExchange === 'indodax' ? idrCandidates : defaultBaseCandidates),
      ...(resolvedExchange === 'indodax' ? ['BTC/USDT', 'ETH/USDT'] : idrCandidates),
    ]));

    const targetSymbols = symbol
      ? [symbol]
      : candidatePool.filter((candidate) => isSupportedExchangeSymbol(client, candidate));

    const extraFetchParams = until && until > 0 ? { endTime: until, until } : {};
    let rawTrades: any[] = [];

    if (symbol) {
      try {
        if (client.has['fetchMyTrades']) {
          rawTrades = await withExchangeRetry(resolvedExchange, 'fetchMyTrades', async () =>
            client.fetchMyTrades(String(symbol), effectiveSince || undefined, limit, extraFetchParams),
          );
        } else if (client.has['fetchClosedOrders']) {
          rawTrades = await withExchangeRetry(resolvedExchange, 'fetchClosedOrders', async () =>
            client.fetchClosedOrders(symbol, effectiveSince || undefined, limit, extraFetchParams),
          );
        }
      } catch (err: any) {
        console.warn(`[CCXT] fetchMyTrades error for ${symbol}:`, err.message);
      }
    } else {
      // Batch fetch in concurrent chunks of 4 to avoid hitting exchange rate limits
      const CHUNK_SIZE = 4;
      for (let i = 0; i < targetSymbols.length; i += CHUNK_SIZE) {
        const chunk = targetSymbols.slice(i, i + CHUNK_SIZE);
        const results = await Promise.allSettled(
          chunk.map(async (s) => {
            try {
              if (!s || !s.includes('/')) return [];
              if (client.has['fetchMyTrades']) {
                return await withExchangeRetry(resolvedExchange, 'fetchMyTrades', async () =>
                  client.fetchMyTrades(String(s), effectiveSince || undefined, Math.max(1, Math.min(limit, 50)), extraFetchParams),
                );
              } else if (client.has['fetchClosedOrders']) {
                return await withExchangeRetry(resolvedExchange, 'fetchClosedOrders', async () =>
                  client.fetchClosedOrders(s, effectiveSince || undefined, Math.max(1, Math.min(limit, 50)), extraFetchParams),
                );
              }
            } catch {
              return [];
            }
            return [];
          }),
        );

        for (const res of results) {
          if (res.status === 'fulfilled' && Array.isArray(res.value)) {
            rawTrades.push(...res.value);
          }
        }
      }
    }

    // Merge internally executed orders from bot database (for testnet/offline/fallback resilience)
    try {
      const dbFillsResult = await dbQuery<any>(
        `SELECT o.side, o.symbol, o.order_type, o.id::text AS order_id, o.client_order_id,
                f.price, f.quantity, f.quote_amount, COALESCE(f.fee_amount, 0) AS fee_amount,
                f.fee_asset, f.filled_at, f.id::text AS fill_id
           FROM fills f
           JOIN orders o ON o.id = f.order_id
           JOIN bots b ON b.id = o.bot_id
           JOIN users u ON u.id = b.user_id
          WHERE u.firebase_uid = $1
            AND lower(o.exchange) = lower($2)
            ${symbol ? 'AND upper(o.symbol) = upper($3)' : ''}
          ORDER BY f.filled_at DESC
          LIMIT ${symbol ? '$4' : '$3'}`,
        symbol ? [identity.uid, resolvedExchange, symbol, limit] : [identity.uid, resolvedExchange, limit],
      );

      const existingTradeIds = new Set(rawTrades.map((t) => String(t.id || t.orderId || t.order || '')));
      for (const row of dbFillsResult.rows) {
        const fillId = `fill-${row.fill_id}`;
        const orderIdStr = String(row.order_id || '');
        if (existingTradeIds.has(fillId) || (orderIdStr && existingTradeIds.has(orderIdStr))) continue;

        const fillTimestamp = row.filled_at ? new Date(row.filled_at).getTime() : Date.now();
        rawTrades.push({
          id: fillId,
          orderId: row.order_id,
          order: row.order_id,
          symbol: row.symbol,
          side: row.side,
          type: row.order_type || 'market',
          price: Number(row.price || 0),
          amount: Number(row.quantity || 0),
          cost: Number(row.quote_amount || 0) || (Number(row.price || 0) * Number(row.quantity || 0)),
          timestamp: fillTimestamp,
          datetime: new Date(fillTimestamp).toISOString(),
          status: 'filled',
          fee: row.fee_amount > 0 ? { cost: Number(row.fee_amount), currency: row.fee_asset || 'USDT' } : undefined,
        });
      }
    } catch (dbFillsErr) {
      console.warn('[fetch-trades] DB fills fallback error:', dbFillsErr);
    }

    if (effectiveSince > 0) {
      rawTrades = rawTrades.filter((trade) => Number(trade?.timestamp || 0) >= effectiveSince);
    }
    if (until && until > 0) {
      rawTrades = rawTrades.filter((trade) => Number(trade?.timestamp || 0) <= until);
    }
    rawTrades.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    let usdtIdrRate = 16000;
    let rateResolved = false;

    for (const t of rawTrades.slice(0, limit)) {
      const tradeId = t.id || t.orderId || `tr-${t.timestamp || Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const price = Number(t.price || t.average || 0);
      const amount = Number(t.amount || t.filled || 0);
      const tradeSymbol = String(t.symbol || symbol || 'BTC/USDT');
      const isIdrQuote = tradeSymbol.toUpperCase().endsWith('/IDR');
      let rawCost = Number(t.cost || (price * amount));
      if (isIdrQuote) {
        if (!rateResolved) {
          try {
            if (client?.markets && isSupportedExchangeSymbol(client, 'USDT/IDR')) {
              const rTicker = await client.fetchTicker('USDT/IDR');
              if (Number(rTicker?.last) > 0) usdtIdrRate = Number(rTicker.last);
            }
          } catch {}
          rateResolved = true;
        }
        rawCost = rawCost / usdtIdrRate;
      }
      const costUsdt = Number(rawCost.toFixed(2));
      const side = (t.side || 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy';
      const status = (t.status || 'filled').toLowerCase() as 'filled' | 'closed' | 'open' | 'canceled';

      formattedTrades.push({
        id: String(tradeId),
        orderId: t.order ? String(t.order) : (t.orderId ? String(t.orderId) : undefined),
        exchange: resolvedExchange.toUpperCase(),
        symbol: tradeSymbol,
        side,
        type: t.type || 'market',
        price,
        amount,
        costUsdt,
        fee: t.fee ? { cost: Number(t.fee.cost || 0), currency: t.fee.currency || (isIdrQuote ? 'IDR' : 'USDT') } : undefined,
        timestamp: t.timestamp || Date.now(),
        datetime: t.datetime || new Date(t.timestamp || Date.now()).toISOString(),
        status,
        isSandbox: resolvedSandbox,
      });
    }

    registerExchangeSuccess(resolvedExchange);
    return res.json({
      success: true,
      source: 'EXCHANGE_API',
      count: formattedTrades.length,
      trades: formattedTrades,
      exchange: resolvedExchange,
      isSandbox: resolvedSandbox,
      since: effectiveSince || null,
      until: until || null,
      resetCutoff: resetCutoff || null,
    });
  } catch (error: any) {
    if (!isDeterministicExchangeInputError(error)) {
      registerExchangeFailure(String(req.body?.exchange || 'binance').toLowerCase().trim());
    }
    return next(error);
  }
});

// API: Fetch Open Orders from Exchange
router.post('/api/exchange/fetch-open-orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { identity } = await requireFirebaseIdentity(req);
    const requestedExchange = String(req.body?.exchange || 'binance').trim().toLowerCase();

    if (!getExchangeDescriptor(requestedExchange)?.tradingApi) {
      return next(new ApiError(400, 'EXCHANGE_INVALID', 'validation', 'Exchange is invalid.', 'Exchange tidak valid.'));
    }

    const storedCredential = await loadBotCredential(identity.uid, requestedExchange);
    if (!storedCredential) {
      return next(new ApiError(409, 'EXCHANGE_CREDENTIALS_REQUIRED', 'validation', `No active ${requestedExchange} exchange credentials configured.`, 'Kredensial exchange aktif belum dikonfigurasi.'));
    }

    const client = createExchangeInstance(storedCredential.exchange, {
      apiKey: storedCredential.apiKey,
      secret: storedCredential.secret,
      password: storedCredential.password,
      isSandbox: storedCredential.isSandbox,
      binanceSandboxEnv: storedCredential.binanceSandboxEnv,
    });

    try { await ensureExchangeMarkets(client); } catch {}

    const symbol = typeof req.body?.symbol === 'string' && req.body.symbol.trim() ? req.body.symbol.trim() : undefined;
    let rawOpenOrders: any[] = [];

    if (symbol) {
      try {
        if (client.has['fetchOpenOrders']) {
          rawOpenOrders = await withExchangeRetry(storedCredential.exchange, 'fetchOpenOrders', async () => client.fetchOpenOrders(symbol));
        }
      } catch (err: any) {
        console.warn(`[CCXT] fetchOpenOrders error for ${symbol}:`, err.message);
      }
    } else {
      let fetchedDirectly = false;
      try {
        if (client.has['fetchOpenOrders']) {
          const direct = await withExchangeRetry(storedCredential.exchange, 'fetchOpenOrders', async () => client.fetchOpenOrders());
          if (Array.isArray(direct)) {
            rawOpenOrders = direct;
            fetchedDirectly = true;
          }
        }
      } catch {
        fetchedDirectly = false;
      }

      if (!fetchedDirectly) {
        let userBotSymbols: string[] = [];
        try {
          const userBotsResult = await dbQuery<{ symbol: string }>(
            `SELECT DISTINCT upper(b.symbol) as symbol
               FROM bots b
               JOIN users u ON u.id = b.user_id
              WHERE u.firebase_uid = $1`,
            [identity.uid],
          );
          userBotSymbols = userBotsResult.rows.map((r) => r.symbol).filter(Boolean);
        } catch {}

        const checkSymbols = Array.from(new Set([...userBotSymbols, 'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'DOGE/USDT'])).filter((s) => isSupportedExchangeSymbol(client, s));
        for (const s of checkSymbols) {
          try {
            const list = await withExchangeRetry(storedCredential.exchange, 'fetchOpenOrders', async () => client.fetchOpenOrders(s));
            if (Array.isArray(list)) rawOpenOrders.push(...list);
          } catch {}
        }
      }
    }

    const formattedOpenOrders = (rawOpenOrders || []).map((o: any) => {
      const price = Number(o.price || o.average || 0);
      const amount = Number(o.amount || 0);
      const filled = Number(o.filled || 0);
      const remaining = Number(o.remaining ?? (amount - filled));
      const cost = Number(o.cost || (price * amount));
      return {
        id: String(o.id || `ord-${o.timestamp || Date.now()}`),
        orderId: String(o.id || ''),
        clientOrderId: o.clientOrderId ? String(o.clientOrderId) : undefined,
        exchange: storedCredential.exchange.toUpperCase(),
        symbol: String(o.symbol || symbol || ''),
        side: (o.side || 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy',
        type: String(o.type || 'limit'),
        price,
        amount,
        filled,
        remaining,
        costUsdt: Number(cost.toFixed(2)),
        timestamp: o.timestamp || Date.now(),
        datetime: o.datetime || new Date(o.timestamp || Date.now()).toISOString(),
        status: 'open',
        isSandbox: storedCredential.isSandbox,
      };
    });

    formattedOpenOrders.sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));

    return res.json({
      success: true,
      count: formattedOpenOrders.length,
      openOrders: formattedOpenOrders,
      exchange: storedCredential.exchange,
      isSandbox: storedCredential.isSandbox,
    });
  } catch (error: any) {
    return next(error);
  }
});

// API: Cancel an Open Order on Exchange
router.post('/api/exchange/cancel-order', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { identity } = await requireFirebaseIdentity(req);
    const requestedExchange = String(req.body?.exchange || 'binance').trim().toLowerCase();
    const orderId = String(req.body?.orderId || '').trim();
    const symbol = String(req.body?.symbol || '').trim();

    if (!orderId) {
      return next(new ApiError(400, 'ORDER_ID_REQUIRED', 'validation', 'Order ID is required to cancel.', 'Order ID wajib diisi.'));
    }

    const storedCredential = await loadBotCredential(identity.uid, requestedExchange);
    if (!storedCredential) {
      return next(new ApiError(409, 'EXCHANGE_CREDENTIALS_REQUIRED', 'validation', `No active ${requestedExchange} exchange credentials configured.`, 'Kredensial exchange aktif belum dikonfigurasi.'));
    }

    const client = createExchangeInstance(storedCredential.exchange, {
      apiKey: storedCredential.apiKey,
      secret: storedCredential.secret,
      password: storedCredential.password,
      isSandbox: storedCredential.isSandbox,
      binanceSandboxEnv: storedCredential.binanceSandboxEnv,
    });

    try { await ensureExchangeMarkets(client); } catch {}

    await withExchangeRetry(storedCredential.exchange, 'cancelOrder', async () =>
      client.cancelOrder(orderId, symbol || undefined),
    );

    logAuditEvent(req, res, 'exchange.order.canceled', {
      exchange: storedCredential.exchange,
      orderId,
      symbol,
    });

    return res.json({
      success: true,
      message: `Order ${orderId} (${symbol}) berhasil dibatalkan di bursa.`,
      orderId,
      symbol,
    });
  } catch (error: any) {
    return next(error);
  }
});

// API: Real exchange market/execution verification. Never fabricates fills.
router.post('/api/exchange/test-all-coins-execution', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireFirebaseIdentity(req);
    const rawExchange = String(req.body?.exchange || 'bitget').trim();
    const desc = getExchangeDescriptor(rawExchange);
    const exchangeId = desc ? desc.id : rawExchange.toLowerCase();

    if (exchangeId === 'reku') {
      const response = await fetch('https://api.reku.id/v2/price', { headers: { Accept: 'application/json', 'User-Agent': 'GAIN-NiagaKoin/4.0.0' }, signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Reku public price HTTP ${response.status}`);
      const payload = await response.json() as any[];
      const defaultCoins = DEFAULT_PORTFOLIO_COINS;
      const priceMap = new Map<string, number>();
      if (Array.isArray(payload)) {
        for (const r of payload) {
          if (r?.cd && Number(r?.c) > 0) priceMap.set(String(r.cd).toUpperCase(), Number(r.c));
        }
      }
      const results = defaultCoins.map((coin) => {
        const p = priceMap.get(coin);
        return {
          symbol: `${coin}/IDR`,
          executable: Boolean(p && p > 0),
          executionStatus: p && p > 0 ? 'MARKET_READY' : 'MARKET_UNAVAILABLE',
          isLiveConnected: true,
          price: p || undefined,
          timestamp: Date.now(),
          latencyMs: 15,
          note: p && p > 0 ? `Market Reku (${coin}/IDR) terhubung. Read-only.` : `Symbol ${coin} tidak tersedia di Reku.`,
        };
      });
      const executableCount = results.filter((r) => r.executable).length;
      return res.json({
        success: true,
        exchange: 'REKU',
        environment: 'LIVE',
        totalVerified: results.length,
        executableCount,
        allExecutable: executableCount === results.length,
        ordersSubmitted: 0,
        summary: `Verifikasi market Reku selesai. ${executableCount}/${results.length} pair IDR tersedia; read-only.`,
        results,
      });
    }

    const { apiKey, secret, password, isSandbox = true } = req.body || {};
    const validated = sanitizeExchangeInput({ exchange: exchangeId, apiKey, secret, password, isSandbox }, { requirePassphrase: ['bitget', 'okx'].includes(exchangeId) });

    const client = createExchangeInstance(validated.exchange, validated);
    await withExchangeRetry(validated.exchange, 'verification.loadMarkets', () => client.loadMarkets());

    const defaultCoins = DEFAULT_PORTFOLIO_COINS;
    const results = [];
    for (const coin of defaultCoins) {
      const startedAt = Date.now();
      let matchedSymbol: string | null = null;
      const candidateQuotes = ['USDT', 'USDC', 'IDR', 'BIDR'];
      for (const quote of candidateQuotes) {
        const candidate = `${coin}/${quote}`;
        if (client.markets?.[candidate] && client.markets[candidate].active !== false) {
          matchedSymbol = candidate;
          break;
        }
      }

      if (!matchedSymbol && client.markets) {
        const found = Object.values(client.markets).find((m: any) =>
          m && String(m.base || '').toUpperCase() === coin && (m.spot || m.type === 'spot' || !m.type) && m.active !== false
        );
        if (found) matchedSymbol = (found as any).symbol;
      }

      if (!matchedSymbol) {
        results.push({
          symbol: `${coin}/USDT`,
          executable: false,
          executionStatus: 'MARKET_UNAVAILABLE',
          isLiveConnected: false,
          latencyMs: Date.now() - startedAt,
          note: `Symbol ${coin} tidak tersedia pada market exchange ${validated.exchange.toUpperCase()}.`,
        });
        continue;
      }

      try {
        const ticker: any = await client.fetchTicker(matchedSymbol);
        const last = Number(ticker?.last || ticker?.close || 0);
        if (!Number.isFinite(last) || last <= 0) throw new Error('ticker_unavailable');
        results.push({
          symbol: matchedSymbol,
          executable: true,
          executionStatus: 'MARKET_READY',
          isLiveConnected: true,
          price: last,
          timestamp: Number(ticker?.timestamp) || Date.now(),
          latencyMs: Date.now() - startedAt,
          note: validated.isSandbox ? `Market Testnet (${matchedSymbol}) terhubung. Read-only.` : `Market Live (${matchedSymbol}) terhubung. Read-only.`,
        });
      } catch (error: any) {
        results.push({
          symbol: matchedSymbol,
          executable: false,
          executionStatus: 'MARKET_ERROR',
          isLiveConnected: false,
          latencyMs: Date.now() - startedAt,
          note: sanitizeExchangeErrorMessage(error?.message || 'market_error', req.body),
        });
      }
    }

    const executableCount = results.filter((r) => r.executable).length;
    res.json({
      success: true,
      exchange: validated.exchange.toUpperCase(),
      environment: validated.isSandbox ? 'TESTNET' : 'LIVE',
      totalVerified: results.length,
      executableCount,
      allExecutable: executableCount === results.length,
      ordersSubmitted: 0,
      summary: `Verifikasi market nyata selesai. ${executableCount}/${results.length} pair tersedia; tidak ada simulator dan tidak ada order otomatis.`,
      results,
    });
  } catch (error: any) {
    return next(error);
  }
});

export default router;
