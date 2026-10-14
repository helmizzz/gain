import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBotExchangeOrderWithRecovery, type ActiveBotRunner } from './botRunnerLoop';

describe('botRunnerPrecisionAndTrailing', () => {
  it('applies client.amountToPrecision for BUY orders to avoid LOT_SIZE rejection', async () => {
    let capturedAmount: number | undefined;

    const mockClient = {
      markets: {
        'BTC/USDT': {
          precision: { amount: 4 },
        },
      },
      amountToPrecision: (_pair: string, amt: number) => {
        return amt.toFixed(4);
      },
      createOrder: async (_symbol: string, _type: string, _side: string, amount: number) => {
        capturedAmount = amount;
        return {
          id: 'test-buy-order-1',
          symbol: 'BTC/USDT',
          status: 'closed',
          filled: amount,
          cost: amount * 60000,
        };
      },
    };

    const mockBot = {
      id: 'bot-precision-test',
      botId: 'bot-precision-test',
      uid: 'user-test-uid',
      pair: 'BTC/USDT',
      exchange: 'binance',
      isSandbox: true,
      mode: 'testnet',
      botMode: 'Avarage Only',
      baseAmount: 100,
      status: 'active',
      stepLayer: 1,
      averagingLayers: 10,
      averageDownPct: 1,
      baseTp: 1.5,
      positionQty: 0,
      avgEntryPrice: 0,
    };

    // Raw float with many decimal places
    const rawBuyQty = 0.0016666666666666668;

    const result = await createBotExchangeOrderWithRecovery(
      mockClient,
      mockBot as unknown as ActiveBotRunner,
      'buy',
      rawBuyQty,
      'cl-order-1',
      Date.now(),
      false,
      60000
    );

    assert.ok(result);
    assert.equal(capturedAmount, 0.0017);
  });

  it('trailing TP pullback logic preserves peakPrice when profit dips between baseTp and callback threshold', () => {
    const baseTp = 1.5; // 1.5% TP target
    const tpCallbackPct = 0.3; // 0.3% callback from peak

    let botPeakPrice: number | undefined = undefined;

    // Step 1: Price climbs to 1.5% profit ($101.50 from $100 entry)
    let currentPrice = 101.50;
    let profitPct = 1.50;

    const hasReachedTpStep1 = (
      profitPct >= baseTp ||
      (botPeakPrice !== undefined && profitPct >= Math.max(0, baseTp - (tpCallbackPct > 0 ? tpCallbackPct * 2 : baseTp * 0.5)))
    );
    assert.equal(hasReachedTpStep1, true);

    botPeakPrice = Math.max(botPeakPrice || currentPrice, currentPrice);
    assert.equal(botPeakPrice, 101.50);

    // Pullback at step 1: 0% < 0.3%, so no TP execution yet
    let pullBackPct = ((botPeakPrice - currentPrice) / botPeakPrice) * 100;
    assert.equal(pullBackPct >= tpCallbackPct, false);

    // Step 2: Price climbs higher to $102.00 (2.0% profit)
    currentPrice = 102.00;
    profitPct = 2.00;
    const hasReachedTpStep2 = (
      profitPct >= baseTp ||
      (botPeakPrice !== undefined && profitPct >= Math.max(0, baseTp - (tpCallbackPct > 0 ? tpCallbackPct * 2 : baseTp * 0.5)))
    );
    assert.equal(hasReachedTpStep2, true);
    botPeakPrice = Math.max(botPeakPrice || currentPrice, currentPrice);
    assert.equal(botPeakPrice, 102.00);

    // Step 3: Small dip to $101.85 (profit is 1.85%, pullBack is 0.147% < 0.3%)
    currentPrice = 101.85;
    profitPct = 1.85;
    const hasReachedTpStep3 = (
      profitPct >= baseTp ||
      (botPeakPrice !== undefined && profitPct >= Math.max(0, baseTp - (tpCallbackPct > 0 ? tpCallbackPct * 2 : baseTp * 0.5)))
    );
    assert.equal(hasReachedTpStep3, true);
    botPeakPrice = Math.max(botPeakPrice || currentPrice, currentPrice);
    assert.equal(botPeakPrice, 102.00); // peak preserved!

    pullBackPct = ((botPeakPrice - currentPrice) / botPeakPrice) * 100;
    assert.equal(pullBackPct >= tpCallbackPct, false); // not yet triggered

    // Step 4: Price dips to $101.65 (pullback is (102 - 101.65) / 102 = ~0.343% >= 0.3%)
    currentPrice = 101.65;
    profitPct = 1.65;
    const hasReachedTpStep4 = (
      profitPct >= baseTp ||
      (botPeakPrice !== undefined && profitPct >= Math.max(0, baseTp - (tpCallbackPct > 0 ? tpCallbackPct * 2 : baseTp * 0.5)))
    );
    assert.equal(hasReachedTpStep4, true);
    botPeakPrice = Math.max(botPeakPrice || currentPrice, currentPrice);
    assert.equal(botPeakPrice, 102.00);

    pullBackPct = ((botPeakPrice - currentPrice) / botPeakPrice) * 100;
    assert.equal(pullBackPct >= tpCallbackPct, true); // Trailing TP triggers!

    // Step 5: Test scenario where price dipped to 1.35% (below baseTp 1.5% but above baseTp - callback*2 = 0.9%)
    currentPrice = 101.35;
    profitPct = 1.35;
    const hasReachedTpStep5 = (
      profitPct >= baseTp ||
      (botPeakPrice !== undefined && profitPct >= Math.max(0, baseTp - (tpCallbackPct > 0 ? tpCallbackPct * 2 : baseTp * 0.5)))
    );
    assert.equal(hasReachedTpStep5, true);
  });
});
