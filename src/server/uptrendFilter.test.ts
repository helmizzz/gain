import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const BotRegisterSchema = z.object({
  pair: z.string().default('BTC/USDT'),
  botMode: z.enum(['Avarage Only', 'Grid Only', 'Avarage+Grid']).default('Avarage Only'),
  baseAmount: z.coerce.number().min(0.00000001).default(35),
  baseTp: z.coerce.number().min(0.1).max(50).default(1.5),
  useMoneyManagement: z.boolean().default(true),
  averagingLayers: z.coerce.number().int().min(0).max(20).default(1),
  gridLayers: z.coerce.number().int().min(0).max(100).default(5),
  averageDownPct: z.coerce.number().min(0.1).default(1),
  uptrendFilter: z.boolean().default(true),
  uptrendThresholdPct: z.coerce.number().min(0.01).max(20).default(0.1),
});

function evaluateUptrendCondition(params: {
  candle: { open: number; close: number };
  previousCandleClose?: number;
  uptrendFilter?: boolean;
  uptrendThresholdPct?: number;
}) {
  const { candle, previousCandleClose, uptrendFilter, uptrendThresholdPct } = params;
  const candleChangePct = candle.open > 0 ? ((candle.close - candle.open) / candle.open) * 100 : 0;
  const prevCloseChangePct = (previousCandleClose && previousCandleClose > 0)
    ? ((candle.close - previousCandleClose) / previousCandleClose) * 100
    : candleChangePct;
  const thresholdPct = Number.isFinite(uptrendThresholdPct) && (uptrendThresholdPct as number) > 0
    ? (uptrendThresholdPct as number)
    : 0.1;

  const effectiveGainPct = Math.max(candleChangePct, prevCloseChangePct);
  const isUptrend = candle.close >= candle.open && effectiveGainPct >= thresholdPct;
  const uptrendStatus = isUptrend
    ? 'Bullish'
    : (candle.close < candle.open && candleChangePct <= -thresholdPct ? 'Downtrend' : 'Sideways');

  const canAccumulate = uptrendFilter === false || isUptrend;

  return {
    candleChangePct,
    effectiveGainPct,
    thresholdPct,
    isUptrend,
    uptrendStatus,
    canAccumulate,
  };
}

test('BotRegisterSchema sets default uptrendFilter to true and uptrendThresholdPct to 0.1', () => {
  const parsed = BotRegisterSchema.parse({});
  assert.equal(parsed.uptrendFilter, true);
  assert.equal(parsed.uptrendThresholdPct, 0.1);
});

test('BotRegisterSchema accepts custom uptrendThresholdPct', () => {
  const parsed = BotRegisterSchema.parse({
    uptrendFilter: true,
    uptrendThresholdPct: '0.25',
  });
  assert.equal(parsed.uptrendFilter, true);
  assert.equal(parsed.uptrendThresholdPct, 0.25);
});

test('BotRegisterSchema rejects invalid uptrendThresholdPct', () => {
  const tooLow = BotRegisterSchema.safeParse({ uptrendThresholdPct: 0.005 });
  assert.equal(tooLow.success, false);

  const tooHigh = BotRegisterSchema.safeParse({ uptrendThresholdPct: 25 });
  assert.equal(tooHigh.success, false);
});

test('Uptrend filter allows accumulation when candle gain meets or exceeds default 0.1% threshold', () => {
  const result = evaluateUptrendCondition({
    candle: { open: 100, close: 100.15 }, // +0.15% gain
    previousCandleClose: 100,
    uptrendFilter: true,
    uptrendThresholdPct: 0.1,
  });

  assert.equal(result.isUptrend, true);
  assert.equal(result.uptrendStatus, 'Bullish');
  assert.equal(result.canAccumulate, true);
});

test('Uptrend filter blocks accumulation when candle gain is below threshold (sideways)', () => {
  const result = evaluateUptrendCondition({
    candle: { open: 100, close: 100.04 }, // +0.04% gain, below 0.1%
    previousCandleClose: 100,
    uptrendFilter: true,
    uptrendThresholdPct: 0.1,
  });

  assert.equal(result.isUptrend, false);
  assert.equal(result.uptrendStatus, 'Sideways');
  assert.equal(result.canAccumulate, false);
});

test('Uptrend filter blocks accumulation when market is in downtrend', () => {
  const result = evaluateUptrendCondition({
    candle: { open: 100, close: 99.7 }, // -0.3% loss
    previousCandleClose: 100,
    uptrendFilter: true,
    uptrendThresholdPct: 0.1,
  });

  assert.equal(result.isUptrend, false);
  assert.equal(result.uptrendStatus, 'Downtrend');
  assert.equal(result.canAccumulate, false);
});

test('Disabling uptrendFilter allows accumulation regardless of market trend', () => {
  const result = evaluateUptrendCondition({
    candle: { open: 100, close: 99.5 }, // -0.5% loss
    previousCandleClose: 100,
    uptrendFilter: false,
    uptrendThresholdPct: 0.1,
  });

  assert.equal(result.isUptrend, false);
  assert.equal(result.canAccumulate, true);
});

test('Custom uptrend threshold scales correctly', () => {
  // Candle with +0.2% gain meets 0.1% default, but fails 0.5% custom threshold
  const withHalfPercent = evaluateUptrendCondition({
    candle: { open: 100, close: 100.2 },
    previousCandleClose: 100,
    uptrendFilter: true,
    uptrendThresholdPct: 0.5,
  });
  assert.equal(withHalfPercent.isUptrend, false);
  assert.equal(withHalfPercent.canAccumulate, false);

  // Candle with +0.6% gain meets 0.5% custom threshold
  const withLargerGain = evaluateUptrendCondition({
    candle: { open: 100, close: 100.6 },
    previousCandleClose: 100,
    uptrendFilter: true,
    uptrendThresholdPct: 0.5,
  });
  assert.equal(withLargerGain.isUptrend, true);
  assert.equal(withLargerGain.uptrendStatus, 'Bullish');
  assert.equal(withLargerGain.canAccumulate, true);
});
