import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeBotToTradingPosition, normalizeBotRuntimeState } from '../utils/botRuntimePositions';

test('Price boundaries: can be left empty (null/undefined/0) without forcing synthetic bounds', () => {
  const emptyBot = normalizeBotRuntimeState({
    id: 'bot-1',
    botId: 'bot-1',
    pair: 'BTC/USDT',
    strategy: 'Avarage+Grid',
    status: 'active',
    mode: 'testnet',
    entryPrice: 70000,
    lastPrice: 70000,
    minPrice: undefined,
    maxPrice: undefined,
  });

  const pos = runtimeBotToTradingPosition(emptyBot);

  assert.equal(pos.minPrice, null, 'minPrice must be null when left empty');
  assert.equal(pos.maxPrice, null, 'maxPrice must be null when left empty');
  assert.equal(pos.priceBoundaryStatus, 'IN_RANGE', 'Status must be IN_RANGE when boundaries are empty');
});

test('Price boundaries: can set only minPrice (floor support) while maxPrice is empty', () => {
  const floorBot = normalizeBotRuntimeState({
    id: 'bot-2',
    botId: 'bot-2',
    pair: 'BTC/USDT',
    strategy: 'Avarage Only',
    status: 'active',
    mode: 'testnet',
    entryPrice: 70000,
    lastPrice: 65000,
    minPrice: 66000,
    maxPrice: undefined,
  });

  const pos = runtimeBotToTradingPosition(floorBot);

  assert.equal(pos.minPrice, 66000, 'minPrice must equal 66000');
  assert.equal(pos.maxPrice, null, 'maxPrice must remain null');
  assert.equal(pos.priceBoundaryStatus, 'BELOW_MIN', 'Status must be BELOW_MIN when price < minPrice');
});

test('Price boundaries: can set only maxPrice (ceiling resistance) while minPrice is empty', () => {
  const ceilingBot = normalizeBotRuntimeState({
    id: 'bot-3',
    botId: 'bot-3',
    pair: 'BTC/USDT',
    strategy: 'Avarage Only',
    status: 'active',
    mode: 'testnet',
    entryPrice: 70000,
    lastPrice: 76000,
    minPrice: undefined,
    maxPrice: 75000,
  });

  const pos = runtimeBotToTradingPosition(ceilingBot);

  assert.equal(pos.minPrice, null, 'minPrice must remain null');
  assert.equal(pos.maxPrice, 75000, 'maxPrice must equal 75000');
  assert.equal(pos.priceBoundaryStatus, 'ABOVE_MAX', 'Status must be ABOVE_MAX when price > maxPrice');
});

test('Price boundaries: when both minPrice and maxPrice are filled, strictly enforces range', () => {
  const boundedBot = normalizeBotRuntimeState({
    id: 'bot-4',
    botId: 'bot-4',
    pair: 'BTC/USDT',
    strategy: 'Avarage+Grid',
    status: 'active',
    mode: 'testnet',
    entryPrice: 70000,
    lastPrice: 72000,
    minPrice: 65000,
    maxPrice: 80000,
  });

  const pos = runtimeBotToTradingPosition(boundedBot);

  assert.equal(pos.minPrice, 65000);
  assert.equal(pos.maxPrice, 80000);
  assert.equal(pos.priceBoundaryStatus, 'IN_RANGE');

  // Below min
  const belowBot = normalizeBotRuntimeState({ ...boundedBot, lastPrice: 64000 });
  const belowPos = runtimeBotToTradingPosition(belowBot);
  assert.equal(belowPos.priceBoundaryStatus, 'BELOW_MIN');

  // Above max
  const aboveBot = normalizeBotRuntimeState({ ...boundedBot, lastPrice: 81000 });
  const abovePos = runtimeBotToTradingPosition(aboveBot);
  assert.equal(abovePos.priceBoundaryStatus, 'ABOVE_MAX');
});

test('Price boundaries: when lastPrice and entryPrice are 0 (standby/uninitialized), status is IN_RANGE and not falsely BELOW_MIN', () => {
  const zeroPriceBot = normalizeBotRuntimeState({
    id: 'bot-5',
    botId: 'bot-5',
    pair: 'BTC/USDT',
    strategy: 'Avarage Only',
    status: 'paused',
    mode: 'testnet',
    entryPrice: 0,
    lastPrice: 0,
    minPrice: 65000,
    maxPrice: 80000,
  });

  const pos = runtimeBotToTradingPosition(zeroPriceBot);
  assert.equal(pos.priceBoundaryStatus, 'IN_RANGE');
});
