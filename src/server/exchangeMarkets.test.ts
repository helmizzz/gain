import test from 'node:test';
import assert from 'node:assert/strict';
import { marketsMemoryCache, tickerMemoryCache } from './shared/serverState';

test('marketsMemoryCache is isolated from tickerMemoryCache', () => {
  const exchange = 'bitget';
  const isSandbox = false;
  const tickerKey = `${exchange}:${isSandbox ? 'sandbox' : 'live'}`;
  const marketsKey = `markets:${exchange}:${isSandbox ? 'sandbox' : 'live'}`;

  tickerMemoryCache.set(tickerKey, {
    last: 65000,
    percentage: 1.5,
    timestamp: Date.now(),
    source: 'bitget',
    quoteCurrency: 'USDT',
  });

  marketsMemoryCache.set(marketsKey, {
    timestamp: Date.now(),
    markets: [
      { symbol: 'BTC/USDT', id: 'BTCUSDT', base: 'BTC', quote: 'USDT', active: true, spot: true },
      { symbol: 'ETH/USDT', id: 'ETHUSDT', base: 'ETH', quote: 'USDT', active: true, spot: true },
    ],
  });

  const cachedTicker = tickerMemoryCache.get(tickerKey);
  const cachedMarkets = marketsMemoryCache.get(marketsKey);

  assert.equal(cachedTicker?.last, 65000);
  assert.equal((cachedTicker as any).markets, undefined);

  assert.equal(cachedMarkets?.markets.length, 2);
  assert.equal(cachedMarkets?.markets[0].symbol, 'BTC/USDT');
});

test('resolveLiveMarket helper logic matches alternative quote currencies', () => {
  const map = new Map<string, any>();

  // Indodax style: BTC/IDR
  map.set('BTC/IDR', { symbol: 'BTC/IDR', base: 'BTC', quote: 'IDR', active: true });
  map.set('BASE:BTC', { symbol: 'BTC/IDR', base: 'BTC', quote: 'IDR', active: true });

  // Bitget style: BTC/USDT
  map.set('ETH/USDT', { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true });
  map.set('BASE:ETH', { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true });

  const resolveLiveMarket = (coinSymbol: string, pair: string) => {
    const sym = coinSymbol.toUpperCase();
    const p = pair.toUpperCase();
    if (map.has(p)) return map.get(p);
    for (const quote of ['USDT', 'USDC', 'IDR', 'BIDR']) {
      const candidate = `${sym}/${quote}`;
      if (map.has(candidate)) return map.get(candidate);
    }
    if (map.has(`BASE:${sym}`)) return map.get(`BASE:${sym}`);
    return undefined;
  };

  assert.equal(resolveLiveMarket('BTC', 'BTC/USDT')?.symbol, 'BTC/IDR');
  assert.equal(resolveLiveMarket('ETH', 'ETH/USDT')?.symbol, 'ETH/USDT');
  assert.equal(resolveLiveMarket('SOL', 'SOL/USDT'), undefined);
});
