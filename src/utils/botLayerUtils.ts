export interface AuthoritativeLayerMetrics {
  filledLayers: number;
  nextLayer: number;
  maxLayers: number;
  activeBuyLayers: any[];
  layerProgressPct: number;
  averagingMaxLayers: number;
  gridMaxLayers: number;
  averagingFilledLayers: number;
  gridFilledLayers: number;
  activeAvgLayers: any[];
  activeGridLayers: any[];
  avgProgressPct: number;
  gridProgressPct: number;
}

export function computeAuthoritativeLayerMetrics(bot: {
  maxLayers?: number;
  maxStep?: number;
  stepLayer?: number;
  positionQty?: number;
  totalCoinQty?: number;
  executedLayers?: any[];
  executedLayerCount?: number;
  averagingLayers?: number;
  gridLayers?: number;
  strategy?: string;
  botMode?: string;
  closedLayerIds?: string[];
}): AuthoritativeLayerMetrics {
  const mode = bot.strategy || bot.botMode || 'Avarage Only';
  const rawMax = Number(bot.maxLayers || bot.maxStep || 0);
  const avg = Number(bot.averagingLayers || 0);
  const grid = Number(bot.gridLayers || 0);

  const averagingMaxLayers = mode === 'Grid Only'
    ? 0
    : avg > 0
      ? avg
      : (mode === 'Avarage+Grid' ? 8 : 10);

  const gridMaxLayers = mode === 'Avarage Only'
    ? 0
    : grid > 0
      ? grid
      : (mode === 'Avarage+Grid' ? 10 : 20);

  const maxLayers = rawMax > 0
    ? rawMax
    : mode === 'Grid Only'
      ? Math.max(1, gridMaxLayers)
      : mode === 'Avarage Only'
        ? Math.max(1, averagingMaxLayers)
        : Math.max(1, averagingMaxLayers + gridMaxLayers);

  const qty = Number(bot.positionQty ?? bot.totalCoinQty ?? 0);
  const hasPosition = Number.isFinite(qty) && qty > 0;

  // Filter active, non-closed BUY layers
  const rawLayers = Array.isArray(bot.executedLayers) ? bot.executedLayers : [];
  const closedSet = new Set(bot.closedLayerIds || []);
  const activeBuyLayers = rawLayers.filter((layer) => {
    if (!layer) return false;
    const isSell = String(layer.side || '').toLowerCase() === 'sell';
    const isClosed = String(layer.status || '').toLowerCase() === 'closed' || (layer.id && closedSet.has(layer.id));
    return !isSell && !isClosed;
  });

  const activeAvgLayers = activeBuyLayers.filter((layer) => {
    const type = String(layer.layerType || '').toLowerCase();
    const id = String(layer.id || '').toLowerCase();
    const label = String(layer.label || '').toLowerCase();
    if (type === 'grid' || id.startsWith('grid-') || label.includes('grid')) return false;
    return true;
  });

  const activeGridLayers = activeBuyLayers.filter((layer) => {
    const type = String(layer.layerType || '').toLowerCase();
    const id = String(layer.id || '').toLowerCase();
    const label = String(layer.label || '').toLowerCase();
    return type === 'grid' || id.startsWith('grid-') || label.includes('grid');
  });

  let filledLayers = 0;
  if (activeBuyLayers.length > 0) {
    filledLayers = Math.min(maxLayers, activeBuyLayers.length);
  } else if (Number(bot.executedLayerCount || 0) > 0) {
    filledLayers = Math.min(maxLayers, Number(bot.executedLayerCount));
  } else if (hasPosition) {
    const rawStep = Number(bot.stepLayer || 0);
    filledLayers = Math.min(maxLayers, Math.max(1, rawStep > 0 ? rawStep : 1));
  }

  let averagingFilledLayers = 0;
  let gridFilledLayers = 0;

  if (mode === 'Avarage Only') {
    averagingFilledLayers = filledLayers;
    gridFilledLayers = 0;
  } else if (mode === 'Grid Only') {
    averagingFilledLayers = 0;
    gridFilledLayers = filledLayers;
  } else {
    // Hybrid (Avarage+Grid)
    if (activeAvgLayers.length > 0 || activeGridLayers.length > 0) {
      averagingFilledLayers = Math.min(averagingMaxLayers, activeAvgLayers.length);
      gridFilledLayers = Math.min(gridMaxLayers, activeGridLayers.length);
      if (averagingFilledLayers === 0 && gridFilledLayers === 0 && filledLayers > 0) {
        averagingFilledLayers = Math.min(averagingMaxLayers, filledLayers);
        gridFilledLayers = Math.min(gridMaxLayers, Math.max(0, filledLayers - averagingFilledLayers));
      }
    } else {
      averagingFilledLayers = Math.min(averagingMaxLayers, filledLayers);
      gridFilledLayers = Math.min(gridMaxLayers, Math.max(0, filledLayers - averagingFilledLayers));
    }
  }

  const nextLayer = Math.min(maxLayers, filledLayers + 1);
  const layerProgressPct = Math.min(100, Math.max(hasPosition ? 6 : 0, maxLayers > 0 ? (filledLayers / maxLayers) * 100 : 0));
  const avgProgressPct = averagingMaxLayers > 0 ? Math.min(100, (averagingFilledLayers / averagingMaxLayers) * 100) : 0;
  const gridProgressPct = gridMaxLayers > 0 ? Math.min(100, (gridFilledLayers / gridMaxLayers) * 100) : 0;

  return {
    filledLayers,
    nextLayer,
    maxLayers,
    activeBuyLayers,
    layerProgressPct,
    averagingMaxLayers,
    gridMaxLayers,
    averagingFilledLayers,
    gridFilledLayers,
    activeAvgLayers,
    activeGridLayers,
    avgProgressPct,
    gridProgressPct,
  };
}
