import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterExchangeScoped, selectActiveExchangeConfig } from './exchangeIsolation';

describe('exchange isolation', () => {
  it('selects only the active connected exchange', () => {
    const configs = [
      { exchange: 'Binance', isConnected: true, isSandbox: false, apiKeyMasked: 'A', usdtBalance: 100, lastSynced: '' },
      { exchange: 'Bybit Indonesia', isConnected: true, isSandbox: false, apiKeyMasked: 'B', usdtBalance: 500, lastSynced: '' },
    ] as any;
    assert.equal(selectActiveExchangeConfig(configs, 'Bybit Indonesia')?.usdtBalance, 500);
  });

  it('never aggregates records from another exchange', () => {
    const rows = [
      { exchange: 'Binance', id: 1 },
      { exchange: 'Bybit', id: 2 },
      { exchange: 'BINANCE', id: 3 },
    ];
    assert.deepEqual(filterExchangeScoped(rows, 'Binance').map((x) => x.id), [1, 3]);
  });

  it('isolates records by exchange and sandbox/live environment', () => {
    const rows = [
      { exchange: 'Binance', isSandbox: true, id: 'testnet' },
      { exchange: 'Binance', isSandbox: false, id: 'live' },
      { exchange: 'Bybit', isSandbox: true, id: 'other-exchange' },
      { exchange: 'Binance', id: 'unknown-environment' },
    ];
    assert.deepEqual(filterExchangeScoped(rows, 'Binance', true).map((x) => x.id), ['testnet']);
    assert.deepEqual(filterExchangeScoped(rows, 'Binance', false).map((x) => x.id), ['live']);
  });
});
