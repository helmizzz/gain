import assert from 'node:assert/strict';
import test from 'node:test';
import { EXCHANGE_REGISTRY, getExchangeDescriptor, getExchangeNames, isTradingExchange } from './exchangeRegistry';

test('exchange registry contains the 6 official exchanges', () => {
  const targetExchanges = ['binance', 'bitget', 'okx', 'bybit', 'indodax', 'tokocrypto'];
  for (const id of targetExchanges) {
    assert.ok(getExchangeDescriptor(id), `missing ${id}`);
    assert.equal(isTradingExchange(id), true, `${id} should support trading`);
  }
});

test('getExchangeDescriptor resolves Bybit and Bybit Indonesia', () => {
  const bybit1 = getExchangeDescriptor('bybit');
  const bybit2 = getExchangeDescriptor('bybit indonesia');
  assert.ok(bybit1);
  assert.ok(bybit2);
  assert.equal(bybit1?.id, 'bybit');
  assert.equal(bybit2?.id, 'bybit');
});

test('Bitget & OKX require passphrases, Binance, Bybit, Indodax, Tokocrypto do not', () => {
  assert.equal(getExchangeDescriptor('bitget')?.requiresPassphrase, true);
  assert.equal(getExchangeDescriptor('okx')?.requiresPassphrase, true);
  assert.equal(getExchangeDescriptor('binance')?.requiresPassphrase, false);
  assert.equal(getExchangeDescriptor('bybit')?.requiresPassphrase, false);
  assert.equal(getExchangeDescriptor('indodax')?.requiresPassphrase, false);
  assert.equal(getExchangeDescriptor('tokocrypto')?.requiresPassphrase, false);
});

test('Indodax and Tokocrypto are fully enabled trading exchanges', () => {
  const indodax = getExchangeDescriptor('indodax');
  const tokocrypto = getExchangeDescriptor('tokocrypto');
  assert.equal(indodax?.certificationMode, 'FULL');
  assert.equal(indodax?.tradingApi, true);
  assert.equal(tokocrypto?.certificationMode, 'FULL');
  assert.equal(tokocrypto?.tradingApi, true);
});

test('registry names map one-to-one with IDs', () => {
  assert.equal(getExchangeNames().length, EXCHANGE_REGISTRY.length);
  assert.equal(new Set(getExchangeNames()).size, EXCHANGE_REGISTRY.length);
  assert.equal(EXCHANGE_REGISTRY.length, 10);
});

test('registry IDs are unique', () => {
  const ids = EXCHANGE_REGISTRY.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('non-trading Indonesian exchanges are correctly constrained', () => {
  const reku = getExchangeDescriptor('reku');
  assert.ok(reku);
  assert.equal(reku?.certificationMode, 'READ_ONLY');
  assert.equal(reku?.tradingApi, false);
  assert.equal(reku?.publicOnly, true);
  assert.equal(reku?.publicBaseUrl, 'https://api.reku.id/v2');

  for (const id of ['bittime', 'pintupro', 'triv']) {
    const desc = getExchangeDescriptor(id);
    assert.ok(desc, `missing ${id}`);
    assert.equal(desc?.certificationMode, 'BLOCKED_PENDING_NATIVE_API');
    assert.equal(desc?.tradingApi, false);
    assert.equal(desc?.publicOnly, true);
  }
});

test('unsupported exchanges are not registered', () => {
  assert.equal(getExchangeDescriptor('coinbase'), undefined);
  assert.equal(getExchangeDescriptor('kraken'), undefined);
});
