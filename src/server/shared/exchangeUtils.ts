import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Request } from 'express';
import ccxt from 'ccxt';
import { z } from 'zod';
import { ApiError } from './apiError';
import { EXCHANGE_REGISTRY, getExchangeDescriptor, getExchangeIds } from '../../config/exchangeRegistry';
import { SUPPORTED_COINS } from '../../data/appData';
import { MarketDataEngine } from '../../v2/engines/marketData/MarketDataEngine';
import { WebSocketManager } from '../../v2/engines/marketData/WebSocketManager';
import {
  retryBotExchangeAction,
  BotExecutionFailure,
  assertBotCredentialContext,
  isFreshPrice,
  classifyBotExecutionError,
  getRunnerFailureState,
  selectOwnedBotEntries,
  botRegistryKey,
  deriveBotRunnerId,
  buildClientOrderId,
  isBotOwnedByUid,
} from '../../services/botEngineCore';
export {
  BotExecutionFailure,
  assertBotCredentialContext,
  isFreshPrice,
  classifyBotExecutionError,
  getRunnerFailureState,
  selectOwnedBotEntries,
  botRegistryKey,
  deriveBotRunnerId,
  buildClientOrderId,
  isBotOwnedByUid,
};
import {
  getExchangeCredential,
  dbQuery,
  findExchangeIdentityOwner,
  createExchangeCertificationRun,
  updateExchangeCertificationRun,
  getLatestExchangeCertificationRun,
  createAuditEvent,
  getTwoFactorSecretRecord,
  consumeTotpCounter,
} from '../database';
import { tickerMemoryCache, botExecutionMetrics } from './serverState';
import { decryptSensitiveString, verifyServerTotp } from './cryptoUtils';
import { requireLicensedSecuritySession } from './authUtils';
import type { DcaLayer, GridLevel } from '../../v2/domain/strategy/types';

export const v2MarketDataEngine = new MarketDataEngine();
export const v2WebSocketManager = new WebSocketManager(v2MarketDataEngine);
export const TICKER_CACHE_TTL_MS = 20000; // 20s TTL
export const BOT_PRICE_MAX_AGE_MS = 10000;

export const SUPPORTED_EXCHANGES = new Set(getExchangeIds());
export const DEFAULT_PORTFOLIO_COINS = SUPPORTED_COINS.map((coin) => coin.coin.toUpperCase());
export const DEFAULT_PORTFOLIO_PAIRS = SUPPORTED_COINS.map((coin) => coin.pair.toUpperCase());
export const EXCHANGE_RETRY_ATTEMPTS = 2;
export const EXCHANGE_TIMEOUT_MS = 15000;
export const BOT_ORDER_RETRY_ATTEMPTS = 3;

export const circuitBreakerMap = new Map<string, { failures: number; openedAt: number; cooldownMs: number }>();
export const marketsMemoryCache = new Map<string, { markets: any[]; timestamp: number }>();
export const MARKETS_CACHE_TTL_MS = 60000; // 60s TTL

export let runtimeLiveTradingEnabled = process.env.LIVE_TRADING_ENABLED === 'true';
export function setRuntimeLiveTradingEnabled(val: boolean) {
  runtimeLiveTradingEnabled = val;
}
export const LIVE_TRADING_TESTNET_ONLY = process.env.LIVE_TRADING_TESTNET_ONLY !== 'false';
export const GAIN_V2_ENABLED = process.env.GAIN_V2_ENABLED === 'true';

export function positiveEnvLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const V2_MARKET_DATA_MAX_AGE_MS = positiveEnvLimit('BOT_MARKET_DATA_MAX_AGE_MS', 10000);
export const MAX_USER_DAILY_LOSS_USDT = positiveEnvLimit('BOT_MAX_USER_DAILY_LOSS_USDT', 50);
export const MAX_BOT_EXPOSURE_USDT = positiveEnvLimit('BOT_MAX_EXPOSURE_USDT', 250);
export const V2_MAX_COMMITTED_CAPITAL_USDT = positiveEnvLimit('BOT_MAX_COMMITTED_CAPITAL_USDT', MAX_BOT_EXPOSURE_USDT);
export const BOT_FAILURE_PAUSE_THRESHOLD = positiveEnvLimit('BOT_FAILURE_PAUSE_THRESHOLD', 3);
export const BOT_RECONCILIATION_INTERVAL_MS = positiveEnvLimit('BOT_RECONCILIATION_INTERVAL_MS', 15000);

export function tickerCacheKey(exchange: string, symbol: string, isSandbox = false): string {
  return `${exchange.trim().toLowerCase()}:${isSandbox ? 'sandbox:' : ''}${symbol.trim().toUpperCase()}`;
}

export async function ensureExchangeMarkets(client: any): Promise<void> {
  if (!client || typeof client.loadMarkets !== 'function') return;
  if (!client.markets || Object.keys(client.markets).length === 0) {
    await client.loadMarkets();
  }
}

export function isSupportedExchangeSymbol(client: any, symbol: string): boolean {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return false;
  if (!client?.markets) return true;
  return Boolean(client.markets[normalized]);
}

