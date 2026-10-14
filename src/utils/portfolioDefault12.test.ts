import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_COINS } from '../data/appData';

const EXPECTED = ['BTC','ETH','SOL','BNB','ZEC','HYPE','LINK','TAO','NEAR','SUI','XRP','DOGE','XAUT','AVAX','TIA','ASTER'];

test('default portfolio scope is exactly the configured coins in order', () => {
  assert.deepEqual(SUPPORTED_COINS.map((coin) => coin.coin), EXPECTED);
  assert.deepEqual(SUPPORTED_COINS.map((coin) => coin.pair), EXPECTED.map((coin) => `${coin}/USDT`));
});

test('raw exchange assets are not part of display scope unless configured', () => {
  const raw = ['BTC','PEPE','ETH','SHIB','DOGE','TRY'];
  const scope = new Set(SUPPORTED_COINS.map((coin) => coin.coin));
  const displayed = raw.filter((coin) => scope.has(coin));
  assert.deepEqual(displayed, ['BTC','ETH','DOGE']);
  assert.equal(scope.has('PEPE'), false);
  assert.equal(scope.has('SHIB'), false);
});
