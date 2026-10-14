import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBotCredentialContext, buildClientOrderId } from './botEngineCore';

test('client order ids are deterministic within an exchange scope', () => {
  const a = buildClientOrderId('u', 'b', 'r', 'sell', 1, 'binance', true);
  const b = buildClientOrderId('u', 'b', 'r', 'sell', 1, 'binance', true);
  assert.equal(a, b);
});

test('client order ids differ across exchange scope', () => {
  const binance = buildClientOrderId('u', 'b', 'r', 'sell', 1, 'binance', true);
  const bybit = buildClientOrderId('u', 'b', 'r', 'sell', 1, 'bybit', true);
  const live = buildClientOrderId('u', 'b', 'r', 'sell', 1, 'binance', false);
  assert.notEqual(binance, bybit);
  assert.notEqual(binance, live);
});

test('bot runner only accepts credentials for its exchange and environment', () => {
  const bot = { exchange: 'BINANCE', isSandbox: true };
  assert.doesNotThrow(() => assertBotCredentialContext(bot, { exchange: 'binance', isSandbox: true }));
  assert.throws(
    () => assertBotCredentialContext(bot, { exchange: 'binance', isSandbox: false }),
    (error: any) => error.reasonCode === 'BOT_EXCHANGE_CREDENTIAL_CONTEXT_MISMATCH' && error.retryable === false,
  );
  assert.throws(
    () => assertBotCredentialContext(bot, { exchange: 'bybit', isSandbox: true }),
    (error: any) => error.reasonCode === 'BOT_EXCHANGE_CREDENTIAL_CONTEXT_MISMATCH' && error.retryable === false,
  );
});