export function withTimeout<T>(operation: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(reason)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

export async function withBotExchangeRetry<T>(operation: () => Promise<T>, timeoutMs: number, timeoutReason: string, botOrderRetryAttempts = BOT_ORDER_RETRY_ATTEMPTS): Promise<T> {
  return retryBotExchangeAction(
    () => withTimeout(operation(), timeoutMs, timeoutReason),
    botOrderRetryAttempts,
    (attempt) => new Promise((resolve) => setTimeout(resolve, 400 * (2 ** (attempt - 1)) + randomInt(0, 250)))
  );
}

export function extractExchangeClientOrderId(order: any): string {
  return String(
    order?.clientOrderId
      || order?.clientOrderID
      || order?.info?.clientOrderId
      || order?.info?.origClientOrderId
      || order?.info?.clientOrderID
      || ''
  );
}

export async function findBotExchangeOrderByClientOrderId(
  client: any,
  symbol: string,
  clientOrderId: string,
): Promise<{ found: true; order: any } | { found: false }> {
  if (String(client?.id || '').toLowerCase() === 'binance') {
    try {
      const order = await withTimeout(
        client.fetchOrder('0', symbol, { origClientOrderId: clientOrderId }),
        EXCHANGE_TIMEOUT_MS,
        'exchange_client_order_lookup_timeout',
      );
      return { found: true, order };
    } catch (error) {
      const message = String((error as any)?.message || error).toLowerCase();
      const name = String((error as any)?.name || '').toLowerCase();
      if (!/order.*not.*found|unknown order|notfound/.test(`${name} ${message}`)) {
        throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
      }
    }
  }

  try {
    const openOrdersResult = await withTimeout(
      client.fetchOpenOrders(symbol),
      EXCHANGE_TIMEOUT_MS,
      'exchange_open_order_lookup_timeout',
    );
    const openOrders = (Array.isArray(openOrdersResult) ? openOrdersResult : []) as any[];
    const openMatch = openOrders.find((order: any) => extractExchangeClientOrderId(order) === clientOrderId);
    if (openMatch) return { found: true, order: openMatch };
  } catch {
    throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
  }

  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (client?.has?.fetchClosedOrders) {
    try {
      const closedResult = await withTimeout(
        client.fetchClosedOrders(symbol, since, 200),
        EXCHANGE_TIMEOUT_MS,
        'exchange_closed_order_lookup_timeout',
      );
      const closedOrders = (Array.isArray(closedResult) ? closedResult : []) as any[];
      const closedMatch = closedOrders.find((order: any) => extractExchangeClientOrderId(order) === clientOrderId);
      if (closedMatch) return { found: true, order: closedMatch };
    } catch (error) {
      const message = String((error as any)?.message || error).toLowerCase();
      if (!/not supported|unsupported|method.*not.*available|has.*false/.test(message)) {
        throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
      }
    }
  }

  if (client?.has?.fetchOrders) {
    try {
      const ordersResult = await withTimeout(
        client.fetchOrders(symbol, since, 200),
        EXCHANGE_TIMEOUT_MS,
        'exchange_order_history_lookup_timeout',
      );
      const orders = (Array.isArray(ordersResult) ? ordersResult : []) as any[];
      const historicalMatch = orders.find((order: any) => extractExchangeClientOrderId(order) === clientOrderId);
      if (historicalMatch) return { found: true, order: historicalMatch };
      return { found: false };
    } catch {
      throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
    }
  }

  throw new BotExecutionFailure('ORDER_STATUS_UNCERTAIN', false);
}

export function registerExchangeSuccess(exchange: string): void {
  circuitBreakerMap.delete(exchange.trim().toLowerCase());
}

export function applyCircuitBreaker(exchange: string): boolean {
  const state = circuitBreakerMap.get(exchange);
  if (!state) return true;

  const now = Date.now();
  if (now - state.openedAt >= state.cooldownMs) {
    circuitBreakerMap.delete(exchange);
    return true;
  }

  return false;
}

export function registerExchangeFailure(exchange: string): void {
  const current = circuitBreakerMap.get(exchange) ?? { failures: 0, openedAt: 0, cooldownMs: 30000 };
  const failures = current.failures + 1;

  if (failures >= 3) {
    circuitBreakerMap.set(exchange, { failures, openedAt: Date.now(), cooldownMs: 30000 });
    return;
  }

  circuitBreakerMap.set(exchange, { failures, openedAt: current.openedAt || Date.now(), cooldownMs: 30000 });
}

export function assertRealExchangeCredentials(apiKey: string, secret: string): void {
  const key = apiKey.trim().toLowerCase();
  const sec = secret.trim().toLowerCase();
  if (key.includes('demo') || key.includes('dummy') || sec.includes('demo') || sec.includes('dummy')) {
    throw new ApiError(400, 'DEMO_CREDENTIALS_REJECTED', 'validation', 'Demo or dummy exchange credentials are not accepted.', 'Kredensial demo/dummy tidak diterima. Gunakan API key Testnet atau Live yang benar-benar diterbitkan exchange.');
  }
}

export function sanitizeExchangeInput(input: any, options?: { requirePassphrase?: boolean }): {
  exchange: string;
  apiKey: string;
  secret: string;
  password: string;
  isSandbox: boolean;
  binanceSandboxEnv?: 'vision' | 'demo';
  dcaLayers?: DcaLayer[];
  gridLevels?: GridLevel[];
  committedCapitalUsd?: number;
  closedLayerIds?: string[];
} {
  const rawExchange = String(input?.exchange ?? 'bitget').trim();
  const descriptor = getExchangeDescriptor(rawExchange);
  const exchange = descriptor ? descriptor.id : rawExchange.toLowerCase();

  if (!descriptor || !SUPPORTED_EXCHANGES.has(exchange)) {
    throw new Error(`Exchange "${rawExchange}" tidak didukung pada server.`);
  }

  if (!descriptor.authenticatedApi || !descriptor.ccxtId) {
    throw new ApiError(409, 'EXCHANGE_NATIVE_API_REQUIRED', 'exchange', `Exchange ${descriptor.name} does not expose a verified authenticated adapter.`, `Exchange ${descriptor.name} saat ini hanya dapat diuji melalui certification/read-only adapter.`);
  }

  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
  const secret = typeof input?.secret === 'string' ? input.secret.trim() : '';
  const password = typeof input?.password === 'string' ? input.password.trim() : '';
  const isSandbox = input?.isSandbox === true || input?.isSandbox === 'true';

  if (!apiKey || !secret) {
    throw new ApiError(400, 'EXCHANGE_CREDENTIALS_REQUIRED', 'validation', 'Exchange API credentials are required.', 'API Key dan Secret Key wajib diisi.');
  }

  if (apiKey.length < 8 || secret.length < 8) {
    throw new ApiError(400, 'EXCHANGE_CREDENTIALS_INVALID', 'validation', 'Exchange API credentials have an invalid format.', 'Format API Key atau Secret Key tidak valid.');
  }

  assertRealExchangeCredentials(apiKey, secret);

  const needsPassphrase = options?.requirePassphrase ?? descriptor.requiresPassphrase;
  if (needsPassphrase && !password) {
    throw new ApiError(400, 'EXCHANGE_PASSPHRASE_REQUIRED', 'validation', `Exchange ${exchange.toUpperCase()} requires an API passphrase.`, `Exchange ${exchange.toUpperCase()} memerlukan Passphrase API.`);
  }

  const binanceSandboxEnv = input?.binanceSandboxEnv === 'demo' ? 'demo' : input?.binanceSandboxEnv === 'vision' ? 'vision' : undefined;

  return { exchange, apiKey, secret, password, isSandbox, binanceSandboxEnv };
}

export function safeExchangeLog(label: string, meta: Record<string, any>) {
  const safeMeta = { ...meta };
  if ('apiKey' in safeMeta) safeMeta.apiKey = safeMeta.apiKey ? '[REDACTED]' : undefined;
  if ('secret' in safeMeta) safeMeta.secret = safeMeta.secret ? '[REDACTED]' : undefined;
  if ('password' in safeMeta) safeMeta.password = safeMeta.password ? '[REDACTED]' : undefined;
  console.warn(`[${label}]`, safeMeta);
}

export function isExchangeSymbolError(error: any): boolean {
  const message = String(error?.message || error || '').toLowerCase();
  const name = String(error?.name || '').toLowerCase();
  return /does not have market symbol|bad symbol|market.*not.*found|symbol.*not.*found|invalid symbol|unknown symbol/.test(`${name} ${message}`);
}

export function isDeterministicExchangeInputError(error: any): boolean {
  const message = String(error?.message || error || '').toLowerCase();
  const name = String(error?.name || '').toLowerCase();
  return isExchangeSymbolError(error)
    || /requires? .*symbol|symbol .*required|missing .*symbol|argument .*required|parameter .*required|invalid argument|invalid parameter/.test(`${name} ${message}`)
    || /passphrase|ok-access-passphrase|50105|api.?key|apikey|secret|signature|unauthorized|authentication|-2015|50100|50111|invalid credentials/.test(`${name} ${message}`);
}

export function withExchangeRetry<T>(exchange: string, label: string, action: () => Promise<T>): Promise<T> {
  return (async () => {
    let lastError: any;

    for (let attempt = 1; attempt <= EXCHANGE_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const result = await action();
        registerExchangeSuccess(exchange);
        return result;
      } catch (error: any) {
        lastError = error;
        safeExchangeLog(`${label}:retry`, {
          exchange,
          attempt,
          message: sanitizeErrorMessage(error?.message || 'exchange_error'),
        });

        if (isDeterministicExchangeInputError(error)) throw error;

        if (attempt < EXCHANGE_RETRY_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
        }
      }
    }

    throw lastError ?? new Error(`${label} failed`);
  })();
}

export const BotCredentialSchema = z.object({
  exchange: z.preprocess(
    (val) => String(val || '').trim().toLowerCase(),
    z.enum(['binance', 'bitget', 'okx', 'bybit', 'indodax', 'tokocrypto'])
  ),
  apiKey: z.string().trim().min(8).max(512),
  secret: z.string().trim().min(8).max(512),
  password: z.string().max(512).optional(),
  isSandbox: z.boolean().default(true),
  binanceSandboxEnv: z.enum(['vision', 'demo']).optional(),
});

