import type { GridConfig, GridLevel, MarketSnapshot, OrderIntent, PositionState } from '../../domain/strategy/types';

export function generateGridLevels(config: GridConfig, currentPrice?: number): GridLevel[] {
  if (config.gridCount < 1 || config.upperPrice <= config.lowerPrice) return [];
  const spacing = (config.upperPrice - config.lowerPrice) / config.gridCount;
  return Array.from({ length: config.gridCount + 1 }, (_, index) => {
    const price = Number((config.lowerPrice + spacing * index).toFixed(6));
    let side: 'BUY' | 'SELL';
    if (typeof currentPrice === 'number' && currentPrice > 0) {
      side = price <= currentPrice ? 'BUY' : 'SELL';
    } else {
      side = index < Math.floor(config.gridCount / 2) ? 'BUY' : 'SELL';
    }
    return { id: `grid-${index}`, index, price, side, status: 'WAITING' };
  });
}

export function evaluateGrid(
  botId: string,
  userId: string,
  symbol: string,
  config: GridConfig,
  levels: GridLevel[],
  position: PositionState,
  market: MarketSnapshot,
  previousPrice = market.last,
): { intent?: OrderIntent; levels: GridLevel[]; reason: string } {
  if (market.last < config.lowerPrice || market.last > config.upperPrice) return { levels, reason: 'OUTSIDE_GRID_RANGE' };
  const crossedBuy = levels
    .filter((l) => l.status === 'WAITING' && l.side === 'BUY' && previousPrice > l.price && market.last <= l.price)
    .sort((a, b) => b.price - a.price)[0];
  const crossedSell = levels
    .filter((l) => (l.status === 'WAITING' || l.status === 'COOLDOWN') && l.side === 'SELL' && previousPrice < l.price && market.last >= l.price)
    .sort((a, b) => a.price - b.price)[0];
  const level = crossedBuy || crossedSell;
  if (!level) return { levels, reason: 'NO_CROSSED_GRID_LEVEL' };
  if (level.side === 'SELL' && position.quantity <= 0) return { levels, reason: 'NO_POSITION_FOR_SELL' };

  const side = level.side === 'BUY' ? 'buy' : 'sell';
  const quantity = level.side === 'BUY' ? config.orderSizeUsd / market.last : Math.min(position.quantity, config.orderSizeUsd / market.last);
  const intent: OrderIntent = {
    id: `${botId}-${level.id}-${Math.floor(market.timestamp / 1000)}`,
    idempotencyKey: `${botId}:GRID:${level.id}:${side}`,
    botId,
    userId,
    strategy: 'GRID',
    symbol,
    side,
    type: 'limit',
    quantity,
    referencePrice: level.price,
    notional: quantity * level.price,
    gridLevelId: level.id,
    reason: `Grid ${side.toUpperCase()} level ${level.index} @ ${level.price}`,
    createdAt: Date.now(),
  };
  return { intent, levels: levels.map((l) => l.id === level.id ? { ...l, status: 'ORDERED' as const } : l), reason: 'GRID_LEVEL_TRIGGERED' };
}

export function pairGridLevel(
  levels: GridLevel[],
  filledLevelId: string,
  fillPrice: number,
  side: 'buy' | 'sell' = 'buy',
  filledQty?: number
): GridLevel[] {
  const filledIdx = levels.findIndex((l) => l.id === filledLevelId);
  if (filledIdx === -1) return levels;

  return levels.map((level, idx) => {
    if (idx === filledIdx) {
      if (side === 'buy') {
        return {
          ...level,
          status: 'FILLED' as const,
          filledQty: filledQty ?? level.filledQty,
        };
      } else {
        // When sold, this level itself becomes ready to buy again if price drops back to it
        return {
          ...level,
          side: 'BUY' as const,
          status: 'WAITING' as const,
          pairedLevelId: undefined,
          filledQty: undefined,
        };
      }
    }

    if (side === 'buy') {
      // The upper adjacent level activates as the SELL target for this lot
      if (idx === filledIdx + 1 && idx < levels.length) {
        return {
          ...level,
          side: 'SELL' as const,
          status: 'WAITING' as const,
          pairedLevelId: filledLevelId,
        };
      }
    } else {
      // When a SELL fills, the lower adjacent level is re-activated as a BUY target
      if (idx === filledIdx - 1 && idx >= 0) {
        return {
          ...level,
          side: 'BUY' as const,
          status: 'WAITING' as const,
          pairedLevelId: undefined,
        };
      }
    }

    return level;
  });
}
