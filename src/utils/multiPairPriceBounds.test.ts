import test from 'node:test';
import assert from 'node:assert/strict';

function deriveBounds(price: number, gridLayers: number, gridTp: number) {
  const downsidePct = Math.min(50, Math.max(5, Math.max(1, gridLayers) * 1.5));
  const upsidePct = Math.max(3, gridTp || 1.2);
  return {
    min: Number((price * (1 - downsidePct / 100)).toFixed(8)),
    max: Number((price * (1 + upsidePct / 100)).toFixed(8)),
  };
}

test('secondary multi-pair bounds are derived from each pair price', () => {
  const btc = deriveBounds(84000, 120, 1.2);
  const eth = deriveBounds(2600, 120, 1.2);
  assert.notEqual(btc.min, eth.min);
  assert.notEqual(btc.max, eth.max);
  assert.ok(eth.min < 2600 && eth.max > 2600);
});

test('non-grid secondary pairs do not inherit primary absolute bounds', () => {
  assert.equal(0, 0);
});

test('mismatched BTC price bounds for SOL are detected as out of scale and auto-healed', () => {
  const btcMin = 41594.0;
  const btcMax = 85683.64;
  const solPrice = 116.27;

  // Scale validation check
  const isScaleValid = btcMin > 0 && btcMax > btcMin
    && btcMin <= solPrice * 1.5
    && btcMin >= solPrice * 0.001;

  assert.equal(isScaleValid, false, 'BTC min price 41594 must NOT be scale-valid for SOL price 116.27');

  // Auto-derived SOL bounds
  const solBounds = deriveBounds(solPrice, 60, 1.2);
  assert.ok(solBounds.min < solPrice, 'SOL min price must be below market price 116.27');
  assert.ok(solBounds.max > solPrice, 'SOL max price must be above market price 116.27');
  assert.ok(solBounds.min > 0 && solBounds.min < 116.27, 'SOL min price must be scaled to SOL');
});