export function getBotCredentialEncryptionKey(): Buffer {
  const configuredKey = process.env.ENCRYPTION_MASTER_KEY || '';
  const key = Buffer.from(configuredKey, 'utf8');
  if (key.length !== 32) {
    throw new ApiError(503, 'CREDENTIAL_ENCRYPTION_NOT_CONFIGURED', 'configuration', 'A 32-byte credential encryption key is required.', 'Penyimpanan kredensial bot belum dikonfigurasi oleh administrator.');
  }
  return key;
}

export function encryptBotCredential(credential: z.infer<typeof BotCredentialSchema>) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getBotCredentialEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), 'utf8'),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    updatedAt: Date.now(),
  };
}

export function decryptBotCredential(record: { iv: string; authTag: string; ciphertext: string }): z.infer<typeof BotCredentialSchema> {
  const decipher = createDecipheriv('aes-256-gcm', getBotCredentialEncryptionKey(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return BotCredentialSchema.parse(JSON.parse(plaintext));
}

export async function loadBotCredential(uid: string, exchange: string): Promise<z.infer<typeof BotCredentialSchema> | null> {
  const record = await getExchangeCredential(uid, exchange.toLowerCase());
  if (!record) return null;
  return decryptBotCredential({ iv: record.iv, authTag: record.auth_tag, ciphertext: record.ciphertext });
}

export function createExchangeInstance(
  exchangeName: string,
  credentials?: { apiKey?: string; secret?: string; password?: string; isSandbox?: boolean; binanceSandboxEnv?: 'vision' | 'demo' }
) {
  const safeExchange = exchangeName.toLowerCase().trim();
  const descriptor = getExchangeDescriptor(safeExchange);
  if (!descriptor) {
    throw new Error(`Exchange "${exchangeName}" tidak didukung pada server.`);
  }
  if (!descriptor.ccxtId) {
    throw new ApiError(409, 'EXCHANGE_NATIVE_ADAPTER_REQUIRED', 'exchange', `Exchange ${descriptor.name} requires its native API adapter.`, `Exchange ${descriptor.name} belum memiliki adapter native trading di GAIN.`);
  }

  const normalized = descriptor.ccxtId;
  const exchangeClass = (ccxt as Record<string, any>)[normalized];

  if (!exchangeClass) {
    throw new Error(`Exchange "${exchangeName}" is not supported by ccxt.`);
  }

  const options: Record<string, any> = {
    enableRateLimit: true,
    timeout: 15000, // Increased timeout for slower testnet endpoints
    options: {
      adjustForTimeDifference: safeExchange !== 'okx', // Disable on OKX to avoid public/time ECONNRESET; use system time
      recvWindow: 10000, // 10s receive window for international cloud latency
      defaultType: 'spot',
      fetchMarkets: {
        types: ['spot'],
        loadAllOptions: false,
      },
    },
  };

  // Egress Proxy Gateway Support (for local development or restricted ISP environments)
  const proxyUrl = String(
    process.env.EXCHANGE_PROXY_URL
    || process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || ''
  ).trim();

  if (proxyUrl) {
    options.httpsProxy = proxyUrl;
    options.proxy = proxyUrl;
    if (proxyUrl.startsWith('socks')) {
      options.socksProxy = proxyUrl;
    }
  }

  if (safeExchange === 'binance') {
    options.options.fetchMarkets = {
      types: ['spot'],
      loadAllOptions: false,
    };
    if (!credentials?.isSandbox) {
      // Bypass internet positif block using Binance's official alternate hostname
      options.hostname = 'api4.binance.com';
    }
    const binanceGateway = process.env.BINANCE_API_URL || process.env.EXCHANGE_BINANCE_GATEWAY;
    if (binanceGateway) {
      options.urls = {
        ...(options.urls || {}),
        api: {
          spot: binanceGateway,
          wapi: binanceGateway,
          sapi: binanceGateway,
        },
      };
    }
  } else if (safeExchange === 'okx') {
    options.options.defaultType = 'spot';
    options.options.adjustForTimeDifference = false;
    options.options.fetchMarkets = {
      types: ['spot'],
      loadAllOptions: false,
    };
    const okxGateway = process.env.OKX_API_URL || process.env.EXCHANGE_OKX_GATEWAY;
    if (okxGateway) {
      options.urls = {
        ...(options.urls || {}),
        api: { rest: okxGateway },
        test: { rest: okxGateway },
        www: okxGateway,
      };
    }
  }

  if (credentials?.apiKey) options.apiKey = credentials.apiKey.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (credentials?.secret) options.secret = credentials.secret.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (credentials?.password) options.password = credentials.password.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');

  if (credentials?.isSandbox) {
    const descriptor = getExchangeDescriptor(safeExchange);
    if (descriptor && !descriptor.hasOfficialSandbox) {
      throw new ApiError(400, 'SANDBOX_NOT_SUPPORTED', 'validation', `Exchange ${safeExchange} does not have an official sandbox/demo environment.`, `Exchange ${safeExchange} tidak menyediakan sandbox/demo resmi.`);
    }
    options.headers = {
      ...(options.headers || {}),
      ...(safeExchange === 'bitget' ? { paptrading: '1' } : {}),
      ...(safeExchange === 'okx' ? { 'x-simulated-trading': '1' } : {}),
    };
  }

  const instance = new exchangeClass(options);

  if (credentials?.isSandbox) {
    if (safeExchange === 'binance' && credentials?.binanceSandboxEnv === 'demo') {
      if (typeof instance.enableDemoTrading === 'function') {
        instance.enableDemoTrading(true);
      } else if (instance.urls && instance.urls['demo']) {
        instance.urls['api'] = { ...instance.urls['api'], ...instance.urls['demo'] };
      }
    } else {
      try {
        if (typeof instance.setSandboxMode === 'function') {
          instance.setSandboxMode(true);
        }
      } catch {
        if (instance.urls && instance.urls['test']) {
          instance.urls['api'] = instance.urls['test'];
        }
      }
    }
  } else if (safeExchange === 'binance' || safeExchange === 'tokocrypto') {
    // Deep replace api.binance.com with api4.binance.com to bypass Internet Positif
    if (instance.urls) {
      const replaceUrls = (obj: any) => {
        if (!obj) return;
        for (const key of Object.keys(obj)) {
          if (typeof obj[key] === 'string') {
            obj[key] = obj[key].replace(/api\.binance\.com/g, 'api4.binance.com');
          } else if (typeof obj[key] === 'object') {
            replaceUrls(obj[key]);
          }
        }
      };
      if (instance.urls.api) replaceUrls(instance.urls.api);
      if (instance.urls.public) replaceUrls(instance.urls.public);
    }
  }

  return instance;
}

export async function fetchBinancePublicSpotPrices(
  symbols: string[],
  isSandbox: boolean,
): Promise<Record<string, { last: number; percentage: number; timestamp: number; source: string; quoteCurrency: string }>> {
  const baseUrls = isSandbox
    ? ['https://testnet.binance.vision', 'https://api1.testnet.binance.vision']
    : ['https://data-api.binance.vision', 'https://api4.binance.com'];
  const normalizedSymbols = symbols.map((symbol) => symbol.replace('/', '').toUpperCase());
  const result: Record<string, { last: number; percentage: number; timestamp: number; source: string; quoteCurrency: string }> = {};

  for (const rawSymbol of normalizedSymbols) {
    let resolved: { last: number; percentage: number; timestamp: number; source: string } | null = null;
    for (const baseUrl of baseUrls) {
      for (const path of ['/api/v3/ticker/24hr', '/api/v3/ticker/price']) {
        try {
          const url = `${baseUrl}${path}?symbol=${encodeURIComponent(rawSymbol)}`;
          const response = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(4500),
          });
          if (!response.ok) continue;
          const row = await response.json() as Record<string, unknown>;
          const last = Number(row?.lastPrice ?? row?.price ?? 0);
          if (!Number.isFinite(last) || last <= 0) continue;
          resolved = {
            last,
            percentage: Number(row?.priceChangePercent ?? 0) || 0,
            timestamp: Date.now(),
            source: `binance-public-rest:${new URL(baseUrl).hostname}`,
          };
          break;
        } catch {
        }
      }
      if (resolved) break;
    }

    if (!resolved) continue;
    const slashPair = rawSymbol.endsWith('USDT') ? `${rawSymbol.slice(0, -4)}/USDT` : rawSymbol;
    result[slashPair] = {
      last: resolved.last,
      percentage: resolved.percentage,
      timestamp: resolved.timestamp,
      source: resolved.source,
      quoteCurrency: slashPair.endsWith('/USDT') ? 'USDT' : 'UNKNOWN',
    };
  }

  if (Object.keys(result).length === 0) {
    throw new Error(`Binance ${isSandbox ? 'Testnet' : 'public'} ticker fallback returned no usable prices`);
  }
  return result;
}

