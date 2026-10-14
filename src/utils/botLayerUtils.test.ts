import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeAuthoritativeLayerMetrics } from './botLayerUtils';

describe('computeAuthoritativeLayerMetrics', () => {
  it('returns 0 filled layers when there is no position and no layers', () => {
    const res = computeAuthoritativeLayerMetrics({
      positionQty: 0,
      stepLayer: 0,
      maxLayers: 10,
    });
    assert.equal(res.filledLayers, 0);
    assert.equal(res.maxLayers, 10);
    assert.equal(res.nextLayer, 1);
  });

  it('correctly handles initial entry with single layer', () => {
    const res = computeAuthoritativeLayerMetrics({
      positionQty: 5.5,
      stepLayer: 1,
      maxLayers: 18,
      executedLayers: [
        { id: 'layer-1', side: 'buy', status: 'filled', amount: 5.5 },
      ],
    });
    assert.equal(res.filledLayers, 1);
    assert.equal(res.nextLayer, 2);
    assert.equal(res.maxLayers, 18);
  });

  it('filters out grid sell and closed layers so layer count is not inflated', () => {
    const res = computeAuthoritativeLayerMetrics({
      positionQty: 5.5,
      stepLayer: 2,
      maxLayers: 18,
      executedLayers: [
        { id: 'layer-1', side: 'buy', status: 'filled', amount: 3 },
        { id: 'layer-2', side: 'buy', status: 'filled', amount: 2.5 },
        { id: 'grid-sell-1', side: 'sell', status: 'closed', amount: 1 },
        { id: 'layer-old', side: 'buy', status: 'closed', amount: 1 },
      ],
    });
    // Only the 2 active buy layers should count
    assert.equal(res.filledLayers, 2);
    assert.equal(res.activeBuyLayers.length, 2);
  });

  it('resolves default maxLayers correctly for Hybrid', () => {
    const res = computeAuthoritativeLayerMetrics({
      strategy: 'Avarage+Grid',
      averagingLayers: 8,
      gridLayers: 10,
      positionQty: 1,
    });
    assert.equal(res.maxLayers, 18);
    assert.equal(res.filledLayers, 1);
  });

  it('does not double decrement when stepLayer is given without executedLayers array', () => {
    const res = computeAuthoritativeLayerMetrics({
      positionQty: 10,
      stepLayer: 2,
      maxLayers: 10,
    });
    assert.equal(res.filledLayers, 2);
    assert.equal(res.nextLayer, 3);
  });

  it('separates DCA averaging and Grid layer counts in Hybrid mode', () => {
    const res = computeAuthoritativeLayerMetrics({
      strategy: 'Avarage+Grid',
      averagingLayers: 8,
      gridLayers: 10,
      positionQty: 10,
      executedLayers: [
        { id: 'layer-1', side: 'buy', status: 'filled', layerType: 'average', label: 'BUY -> 5 COIN', amount: 5 },
        { id: 'layer-2', side: 'buy', status: 'filled', layerType: 'average', label: 'DCA 2 -> 2.5 COIN', amount: 2.5 },
        { id: 'grid-1', side: 'buy', status: 'filled', layerType: 'grid', label: 'GRID BUY #1 -> 2.5 COIN', amount: 2.5 },
        { id: 'grid-closed', side: 'sell', status: 'closed', layerType: 'grid', label: 'GRID SELL #1', amount: 2.5 },
      ],
    });
    assert.equal(res.maxLayers, 18);
    assert.equal(res.averagingMaxLayers, 8);
    assert.equal(res.gridMaxLayers, 10);
    assert.equal(res.filledLayers, 3);
    assert.equal(res.averagingFilledLayers, 2);
    assert.equal(res.gridFilledLayers, 1);
    assert.equal(res.activeAvgLayers.length, 2);
    assert.equal(res.activeGridLayers.length, 1);
    assert.equal(res.avgProgressPct, 25);
    assert.equal(res.gridProgressPct, 10);
  });
});
