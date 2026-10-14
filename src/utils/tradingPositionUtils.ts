import type { ExecutedLayerDetail, TradingPosition } from '../types';

function parseQuantity(position: TradingPosition): number {
  if (Number.isFinite(Number(position.totalCoinQty)) && Number(position.totalCoinQty) > 0) {
    return Number(position.totalCoinQty);
  }
  const raw = String(position.allocationQty || '');
  const match = raw.match(/[+-]?(?:\d+\.?\d*|\.\d+)/);
  const qty = match ? Number(match[0]) : 0;
  return Number.isFinite(qty) ? qty : 0;
}

export function generateDefaultLayersForPosition(position: TradingPosition, stepCount?: number): ExecutedLayerDetail[] {
  const currentPrice = Number(position.price) > 0 ? Number(position.price) : 0;
  const quantity = parseQuantity(position);
  const buyPrice = Number(position.avgBuyPrice) > 0
    ? Number(position.avgBuyPrice)
    : Number(position.initialEntryPrice) > 0
      ? Number(position.initialEntryPrice)
      : currentPrice;

  if (!(quantity > 0) || !(buyPrice > 0)) return [];

  const costUsdt = Number((quantity * buyPrice).toFixed(4));
  const pnlUsdt = position.floatingPnl != null
    ? Number(position.floatingPnl.toFixed(4))
    : Number(((currentPrice - buyPrice) * quantity).toFixed(4));
  const pnlPct = position.roiPct != null
    ? Number(position.roiPct.toFixed(2))
    : (buyPrice > 0 ? Number((((currentPrice - buyPrice) / buyPrice) * 100).toFixed(2)) : 0);
  const baseTp = Number(position.baseTp || 1.5);
  const estimatedTpPrice = Number((buyPrice * (1 + baseTp / 100)).toFixed(4));
  const isGridOnly = position.botMode === 'Grid Only';
  const avgLimit = Number(position.averagingLayers || (position.botMode === 'Avarage+Grid' ? 8 : 10));

  const count = Math.max(1, stepCount ?? 1);
  if (count === 1) {
    const isGridEntry = isGridOnly;
    return [{
      id: `position-${position.id || position.botId || 'bot'}-layer-1`,
      orderId: position.botId || position.id || 'initial-entry',
      symbol: position.pair,
      coin: position.coin,
      side: 'buy',
      layerStep: 1,
      layerType: isGridEntry ? 'grid' : 'average',
      label: isGridEntry ? `GRID INITIAL BUY -> ${quantity.toFixed(4)} ${position.coin}` : `BUY -> ${quantity.toFixed(4)} ${position.coin}`,
      amount: quantity,
      costUsdt,
      buyPrice,
      currentPrice,
      estimatedTpPrice,
      estimatedTpPct: baseTp,
      estimatedTpUsdt: Number((costUsdt * (baseTp / 100)).toFixed(4)),
      floatingPnlUsdt: pnlUsdt,
      floatingPnlPct: pnlPct,
      fee: 0,
      feeAsset: 'USDT',
      date: 'Live execution snapshot',
      timestamp: Date.now(),
      isInitialEntry: true,
      status: 'filled',
    }];
  }

  // If multiple layers are recorded as filled, generate proportional layer breakdowns
  const layers: ExecutedLayerDetail[] = [];
  const qtyPerLayer = quantity / count;
  const costPerLayer = costUsdt / count;
  const pnlPerLayer = pnlUsdt / count;

  for (let i = 1; i <= count; i++) {
    const isBase = i === 1;
    const isGridLayer = isGridOnly || (position.botMode === 'Avarage+Grid' && i > avgLimit);
    const layerType = isGridLayer ? 'grid' : 'average';
    const gridStepNo = position.botMode === 'Avarage+Grid' ? (i - avgLimit) : i;

    const label = isGridLayer
      ? (isBase && isGridOnly ? `GRID INITIAL BUY -> ${qtyPerLayer.toFixed(4)} ${position.coin}` : `GRID BUY #${gridStepNo} -> ${qtyPerLayer.toFixed(4)} ${position.coin}`)
      : (isBase ? `BUY -> ${qtyPerLayer.toFixed(4)} ${position.coin}` : `DCA ${i} -> ${qtyPerLayer.toFixed(4)} ${position.coin}`);

    layers.push({
      id: `position-${position.id || position.botId || 'bot'}-layer-${i}`,
      orderId: `${position.botId || position.id || 'layer'}-${i}`,
      symbol: position.pair,
      coin: position.coin,
      side: 'buy',
      layerStep: i,
      layerType,
      label,
      amount: Number(qtyPerLayer.toFixed(6)),
      costUsdt: Number(costPerLayer.toFixed(4)),
      buyPrice,
      currentPrice,
      estimatedTpPrice,
      estimatedTpPct: baseTp,
      estimatedTpUsdt: Number((costPerLayer * (baseTp / 100)).toFixed(4)),
      floatingPnlUsdt: Number(pnlPerLayer.toFixed(4)),
      floatingPnlPct: pnlPct,
      fee: 0,
      feeAsset: 'USDT',
      date: `Layer #${i} Executed`,
      timestamp: Date.now() - (count - i) * 60000,
      isInitialEntry: isBase,
      status: 'filled',
    });
  }

  return layers;
}