export async function fetchRekuPublicPrices(symbols: string[]): Promise<Record<string, { last: number; percentage: number; timestamp: number; source: string; quoteCurrency: string }>> {
  const response = await fetch('https://api.reku.id/v2/price', {
    headers: { Accept: 'application/json', 'User-Agent': 'GAIN-NiagaKoin/4.0.0' },
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Reku public price HTTP ${response.status}`);
  const payload = await response.json() as any;
  if (!Array.isArray(payload)) throw new Error('Reku public price response is not an array');

  const wanted = new Set(symbols.map((symbol) => symbol.split('/')[0].toUpperCase()));
  const result: Record<string, { last: number; percentage: number; timestamp: number; source: string; quoteCurrency: string }> = {};
  for (const row of payload) {
    const base = String(row?.cd || '').toUpperCase();
    const last = Number(row?.c || 0);
    if (!base || !(last > 0) || !wanted.has(base)) continue;
    const pair = `${base}/IDR`;
    result[pair] = {
      last,
      percentage: Number(row?.cp || 0),
      timestamp: Date.now(),
      source: 'reku-public-api',
      quoteCurrency: 'IDR',
    };
  }
  return result;
}

export async function extractPortfolioAndValuation(
  client: any,
  balance: any,
  exchangeName: string = 'exchange',
  isSandbox = false
): Promise<{
  currencies: Record<string, { free: number; used: number; total: number }>;
  portfolioAssets: Array<{
    coin: string;
    pair: string;
    free: number;
    used: number;
    total: number;
    price: number;
    change24h: number;
    valueUsdt: number;
    valuationStatus: 'VALUED' | 'PRICE_UNAVAILABLE';
  }>;
  usdtBalance: number;
  usdtAvailable: number;
  usdtTotalBalance: number;
  totalPortfolioUsdt: number;
  rawAssetCount: number;
  unvaluedDefaultAssetCount: number;
  valuationScope: 'DEFAULT_12_COINS';
}> {
  const currencies: Record<string, { free: number; used: number; total: number }> = {};
  const portfolioAssets: Array<{
    coin: string;
    pair: string;
    free: number;
    used: number;
    total: number;
    price: number;
    change24h: number;
    valueUsdt: number;
    valuationStatus: 'VALUED' | 'PRICE_UNAVAILABLE';
  }> = [];

  if (balance?.total) {
    for (const [currRaw, totalVal] of Object.entries(balance.total)) {
      const curr = String(currRaw).toUpperCase();
      const total = Number(totalVal);
      if (!Number.isFinite(total) || total <= 0) continue;
      const free = Number(balance.free?.[currRaw] ?? balance.free?.[curr] ?? 0);
      const used = Number(balance.used?.[currRaw] ?? balance.used?.[curr] ?? 0);
      currencies[curr] = { free: Number.isFinite(free) ? free : 0, used: Number.isFinite(used) ? used : 0, total };
    }
  }

  const defaultCoins = new Set(DEFAULT_PORTFOLIO_COINS);
  const nonZeroRawCurrencies = Object.entries(currencies).filter(([coin, item]) => coin !== 'USDT' && item.total > 0);
  const rawAssetCount = nonZeroRawCurrencies.length;
  let totalCoinValueUsdt = 0;
  let unvaluedDefaultAssetCount = 0;

  // Resolve active USDT/IDR rate early for accurate IDR-denominated valuation
  let usdtIdrRate = 16000;
  try {
    if (client?.markets && isSupportedExchangeSymbol(client, 'USDT/IDR')) {
      const usdtIdrTicker = await Promise.race([
        client.fetchTicker('USDT/IDR'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1800)),
      ]);
      if (Number(usdtIdrTicker?.last) > 0) {
        usdtIdrRate = Number(usdtIdrTicker.last);
      }
    }
  } catch {}

  for (const configuredCoin of SUPPORTED_COINS) {
    const coin = configuredCoin.coin.toUpperCase();
    const defaultPair = configuredCoin.pair.toUpperCase();
    if (!defaultCoins.has(coin)) continue;
    const item = currencies[coin];
    if (!item || item.total <= 0) continue;

    let price = 0;
    let change24h = 0;
    const isDirectUsdt = isSupportedExchangeSymbol(client, defaultPair);
    const isIdrQuote = !isDirectUsdt && isSupportedExchangeSymbol(client, `${coin}/IDR`);
    const activePair = isIdrQuote ? `${coin}/IDR` : defaultPair;

    const cacheKey = tickerCacheKey(exchangeName, activePair, isSandbox);
    const cached = tickerMemoryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < TICKER_CACHE_TTL_MS) {
      const rawPrice = Number(cached.last || 0);
      price = cached.quoteCurrency === 'IDR' && usdtIdrRate > 0 ? (rawPrice / usdtIdrRate) : rawPrice;
      change24h = Number(cached.percentage || 0);
    } else {
      try {
        if (!isSupportedExchangeSymbol(client, activePair)) throw new Error('SYMBOL_UNSUPPORTED');
        const ticker = await Promise.race([
          client.fetchTicker(activePair),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Ticker timeout')), 1800)),
        ]);
        const rawPrice = Number((ticker as any)?.last || 0);
        change24h = Number((ticker as any)?.percentage || 0);
        price = isIdrQuote && usdtIdrRate > 0 ? (rawPrice / usdtIdrRate) : rawPrice;
        if (rawPrice > 0) {
          tickerMemoryCache.set(cacheKey, {
            last: rawPrice,
            percentage: change24h,
            timestamp: Date.now(),
            source: exchangeName,
            quoteCurrency: isIdrQuote ? 'IDR' : 'USDT',
          });
        }
      } catch {
        // Fallback to Binance public spot price if exchange ticker was unavailable
        try {
          const publicTickers = await fetchBinancePublicSpotPrices([defaultPair], isSandbox);
          const publicTicker = publicTickers[defaultPair];
          price = Number(publicTicker?.last || 0);
          change24h = Number(publicTicker?.percentage || 0);
        } catch {
          price = 0;
          change24h = 0;
        }
      }
    }

    const valueUsdt = Number((item.total * price).toFixed(2));
    const valuationStatus = price > 0 ? 'VALUED' : 'PRICE_UNAVAILABLE';
    if (valuationStatus === 'PRICE_UNAVAILABLE') unvaluedDefaultAssetCount += 1;
    else totalCoinValueUsdt += valueUsdt;

    portfolioAssets.push({
      coin,
      pair: defaultPair,
      free: item.free,
      used: item.used,
      total: item.total,
      price,
      change24h,
      valueUsdt,
      valuationStatus,
    });
  }

  let usdtTotalBalance = Number(currencies.USDT?.total ?? 0);
  let usdtAvailable = Number(currencies.USDT?.free ?? 0);

  const idrTotalBalance = Number(currencies.IDR?.total ?? 0);
  const idrAvailable = Number(currencies.IDR?.free ?? 0);

  if (idrTotalBalance > 0) {
    const idrTotalInUsdt = idrTotalBalance / usdtIdrRate;
    const idrFreeInUsdt = idrAvailable / usdtIdrRate;

    usdtTotalBalance = Number((usdtTotalBalance + idrTotalInUsdt).toFixed(2));
    usdtAvailable = Number((usdtAvailable + idrFreeInUsdt).toFixed(2));
  }

  const usdtBalance = usdtTotalBalance;
  const totalPortfolioUsdt = Number((usdtTotalBalance + totalCoinValueUsdt).toFixed(2));

  return {
    currencies,
    portfolioAssets,
    usdtBalance,
    usdtAvailable,
    usdtTotalBalance,
    totalPortfolioUsdt,
    rawAssetCount,
    unvaluedDefaultAssetCount,
    valuationScope: 'DEFAULT_12_COINS',
  };
}

export const EXCHANGE_CERT_STAGES = new Set([
  'authenticated_readonly',
  'sandbox_demo_order',
  'micro_live_order',
  'reconcile',
  'recovery',
]);
export const EXCHANGE_CERT_MAX_DEMO_NOTIONAL = positiveEnvLimit('EXCHANGE_CERT_MAX_DEMO_NOTIONAL', 10);
export const EXCHANGE_CERT_MAX_LIVE_NOTIONAL = positiveEnvLimit('EXCHANGE_CERT_MAX_LIVE_NOTIONAL', 5);
export const EXCHANGE_CERT_MAX_LIVE_NOTIONAL_IDR = positiveEnvLimit('EXCHANGE_CERT_MAX_LIVE_NOTIONAL_IDR', 50000);
export const EXCHANGE_CERT_MICRO_LIVE_ENABLED = process.env.EXCHANGE_CERT_MICRO_LIVE_ENABLED === 'true';
export const EXCHANGE_CERT_MICRO_LIVE_CONFIRM = 'I_UNDERSTAND_MICRO_LIVE_CERTIFICATION';

export type ExchangeCertificationStage = 'authenticated_readonly' | 'sandbox_demo_order' | 'micro_live_order' | 'reconcile' | 'recovery';

export function certificationModeForStage(stage: ExchangeCertificationStage): 'READ_ONLY' | 'SANDBOX_DEMO' | 'MICRO_LIVE' | 'RECONCILE' | 'RECOVERY' {
  if (stage === 'authenticated_readonly') return 'READ_ONLY';
  if (stage === 'sandbox_demo_order') return 'SANDBOX_DEMO';
  if (stage === 'micro_live_order') return 'MICRO_LIVE';
  if (stage === 'reconcile') return 'RECONCILE';
  return 'RECOVERY';
}

export function certificationPreferredSymbols(descriptor: ReturnType<typeof getExchangeDescriptor>): string[] {
  if (!descriptor) return ['BTC/USDT', 'BTC/USDC', 'BTC/USD', 'BTC/IDR'];
  const quotes = descriptor.quoteCurrencies || [];
  const preferred: string[] = [];
  for (const quote of quotes) preferred.push(`BTC/${quote}`);
  preferred.push('BTC/USDT', 'BTC/USDC', 'BTC/USD', 'BTC/IDR');
  return [...new Set(preferred)];
}

export function certificationDefaultNotional(quote: string, live: boolean): number {
  if (live && quote.toUpperCase() === 'IDR') return EXCHANGE_CERT_MAX_LIVE_NOTIONAL_IDR;
  return live ? EXCHANGE_CERT_MAX_LIVE_NOTIONAL : EXCHANGE_CERT_MAX_DEMO_NOTIONAL;
}

export async function buildCertificationOrderPlan(client: any, descriptor: ReturnType<typeof getExchangeDescriptor>, live: boolean) {
  const symbol = certificationPreferredSymbols(descriptor).find((candidate) => Boolean(client.markets?.[candidate]));
  if (!symbol) throw new ApiError(409, 'CERTIFICATION_SYMBOL_UNAVAILABLE', 'exchange', 'No supported BTC spot certification symbol is available.', 'Pair BTC untuk certification tidak tersedia di exchange ini.');
  const market = client.markets[symbol];
  const quote = String(market.quote || 'USDT').toUpperCase();
  const ticker: any = await withExchangeRetry(descriptor?.id || 'exchange', 'certification.fetchTicker', () => client.fetchTicker(symbol));
  const reference = Number(ticker?.bid || ticker?.last || ticker?.ask || 0);
  if (!(reference > 0)) throw new ApiError(409, 'CERTIFICATION_MARKET_PRICE_REQUIRED', 'exchange', 'A valid market price is required for certification.', 'Harga market exchange belum tersedia untuk certification.');

  const rawPrice = reference * 0.95;
  const price = Number(client.priceToPrecision(symbol, rawPrice));
  const configuredCap = certificationDefaultNotional(quote, live);
  const minCost = Number(market?.limits?.cost?.min || 0);
  const minAmount = Number(market?.limits?.amount?.min || 0);
  let desiredNotional = configuredCap;
  if (minCost > desiredNotional) {
    if (live) {
      throw new ApiError(409, 'CERTIFICATION_MIN_NOTIONAL_TOO_HIGH', 'exchange', `The exchange minimum cost (${minCost}) exceeds the configured live certification cap (${configuredCap}).`, 'Minimum order exchange lebih besar daripada batas micro-order yang dikonfigurasi.');
    }
    desiredNotional = minCost;
  }
  let amount = desiredNotional / price;
  if (minAmount > amount) amount = minAmount;
  amount = Number(client.amountToPrecision(symbol, amount));
  const notional = amount * price;
  if (!(amount > 0) || !(notional > 0)) throw new ApiError(409, 'CERTIFICATION_AMOUNT_INVALID', 'exchange', 'Unable to derive a valid certification quantity.', 'Jumlah order certification tidak valid.');
  if (live && notional > configuredCap * 1.001) {
    throw new ApiError(409, 'CERTIFICATION_LIVE_CAP_EXCEEDED', 'security', 'Certification order exceeds the configured live notional cap.', 'Nilai micro-live order melebihi batas yang dikonfigurasi.');
  }
  return { symbol, quote, price, amount, notional, minCost, minAmount, reference, side: 'buy' as const };
}

export async function fetchCertificationOrder(client: any, symbol: string, exchangeOrderId: string) {
  if (!client.has?.fetchOrder) throw new ApiError(409, 'CERTIFICATION_ORDER_QUERY_UNSUPPORTED', 'exchange', 'This exchange adapter does not expose fetchOrder.', 'Exchange belum mendukung query order untuk certification.');
  return withExchangeRetry('certification', 'fetchOrder', () => client.fetchOrder(exchangeOrderId, symbol));
}

export async function runAuthenticatedReadOnlyCertification(uid: string, exchange: string) {
  const descriptor = getExchangeDescriptor(exchange);
  if (!descriptor || !descriptor.ccxtId || !descriptor.authenticatedApi) throw new ApiError(409, 'EXCHANGE_NATIVE_API_REQUIRED', 'exchange', 'Authenticated certification is not available for this exchange.', 'Authenticated API certification belum tersedia untuk exchange ini.');
  const storedCredential = await loadBotCredential(uid, exchange);
  if (!storedCredential) throw new ApiError(409, 'EXCHANGE_CREDENTIALS_REQUIRED', 'authorization', 'No active exchange credentials are configured.', 'Credential exchange aktif belum dikonfigurasi.');
  const client = createExchangeInstance(exchange, storedCredential);
  const startedAt = Date.now();
  const run = await createExchangeCertificationRun({ firebaseUid: uid, exchange, stage: 'authenticated_readonly', mode: 'READ_ONLY' });
  try {
    await withExchangeRetry(exchange, 'certification.loadMarkets', () => client.loadMarkets());
    const plan = await buildCertificationOrderPlan(client, descriptor, false);
    const ticker: any = await withExchangeRetry(exchange, 'certification.fetchTicker', () => client.fetchTicker(plan.symbol));
    const balance = await withExchangeRetry(exchange, 'certification.fetchBalance', () => client.fetchBalance());
    const openOrders = client.has?.fetchOpenOrders ? await withExchangeRetry(exchange, 'certification.fetchOpenOrders', () => client.fetchOpenOrders(plan.symbol)) : [];
    const result = {
      marketData: true,
      ticker: Number(ticker?.last) > 0,
      authenticated: true,
      balance: Boolean((balance as { total?: unknown } | null | undefined)?.total),
      ordersRead: client.has?.fetchOpenOrders ? true : false,
      symbol: plan.symbol,
      quote: plan.quote,
      openOrdersCount: Array.isArray(openOrders) ? openOrders.length : 0,
      latencyMs: Date.now() - startedAt,
      noOrdersSubmitted: true,
    };
    const pass = result.marketData && result.ticker && result.authenticated && result.balance;
    await updateExchangeCertificationRun(run.id, { status: pass ? 'PASS' : 'FAIL', result });
    await createAuditEvent({ firebaseUid: uid, eventType: 'exchange.certification.authenticated_readonly', payload: { exchange, status: pass ? 'PASS' : 'FAIL', symbol: plan.symbol } });
    return { success: pass, exchange, stage: 'authenticated_readonly', mode: 'READ_ONLY', status: pass ? 'PASS' : 'FAIL', result };
  } catch (error) {
    await updateExchangeCertificationRun(run.id, { status: 'FAIL', result: { error: String((error as any)?.code || (error as any)?.message || error).slice(0, 240), latencyMs: Date.now() - startedAt } });
    throw error;
  }
}

export async function runSandboxDemoOrderCertification(uid: string, exchange: string) {
  const descriptor = getExchangeDescriptor(exchange);
  if (!descriptor?.ccxtId || !descriptor.tradingApi || !descriptor.hasOfficialSandbox) throw new ApiError(409, 'SANDBOX_NOT_AVAILABLE', 'exchange', 'This exchange does not have a verified sandbox/demo trading path in GAIN.', 'Exchange ini belum memiliki jalur Sandbox/Demo trading yang terverifikasi di GAIN.');
  const storedCredential = await loadBotCredential(uid, exchange);
  if (!storedCredential) throw new ApiError(409, 'EXCHANGE_CREDENTIALS_REQUIRED', 'authorization', 'No active exchange credentials are configured.', 'Credential exchange aktif belum dikonfigurasi.');
  if (!storedCredential.isSandbox) throw new ApiError(409, 'SANDBOX_CREDENTIALS_REQUIRED', 'security', 'Sandbox/demo certification requires sandbox credentials.', 'Gunakan credential Testnet/Demo untuk certification Sandbox.');
  const client = createExchangeInstance(exchange, storedCredential);
  const plan = await buildCertificationOrderPlan(client, descriptor, false);
  const run = await createExchangeCertificationRun({ firebaseUid: uid, exchange, stage: 'sandbox_demo_order', mode: 'SANDBOX_DEMO', symbol: plan.symbol, side: plan.side, orderType: 'limit', requestedQty: plan.amount, requestedPrice: plan.price, expectedNotional: plan.notional });
  try {
    await withExchangeRetry(exchange, 'certification.createSandboxOrder', () => client.loadMarkets());
    const order: any = await withExchangeRetry(exchange, 'certification.createSandboxOrder', () => client.createOrder(plan.symbol, 'limit', plan.side, plan.amount, plan.price, { timeInForce: 'GTC' }));
    await updateExchangeCertificationRun(run.id, { exchangeOrderId: String(order.id), exchangeStatus: String(order.status || 'open'), result: { submitted: true, orderId: String(order.id), symbol: plan.symbol, notional: plan.notional } });
    const beforeCancel: any = await fetchCertificationOrder(client, plan.symbol, String(order.id));
    let finalOrder = beforeCancel;
    if (!['closed', 'canceled', 'cancelled', 'rejected', 'expired'].includes(String(beforeCancel?.status || '').toLowerCase())) {
      if (!client.has?.cancelOrder) throw new ApiError(409, 'CERTIFICATION_CANCEL_UNSUPPORTED', 'exchange', 'The exchange adapter does not expose cancelOrder.', 'Exchange belum mendukung cancel order untuk certification.');
      try { await withExchangeRetry(exchange, 'certification.cancelSandboxOrder', () => client.cancelOrder(String(order.id), plan.symbol)); } catch (cancelError) {
        await updateExchangeCertificationRun(run.id, { status: 'WARNING', result: { cancelError: String((cancelError as any)?.message || cancelError).slice(0, 240), manualActionRequired: true } });
        throw cancelError;
      }
      finalOrder = await fetchCertificationOrder(client, plan.symbol, String(order.id));
    }
    const terminal = ['closed', 'canceled', 'cancelled', 'rejected', 'expired'].includes(String(finalOrder?.status || '').toLowerCase());
    const status = terminal ? 'PASS' : 'WARNING';
    await updateExchangeCertificationRun(run.id, { status, exchangeStatus: String(finalOrder?.status || order?.status || 'unknown'), filledQty: Number(finalOrder?.filled || 0), averagePrice: Number(finalOrder?.average || 0), result: { orderId: String(order.id), beforeCancelStatus: String(beforeCancel?.status || ''), finalStatus: String(finalOrder?.status || ''), filled: Number(finalOrder?.filled || 0), terminal } });
    await createAuditEvent({ firebaseUid: uid, eventType: 'exchange.certification.sandbox_demo_order', payload: { exchange, status, orderId: String(order.id), finalStatus: String(finalOrder?.status || '') } });
    return { success: terminal, exchange, stage: 'sandbox_demo_order', mode: 'SANDBOX_DEMO', status, orderId: String(order.id), result: { beforeCancelStatus: beforeCancel?.status, finalStatus: finalOrder?.status, filled: Number(finalOrder?.filled || 0), symbol: plan.symbol, notional: plan.notional } };
  } catch (error) {
    await updateExchangeCertificationRun(run.id, { status: 'FAIL', result: { error: String((error as any)?.message || error).slice(0, 240) } });
    throw error;
  }
}

export async function requireMicroLiveCertificationGate(req: Request, uid: string, exchange: string) {
  await requireLicensedSecuritySession(req, uid);
  if (!EXCHANGE_CERT_MICRO_LIVE_ENABLED) throw new ApiError(403, 'MICRO_LIVE_CERTIFICATION_DISABLED', 'security', 'Micro-live exchange certification is disabled by server configuration.', 'Micro-live certification masih dinonaktifkan oleh konfigurasi server.');
  if (!runtimeLiveTradingEnabled || LIVE_TRADING_TESTNET_ONLY) throw new ApiError(403, 'MICRO_LIVE_ENVIRONMENT_BLOCKED', 'security', 'Live trading must be explicitly enabled and testnet-only mode must be disabled for micro-live certification.', 'Environment Live harus diaktifkan secara eksplisit dan mode testnet-only harus dimatikan sementara.');
  const expected = `${EXCHANGE_CERT_MICRO_LIVE_CONFIRM}:${exchange.toUpperCase()}`;
  if (String(req.body?.confirmation || '') !== expected) throw new ApiError(403, 'MICRO_LIVE_CONFIRMATION_REQUIRED', 'security', 'Explicit exchange-specific micro-live confirmation is required.', 'Konfirmasi micro-live khusus exchange diperlukan.');
  const security = await getTwoFactorSecretRecord(uid);
  if (!security?.two_factor_enabled || !security.two_factor_secret_ciphertext || !security.two_factor_secret_iv || !security.two_factor_secret_auth_tag) throw new ApiError(403, 'TRADE_2FA_REQUIRED', 'authorization', 'Two-factor authentication is required for live certification.', 'Aktifkan 2FA sebelum certification micro-live.');
  const secret = decryptSensitiveString({ ciphertext: security.two_factor_secret_ciphertext, iv: security.two_factor_secret_iv, authTag: security.two_factor_secret_auth_tag });
  const verification = verifyServerTotp(String(req.body?.otp2fa || '').trim(), secret, 1);
  if (!verification.valid || verification.counter === undefined || !(await consumeTotpCounter(uid, verification.counter))) throw new ApiError(403, 'TRADE_2FA_INVALID', 'authorization', 'The TOTP code is invalid or already used.', 'Kode 2FA tidak valid atau sudah digunakan.');
}

export async function runMicroLiveCertification(req: Request, uid: string, exchange: string) {
  await requireMicroLiveCertificationGate(req, uid, exchange);
  const descriptor = getExchangeDescriptor(exchange);
  if (!descriptor?.ccxtId || !descriptor.tradingApi) throw new ApiError(409, 'EXCHANGE_NATIVE_API_REQUIRED', 'exchange', 'This exchange does not have an enabled trading adapter.', 'Exchange ini belum memiliki adapter trading yang aktif.');
  const storedCredential = await loadBotCredential(uid, exchange);
  if (!storedCredential) throw new ApiError(409, 'EXCHANGE_CREDENTIALS_REQUIRED', 'authorization', 'No active exchange credentials are configured.', 'Credential exchange aktif belum dikonfigurasi.');
  if (storedCredential.isSandbox) throw new ApiError(409, 'LIVE_CREDENTIALS_REQUIRED', 'security', 'Micro-live certification requires live credentials.', 'Gunakan credential Live untuk micro-live certification.');
  const client = createExchangeInstance(exchange, storedCredential);
  const plan = await buildCertificationOrderPlan(client, descriptor, true);
  const run = await createExchangeCertificationRun({ firebaseUid: uid, exchange, stage: 'micro_live_order', mode: 'MICRO_LIVE', symbol: plan.symbol, side: plan.side, orderType: 'limit', requestedQty: plan.amount, requestedPrice: plan.price, expectedNotional: plan.notional });
  try {
    await client.loadMarkets();
    const order: any = await withExchangeRetry(exchange, 'certification.createMicroLiveOrder', () => client.createOrder(plan.symbol, 'limit', plan.side, plan.amount, plan.price, { timeInForce: 'GTC' }));
    const beforeCancel: any = await fetchCertificationOrder(client, plan.symbol, String(order.id));
    let finalOrder = beforeCancel;
    const beforeStatus = String(beforeCancel?.status || '').toLowerCase();
    if (!['closed', 'canceled', 'cancelled', 'rejected', 'expired'].includes(beforeStatus) && client.has?.cancelOrder) {
      try { await withExchangeRetry(exchange, 'certification.cancelMicroLiveOrder', () => client.cancelOrder(String(order.id), plan.symbol)); } catch (cancelError) {
        await updateExchangeCertificationRun(run.id, { status: 'WARNING', exchangeOrderId: String(order.id), result: { manualActionRequired: true, cancelError: String((cancelError as any)?.message || cancelError).slice(0, 240), warning: 'Live order could not be auto-cancelled.' } });
        throw cancelError;
      }
      finalOrder = await fetchCertificationOrder(client, plan.symbol, String(order.id));
    }
    const finalStatus = String(finalOrder?.status || '').toLowerCase();
    const terminal = ['closed', 'canceled', 'cancelled', 'rejected', 'expired'].includes(finalStatus);
    const filled = Number(finalOrder?.filled || 0);
    const status = terminal ? 'PASS' : 'WARNING';
    await updateExchangeCertificationRun(run.id, { status, exchangeOrderId: String(order.id), exchangeStatus: finalStatus, filledQty: filled, averagePrice: Number(finalOrder?.average || 0), result: { warning: filled > 0 ? 'Order received fills during certification; no further automatic order was submitted.' : undefined, symbol: plan.symbol, notional: plan.notional, finalStatus, filled } });
    await createAuditEvent({ firebaseUid: uid, eventType: 'exchange.certification.micro_live_order', payload: { exchange, status, orderId: String(order.id), notional: plan.notional, filled } });
    return { success: terminal, exchange, stage: 'micro_live_order', mode: 'MICRO_LIVE', status, orderId: String(order.id), result: { finalStatus, filled, average: Number(finalOrder?.average || 0), symbol: plan.symbol, notional: plan.notional } };
  } catch (error) {
    await updateExchangeCertificationRun(run.id, { status: 'FAIL', result: { error: String((error as any)?.message || error).slice(0, 240) } });
    throw error;
  }
}

export async function runCertificationReconciliation(uid: string, exchange: string, stage: 'reconcile' | 'recovery') {
  const descriptor = getExchangeDescriptor(exchange);
  if (!descriptor?.ccxtId || !descriptor.tradingApi) throw new ApiError(409, 'EXCHANGE_NATIVE_API_REQUIRED', 'exchange', 'This exchange does not have an enabled trading adapter.', 'Exchange ini belum memiliki adapter trading yang aktif.');
  const sourceRun = await getLatestExchangeCertificationRun(uid, exchange, 'micro_live_order') || await getLatestExchangeCertificationRun(uid, exchange, 'sandbox_demo_order');
  if (!sourceRun?.exchange_order_id || !sourceRun.symbol) throw new ApiError(409, 'CERTIFICATION_ORDER_NOT_FOUND', 'exchange', 'No previous certification order is available for reconciliation.', 'Belum ada order certification yang dapat direkonsiliasi.');
  const storedCredential = await loadBotCredential(uid, exchange);
  if (!storedCredential) throw new ApiError(409, 'EXCHANGE_CREDENTIALS_REQUIRED', 'authorization', 'No active exchange credentials are configured.', 'Credential exchange aktif belum dikonfigurasi.');
  const client = createExchangeInstance(exchange, storedCredential);
  await client.loadMarkets();
  const run = await createExchangeCertificationRun({ firebaseUid: uid, exchange, stage, mode: certificationModeForStage(stage), symbol: sourceRun.symbol });
  const first: any = await fetchCertificationOrder(client, sourceRun.symbol, String(sourceRun.exchange_order_id));
  const second: any = stage === 'recovery' ? await fetchCertificationOrder(client, sourceRun.symbol, String(sourceRun.exchange_order_id)) : first;
  const normalized = (order: any) => ({ status: String(order?.status || '').toLowerCase(), filled: Number(order?.filled || 0), remaining: Number(order?.remaining || 0), average: Number(order?.average || 0), id: String(order?.id || '') });
  const a = normalized(first); const b = normalized(second);
  const stable = stage === 'recovery' ? JSON.stringify(a) === JSON.stringify(b) : true;
  const coherent = a.id === String(sourceRun.exchange_order_id) && (!sourceRun.requested_qty || a.filled <= Number(sourceRun.requested_qty) + 1e-12);
  const pass = stable && coherent;
  await updateExchangeCertificationRun(run.id, { status: pass ? 'PASS' : 'FAIL', exchangeOrderId: String(sourceRun.exchange_order_id), exchangeStatus: b.status, filledQty: b.filled, averagePrice: b.average, result: { sourceRunId: sourceRun.id, first: a, second: b, stable, coherent, simulatedRestartBoundary: stage === 'recovery' } });
  await createAuditEvent({ firebaseUid: uid, eventType: `exchange.certification.${stage}`, payload: { exchange, status: pass ? 'PASS' : 'FAIL', orderId: String(sourceRun.exchange_order_id), stable, coherent } });
  return { success: pass, exchange, stage, mode: certificationModeForStage(stage), status: pass ? 'PASS' : 'FAIL', orderId: String(sourceRun.exchange_order_id), result: { first: a, second: b, stable, coherent } };
}

const ipRateLimitMap = new Map<string, { count: number; resetTime: number }>();

export function checkRateLimit(key: string, maxRequests: number = 20, windowMs: number = 10000): boolean {
  const now = Date.now();
  if (ipRateLimitMap.size > 5000) {
    for (const [k, v] of ipRateLimitMap.entries()) {
      if (now > v.resetTime) ipRateLimitMap.delete(k);
    }
  }
  const entry = ipRateLimitMap.get(key);
  if (!entry || now > entry.resetTime) {
    ipRateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) {
    return false;
  }
  entry.count += 1;
  return true;
}

export function sanitizeErrorMessage(msg: any): string {
  if (!msg || typeof msg !== 'string') return 'Terjadi kendala pada sistem.';
  let safe = msg.replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED_KEY]');
  const urls: string[] = [];
  safe = safe.replace(/https?:\/\/[^\s"'`]+/g, (match) => {
    urls.push(match);
    return `___URL_${urls.length - 1}___`;
  });
  safe = safe.replace(/(?:\/[a-zA-Z0-9_.-]+){2,}/g, '[INTERNAL_PATH]');
  safe = safe.replace(/___URL_(\d+)___/g, (_, idx) => urls[Number(idx)] || '');
  return safe;
}

