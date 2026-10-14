export type ExchangeCapability =
  | 'marketData'
  | 'accountRead'
  | 'ordersRead'
  | 'trading'
  | 'sandboxTrading'
  | 'publicApi';

export interface ExchangeDescriptor {
  id: string;
  name: string;
  ccxtId?: string;
  requiresPassphrase: boolean;
  hasOfficialSandbox: boolean;
  publicApi: boolean;
  authenticatedApi: boolean;
  tradingApi: boolean;
  capabilities: ExchangeCapability[];
  publicOnly?: boolean;
  publicBaseUrl?: string;
  docsUrl?: string;
  portalUrl?: string;
  certificationMode: 'FULL' | 'READ_ONLY' | 'BLOCKED_PENDING_NATIVE_API';
  quoteCurrencies: string[];
  notes?: string;
}

/**
 * Central exchange capability registry.
 *
 * IMPORTANT:
 * - A UI entry does not imply authenticated trading support.
 * - READ_ONLY means GAIN may certify market/public or account-read behavior,
 *   but must not invent order-placement capability.
 * - BLOCKED_PENDING_NATIVE_API is used when an official, sufficiently
 *   documented trading API contract has not been verified yet.
 */
export const EXCHANGE_REGISTRY = [
  {
    id: 'binance', name: 'Binance', ccxtId: 'binance', requiresPassphrase: false,
    hasOfficialSandbox: true, publicApi: true, authenticatedApi: true, tradingApi: true,
    capabilities: ['marketData', 'accountRead', 'ordersRead', 'trading', 'sandboxTrading', 'publicApi'],
    docsUrl: 'https://developers.binance.com/docs/binance-spot-api-docs',
    portalUrl: 'https://testnet.binance.vision', certificationMode: 'FULL', quoteCurrencies: ['USDT', 'USDC'],
  },
  {
    id: 'bitget', name: 'Bitget', ccxtId: 'bitget', requiresPassphrase: true,
    hasOfficialSandbox: true, publicApi: true, authenticatedApi: true, tradingApi: true,
    capabilities: ['marketData', 'accountRead', 'ordersRead', 'trading', 'sandboxTrading', 'publicApi'],
    docsUrl: 'https://www.bitget.com/docs/uta/quick-start', portalUrl: 'https://www.bitget.com',
    certificationMode: 'FULL', quoteCurrencies: ['USDT', 'USDC'],
    notes: 'Demo trading uses a dedicated demo API key and paptrading=1 on REST/WebSocket.'
  },
  {
    id: 'okx', name: 'OKX', ccxtId: 'okx', requiresPassphrase: true,
    hasOfficialSandbox: true, publicApi: true, authenticatedApi: true, tradingApi: true,
    capabilities: ['marketData', 'accountRead', 'ordersRead', 'trading', 'sandboxTrading', 'publicApi'],
    docsUrl: 'https://www.okx.com/docs-v5/en/', portalUrl: 'https://www.okx.com',
    certificationMode: 'FULL', quoteCurrencies: ['USDT', 'USDC'],
  },
  {
    id: 'bybit', name: 'Bybit Indonesia', ccxtId: 'bybit', requiresPassphrase: false,
    hasOfficialSandbox: true, publicApi: true, authenticatedApi: true, tradingApi: true,
    capabilities: ['marketData', 'accountRead', 'ordersRead', 'trading', 'sandboxTrading', 'publicApi'],
    docsUrl: 'https://bybit-exchange.github.io/docs/v5/intro', portalUrl: 'https://testnet.bybit.com',
    certificationMode: 'FULL', quoteCurrencies: ['USDT', 'USDC'],
  },
  {
    id: 'indodax', name: 'Indodax', ccxtId: 'indodax', requiresPassphrase: false,
    hasOfficialSandbox: false, publicApi: true, authenticatedApi: true, tradingApi: true,
    capabilities: ['marketData', 'accountRead', 'ordersRead', 'trading', 'publicApi'],
    docsUrl: 'https://indodax.com/api', portalUrl: 'https://indodax.com',
    certificationMode: 'FULL', quoteCurrencies: ['IDR', 'USDT'],
    notes: 'Supported for spot market data, account balance, and order management.'
  },
  {
    id: 'tokocrypto', name: 'Tokocrypto', ccxtId: 'tokocrypto', requiresPassphrase: false,
    hasOfficialSandbox: false, publicApi: true, authenticatedApi: true, tradingApi: true,
    capabilities: ['marketData', 'accountRead', 'ordersRead', 'trading', 'publicApi'],
    docsUrl: 'https://www.tokocrypto.com/apidocs', portalUrl: 'https://www.tokocrypto.com',
    certificationMode: 'FULL', quoteCurrencies: ['USDT', 'USDC', 'IDR'],
    notes: 'Supported for spot market data, account balance, and order management.'
  },
  {
    id: 'bittime', name: 'Bittime', requiresPassphrase: false,
    hasOfficialSandbox: false, publicApi: true, authenticatedApi: false, tradingApi: false,
    publicOnly: true,
    capabilities: ['publicApi'], docsUrl: 'https://bittime.com', portalUrl: 'https://bittime.com',
    certificationMode: 'BLOCKED_PENDING_NATIVE_API', quoteCurrencies: ['IDR', 'USDT'],
    notes: 'Blocked pending verified native API trading documentation.'
  },
  {
    id: 'pintupro', name: 'Pintu Pro', requiresPassphrase: false,
    hasOfficialSandbox: false, publicApi: true, authenticatedApi: false, tradingApi: false,
    publicOnly: true,
    capabilities: ['publicApi'], docsUrl: 'https://pintu.co.id', portalUrl: 'https://pintu.co.id',
    certificationMode: 'BLOCKED_PENDING_NATIVE_API', quoteCurrencies: ['IDR', 'USDT'],
    notes: 'Blocked pending verified native API trading documentation.'
  },
  {
    id: 'reku', name: 'Reku', requiresPassphrase: false,
    hasOfficialSandbox: false, publicApi: true, authenticatedApi: false, tradingApi: false,
    publicOnly: true,
    capabilities: ['publicApi', 'marketData'], docsUrl: 'https://reku.id', portalUrl: 'https://reku.id',
    publicBaseUrl: 'https://api.reku.id/v2',
    certificationMode: 'READ_ONLY', quoteCurrencies: ['IDR', 'USDT'],
    notes: 'Supported for public market-data ticker and order book reads. Trading blocked.'
  },
  {
    id: 'triv', name: 'Triv', requiresPassphrase: false,
    hasOfficialSandbox: false, publicApi: true, authenticatedApi: false, tradingApi: false,
    publicOnly: true,
    capabilities: ['publicApi'], docsUrl: 'https://triv.co.id', portalUrl: 'https://triv.co.id',
    certificationMode: 'BLOCKED_PENDING_NATIVE_API', quoteCurrencies: ['IDR', 'USDT'],
    notes: 'Blocked pending verified native API trading documentation.'
  },
] as const satisfies readonly ExchangeDescriptor[];

export type ExchangeId = typeof EXCHANGE_REGISTRY[number]['id'];
export type ExchangeName = typeof EXCHANGE_REGISTRY[number]['name'];

export function getExchangeDescriptor(idOrName: string): ExchangeDescriptor | undefined {
  const key = String(idOrName || '').trim().toLowerCase();
  return EXCHANGE_REGISTRY.find(
    (item) =>
      item.id === key ||
      item.name.toLowerCase() === key ||
      (item.id === 'bybit' && (key === 'bybit' || key === 'bybit indonesia'))
  );
}

export function getExchangeIds(): string[] {
  return EXCHANGE_REGISTRY.map((item) => item.id);
}

export function getExchangeNames(): ExchangeName[] {
  return EXCHANGE_REGISTRY.map((item) => item.name);
}

export function isTradingExchange(idOrName: string): boolean {
  return Boolean(getExchangeDescriptor(idOrName)?.tradingApi);
}
