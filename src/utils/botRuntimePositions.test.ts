import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBotRuntimeState, runtimeBotToTradingPosition } from './botRuntimePositions';

describe('botRuntimePositions layer resolution and projection', () => {
  it('correctly resolves default maxLayers for Hybrid (Avarage+Grid) when omitted or 0', () => {
    const raw = {
      id: 'bot-123',
      pair: 'UNI/USDT',
      strategy: 'Avarage+Grid',
      stepLayer: 1,
      maxLayers: 0,
      positionQty: 6.5,
      avgEntryPrice: 7.5,
      lastPrice: 7.5,
    };
    const normalized = normalizeBotRuntimeState(raw);
    assert.equal(normalized.strategy, 'Avarage+Grid');
    assert.equal(normalized.averagingLayers, 8);
    assert.equal(normalized.gridLayers, 10);
    assert.equal(normalized.maxLayers, 18);
  });

  it('correctly calculates total maxLayers from explicit averagingLayers and gridLayers', () => {
    const raw = {
      id: 'bot-custom',
      pair: 'BTC/USDT',
      strategy: 'Avarage+Grid',
      averagingLayers: 12,
      gridLayers: 15,
      stepLayer: 2,
    };
    const normalized = normalizeBotRuntimeState(raw);
    assert.equal(normalized.averagingLayers, 12);
    assert.equal(normalized.gridLayers, 15);
    assert.equal(normalized.maxLayers, 27);
  });

  it('correctly sets defaults for Avarage Only and Grid Only', () => {
    const avgBot = normalizeBotRuntimeState({
      id: 'bot-avg',
      pair: 'ETH/USDT',
      strategy: 'Avarage Only',
    });
    assert.equal(avgBot.averagingLayers, 8); // fallback or 10
    assert.equal(avgBot.gridLayers, 0);
    assert.equal(avgBot.maxLayers, 10);

    const gridBot = normalizeBotRuntimeState({
      id: 'bot-grid',
      pair: 'SOL/USDT',
      strategy: 'Grid Only',
    });
    assert.equal(gridBot.averagingLayers, 0);
    assert.equal(gridBot.gridLayers, 10);
    assert.equal(gridBot.maxLayers, 20);
  });

  it('transforms runtime bot to TradingPosition with full maxStep and layerQuota', () => {
    const normalized = normalizeBotRuntimeState({
      id: 'bot-hybrid',
      pair: 'UNI/USDT',
      strategy: 'Avarage+Grid',
      stepLayer: 1,
      positionQty: 6.5,
      avgEntryPrice: 7.5,
      lastPrice: 7.5,
    });
    const position = runtimeBotToTradingPosition(normalized);
    assert.equal(position.stepLayer, 1);
    assert.equal(position.maxStep, 18);
    assert.equal(position.averagingLayers, 8);
    assert.equal(position.gridLayers, 10);
    assert.match(position.layerQuota, /18 Layer/);
  });
});