export function sanitizeExchangeErrorMessage(msg: any, credentials?: { apiKey?: unknown; secret?: unknown; password?: unknown }): string {
  let safeMessage = sanitizeErrorMessage(msg);

  for (const credential of [credentials?.apiKey, credentials?.secret, credentials?.password]) {
    if (typeof credential === 'string' && credential.length >= 8) {
      safeMessage = safeMessage.split(credential).join('[REDACTED_KEY]');
    }
  }

  return safeMessage;
}

export function buildExchangeCredentialIdentityKey(credential: { exchange: string; apiKey: string; secret: string; password?: string; isSandbox: boolean }): string {
  const material = [
    credential.exchange.toLowerCase().trim(),
    credential.isSandbox ? 'sandbox' : 'live',
    credential.apiKey.trim(),
    credential.secret.trim(),
    credential.password?.trim() || '',
  ].join('|');
  return `credential:${createHmac('sha256', getBotCredentialEncryptionKey()).update(material, 'utf8').digest('hex')}`;
}

export function resolveExchangeAccountIdentity(
  exchange: string,
  isSandbox: boolean,
  balance: any,
  credential: { apiKey: string; secret: string; password?: string },
): { identityKey: string; identityType: 'exchange_reported' | 'credential_fingerprint'; identityHint: string; credentialFingerprint: string; reportedIdentityKey?: string } {
  const info = balance?.info && typeof balance.info === 'object' ? balance.info : {};
  const candidates = [
    info.uid, info.userId, info.user_id, info.accountId, info.account_id,
    info.accountUid, info.account_uid, info.memberId, info.member_id,
  ].map((value) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '').filter(Boolean);
  const credentialFingerprint = buildExchangeCredentialIdentityKey({
    exchange,
    apiKey: credential.apiKey,
    secret: credential.secret,
    password: credential.password,
    isSandbox,
  });
  if (candidates.length > 0) {
    const candidate = candidates[0];
    const reportedMaterial = `${exchange.toLowerCase()}|${isSandbox ? 'sandbox' : 'live'}|${candidate}`;
    const reportedIdentityKey = `reported:${createHmac('sha256', getBotCredentialEncryptionKey()).update(reportedMaterial, 'utf8').digest('hex')}`;
    return {
      identityKey: credentialFingerprint,
      identityType: 'exchange_reported',
      identityHint: `${candidate.slice(0, 4)}••••${candidate.slice(-4)}`,
      credentialFingerprint,
      reportedIdentityKey,
    };
  }
  return { identityKey: credentialFingerprint, identityType: 'credential_fingerprint', identityHint: credentialFingerprint.slice(-12), credentialFingerprint };
}

