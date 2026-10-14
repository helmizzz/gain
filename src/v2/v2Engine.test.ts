import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDcaLayers } from './engines/strategy/DcaEngine';
import { generateGridLevels } from './engines/strategy/GridEngine';
import { evaluateRisk } from './engines/risk/RiskEngine';

test('DCA layer planner applies step scale and volume multiplier under capital cap', () => {
  const layers = generateDcaLayers({ baseOrderUsd: 10, stepDeviationPct: 2, stepScale: 1.25, volumeMultiplier: 1.5, maxLayers: 20, maxCapitalUsd: 100, takeProfitPct: 1, trailingTpPct: .2, callbackPct: .2 });
  assert.equal(layers[0].amountUsd, 10);
  assert.equal(layers[1].amountUsd, 15);
  assert.equal(layers[1].deviationPct, 2);
  assert.ok(layers.reduce((s, l) => s + l.amountUsd, 0) <= 100);
});

test('Grid planner creates bounded levels', () => {
  const levels = generateGridLevels({ lowerPrice: 80, upperPrice: 120, gridCount: 20, orderSizeUsd: 10, takeProfitPct: 1, maxCapitalUsd: 200 });
  assert.equal(levels.length, 21);
  assert.equal(levels[0].price, 80);
  assert.equal(levels.at(-1)?.price, 120);
});

test('risk engine blocks committed capital and spread violations', () => {
  const intent = { id:'1', idempotencyKey:'1', botId:'b', userId:'u', strategy:'DCA' as const, symbol:'BTC/USDT', side:'buy' as const, type:'market' as const, quantity:0.01, referencePrice:100, notional:1, reason:'test', createdAt:Date.now() };
  const market = { exchange:'binance', symbol:'BTC/USDT', bid:99, ask:101, last:100, timestamp:Date.now(), spreadPct:2 };
  const decision = evaluateRisk(intent, market, { botExposureUsd:0,userExposureUsd:0,portfolioExposureUsd:0,futureCommittedUsd:100,maxOrderUsd:50,maxBotExposureUsd:250,maxUserExposureUsd:500,maxPortfolioExposureUsd:1000,maxCommittedCapitalUsd:100,maxDailyLossUsd:25,dailyNetPnlUsd:0,maxDrawdownPct:20,drawdownPct:0,maxSpreadPct:1,maxSlippagePct:1,marketPriceTimestamp:Date.now(),now:Date.now(),killSwitch:false,exchangeHealthy:true });
  assert.equal(decision.approved, false);
  assert.equal('code' in decision ? decision.code : 'APPROVED', 'SPREAD_TOO_HIGH');
});

test('DCA generator honors user configured steps from UI matrix', () => {
  const customSteps = [
    { step: 1, dropPct: 0, multiplier: 1.0, amountUsdt: 20 },
    { step: 2, dropPct: 1.5, multiplier: 1.15, amountUsdt: 23 },
    { step: 3, dropPct: 3.0, multiplier: 1.30, amountUsdt: 26 },
  ];
  const layers = generateDcaLayers({
    baseOrderUsd: 20, stepDeviationPct: 1.5, stepScale: 1.0, volumeMultiplier: 1.15,
    maxLayers: 3, maxCapitalUsd: 100, takeProfitPct: 1.5, trailingTpPct: 0.2, callbackPct: 0.2,
    steps: customSteps,
  });
  assert.equal(layers.length, 3);
  assert.equal(layers[0].amountUsd, 20);
  assert.equal(layers[1].amountUsd, 23);
  assert.equal(layers[2].amountUsd, 26);
  assert.equal(layers[1].deviationPct, 1.5);
  assert.equal(layers[2].deviationPct, 3.0);
});

test('Grid generator configures BUY below current price and SELL above', () => {
  const currentPrice = 100;
  const levels = generateGridLevels({ lowerPrice: 80, upperPrice: 120, gridCount: 4, orderSizeUsd: 10, takeProfitPct: 1.2, maxCapitalUsd: 100 }, currentPrice);
  // Spacing = (120 - 80) / 4 = 10 -> [80, 90, 100, 110, 120]
  assert.equal(levels[0].price, 80);
  assert.equal(levels[0].side, 'BUY');
  assert.equal(levels[1].price, 90);
  assert.equal(levels[1].side, 'BUY');
  assert.equal(levels[2].price, 100);
  assert.equal(levels[2].side, 'BUY');
  assert.equal(levels[3].price, 110);
  assert.equal(levels[3].side, 'SELL');
  assert.equal(levels[4].price, 120);
  assert.equal(levels[4].side, 'SELL');
});

test('Grid ping-pong cycles buy and sell levels continuously across the ladder', async () => {
  const { pairGridLevel } = await import('./engines/strategy/GridEngine');
  let levels = generateGridLevels({ lowerPrice: 80, upperPrice: 120, gridCount: 4, orderSizeUsd: 10, takeProfitPct: 1.2, maxCapitalUsd: 100 }, 100);
  // Level 1 (price 90) BUY fills
  levels = pairGridLevel(levels, 'grid-1', 90, 'buy', 0.11);
  assert.equal(levels[1].status, 'FILLED');
  assert.equal(levels[2].side, 'SELL');
  assert.equal(levels[2].status, 'WAITING');

  // Price rises to 100 (grid-2) and SELL fills
  levels = pairGridLevel(levels, 'grid-2', 100, 'sell', 0.11);
  // grid-2 is recycled to ready to buy
  assert.equal(levels[2].side, 'BUY');
  assert.equal(levels[2].status, 'WAITING');
  // Lower level (grid-1) is re-opened as BUY WAITING
  assert.equal(levels[1].side, 'BUY');
  assert.equal(levels[1].status, 'WAITING');
});