export function normalizeExchangeCredentialConflict(error: any): ApiError {
  if (error?.code === 'EXCHANGE_ACCOUNT_ALREADY_LINKED') {
    return new ApiError(409, 'EXCHANGE_ACCOUNT_ALREADY_LINKED', 'authorization', 'This exchange account is already linked to another GAIN account.', 'Akun exchange ini sudah terhubung ke akun GAIN lain. Gunakan akun exchange yang berbeda atau putuskan koneksi dari akun GAIN yang memiliki akun tersebut terlebih dahulu.');
  }
  return error;
}

export async function backfillExchangeAccountIdentityMetadata(): Promise<void> {
  const rows = await dbQuery<any>(`
    SELECT ec.user_id, ec.exchange, ec.sandbox, ec.ciphertext, ec.iv, ec.auth_tag,
           ea.id AS exchange_account_id, ea.identity_key
      FROM exchange_credentials ec
      LEFT JOIN exchange_accounts ea
        ON ea.user_id = ec.user_id AND lower(ea.exchange) = lower(ec.exchange)
     WHERE ec.status = 'ACTIVE'
       AND (ea.identity_key IS NULL OR ea.identity_type IS NULL)
  `);
  let updated = 0;
  let conflicts = 0;
  for (const row of rows.rows) {
    try {
      const credential = decryptBotCredential({ iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext });
      if (!credential.exchange) throw new Error('Stored exchange credential is missing its exchange identifier.');
      const identityCredential = {
        exchange: String(credential.exchange),
        apiKey: credential.apiKey,
        secret: credential.secret,
        password: credential.password,
        isSandbox: credential.isSandbox,
      };
      const identityKey = buildExchangeCredentialIdentityKey(identityCredential);
      const existingOwner = await findExchangeIdentityOwner({
        exchange: credential.exchange,
        sandbox: credential.isSandbox,
        identityKey,
      });
      if (existingOwner && existingOwner.exchange_account_id !== row.exchange_account_id) {
        conflicts += 1;
        console.warn('[EXCHANGE_ACCOUNT_IDENTITY_CONFLICT_ON_BACKFILL]', {
          exchange: credential.exchange,
          sandbox: credential.isSandbox,
          exchangeAccountId: row.exchange_account_id,
          existingOwnerAccountId: existingOwner.exchange_account_id,
        });
        continue;
      }
      await dbQuery(`UPDATE exchange_accounts SET identity_key=$2, identity_type='credential_fingerprint', identity_hint=$3, credential_fingerprint=$2, credential_version=COALESCE(credential_version,1), updated_at=now() WHERE id=$1`, [row.exchange_account_id, identityKey, identityKey.slice(-12)]);
      updated += 1;
    } catch (error) {
      console.warn('[EXCHANGE_ACCOUNT_IDENTITY_BACKFILL_FAILED]', { exchange: row.exchange, message: String((error as any)?.message || error) });
    }
  }
  if (updated || conflicts) console.info('[EXCHANGE_ACCOUNT_IDENTITY_BACKFILL]', { updated, conflicts });
}
