import type { TradingPosition, UserWallet } from '../types';
import { computeAuthoritativeLayerMetrics } from './botLayerUtils';

export interface BotRuntimeState {
  id: string;
  botId?: string;
  runnerId?: string;
  botName?: string;
  pair: string;
  exchange: string;
  isSandbox: boolean;
  mode: 'testnet' | 'live';
  strategy: TradingPosition['botMode'];
  stepLayer: number;
  maxLayers: number;
  averagingLayers?: number;
  gridLayers?: number;
  entryPrice: number;
  lastPrice: number;
  timeframe?: string;
  lastStrategyCandleTimestamp?: number | null;
  strategyPriceSource?: 'CLOSED_CANDLE' | string;
  strategySignalPrice?: number | null;
  strategySignalCloseTimestamp?: number | null;
  status: 'active' | 'paused' | 'error';
  positionQty: number;
  avgEntryPrice: number;
  realizedPnlToday: number;
  lastErrorReason?: string;
  resumeAfterReconciliation?: boolean;
  startupAutoResumeEnabled?: boolean;
  lastReconciledAt?: number;
  positionVersion?: number;
  pendingOrderStatus?: 'submitting' | 'reconciling' | 'unknown' | 'filled' | null;
  pendingClientOrderId?: string | null;
  pendingSide?: 'buy' | 'sell' | null;
  pendingRequestedQty?: number | null;
  pendingCreatedAt?: number | null;
  pendingExchangeOrderId?: string | null;
  recoveryState?: 'HEALTHY' | 'RECONCILIATION_PENDING' | 'STARTUP_RESUME_REQUIRED' | 'POSITION_LEDGER_MISMATCH' | 'ORDER_STATUS_UNCERTAIN' | 'ERROR';
  recoveryLabel?: string;
  recoveryMessage?: string;
  minPrice?: number | null;
  maxPrice?: number | null;
  priceBoundaryStatus?: string;
  baseTp?: number;
  gridTp?: number;
  tpCallbackPct?: number;
  tpPrice?: number | null;
  tpTargetPrice?: string | null;
  tpTriggerPrice?: string | null;
  executedLayerCount?: number;
  executedLayers?: TradingPosition['executedLayers'];
  closedLayerIds?: string[];
}

export function normalizeBotRuntimeState(input: any): BotRuntimeState {
  return {
    id: String(input?.id || input?.runnerId || input?.botId || ''),
    botId: input?.botId ? String(input.botId) : undefined,
    runnerId: input?.runnerId ? String(input.runnerId) : undefined,
    botName: input?.botName ? String(input.botName) : undefined,
    pair: String(input?.pair || ''),
    exchange: String(input?.exchange || '').trim().toLowerCase(),
    isSandbox: Boolean(input?.isSandbox),
    mode: input?.mode === 'live' ? 'live' : 'testnet',
    strategy: input?.strategy || 'Avarage Only',
    stepLayer: Number(input?.stepLayer || 0),
    maxLayers: (() => {
      const rawMax = Number(input?.maxLayers || 0);
      if (rawMax > 0) return rawMax;
      const strat = input?.strategy || 'Avarage Only';
      const avg = Number(input?.averagingLayers || 0);
      const grid = Number(input?.gridLayers || 0);
      if (strat === 'Avarage Only') return Math.max(1, avg || 10);
      if (strat === 'Grid Only') return Math.max(1, grid || 20);
      return Math.max(1, (avg || 8) + (grid || 10));
    })(),
    averagingLayers: Number(input?.averagingLayers) > 0 ? Number(input.averagingLayers) : (input?.strategy === 'Grid Only' ? 0 : 8),
    gridLayers: Number(input?.gridLayers) > 0 ? Number(input.gridLayers) : (input?.strategy === 'Avarage Only' ? 0 : 10),
    entryPrice: Number(input?.entryPrice || 0),
    lastPrice: Number(input?.lastPrice || 0),
    timeframe: input?.timeframe,
    lastStrategyCandleTimestamp: input?.lastStrategyCandleTimestamp ?? null,
    strategyPriceSource: input?.strategyPriceSource,
    strategySignalPrice: input?.strategySignalPrice ?? null,
    strategySignalCloseTimestamp: input?.strategySignalCloseTimestamp ?? null,
    status: input?.status === 'error' ? 'error' : input?.status === 'paused' ? 'paused' : 'active',
    positionQty: Number(input?.positionQty || 0),
    avgEntryPrice: Number(input?.avgEntryPrice || 0),
    realizedPnlToday: Number(input?.realizedPnlToday || 0),
    lastErrorReason: input?.lastErrorReason,
    resumeAfterReconciliation: input?.resumeAfterReconciliation === true,
    startupAutoResumeEnabled: input?.startupAutoResumeEnabled === true,
    lastReconciledAt: input?.lastReconciledAt,
    positionVersion: Number(input?.positionVersion || 0),
    pendingOrderStatus: input?.pendingOrderStatus ?? null,
    pendingClientOrderId: input?.pendingClientOrderId ?? null,
    pendingSide: input?.pendingSide ?? null,
    pendingRequestedQty: input?.pendingRequestedQty ?? null,
    pendingCreatedAt: input?.pendingCreatedAt ?? null,
    pendingExchangeOrderId: input?.pendingExchangeOrderId ?? null,
    recoveryState:
      input?.recoveryState
      ?? (
        String(input?.lastErrorReason || '').trim().toUpperCase() === 'POSITION_LEDGER_MISMATCH'
          ? 'POSITION_LEDGER_MISMATCH'
          : undefined
      ),
    recoveryLabel: input?.recoveryLabel,
    recoveryMessage: input?.recoveryMessage,
    minPrice: input?.minPrice ?? null,
    maxPrice: input?.maxPrice ?? null,
    priceBoundaryStatus: input?.priceBoundaryStatus,
    executedLayerCount: Number(input?.executedLayerCount ?? input?.executedLayers?.length ?? 0),
    closedLayerIds: Array.isArray(input?.closedLayerIds) ? input.closedLayerIds.map((id: any) => String(id)) : [],
    executedLayers: Array.isArray(input?.executedLayers)
      ? input.executedLayers.map((layer: any, index: number) => {
          const layerStep = Number(layer?.layerStep ?? layer?.layerNo ?? index + 1);
          const symbol = String(layer?.symbol || input?.pair || '');
          const coin = String(layer?.coin || symbol.split('/')[0] || symbol);
          const buyPrice = Number(layer?.buyPrice ?? layer?.fillPrice ?? 0);
          const amount = Number(layer?.amount ?? layer?.filledQty ?? 0);
          const costUsdt = Number(layer?.costUsdt ?? (amount * buyPrice));
          const currentPrice = Number(layer?.currentPrice ?? input?.lastPrice ?? buyPrice);
          const estimatedTpPct = Number(layer?.estimatedTpPct ?? 0);
          const estimatedTpPrice = Number(layer?.estimatedTpPrice ?? (buyPrice > 0 ? buyPrice * (1 + estimatedTpPct / 100) : 0));
          return {
            id: String(layer?.id || `${input?.id || input?.botId || 'bot'}-layer-${layerStep}-${layer?.orderId || index}`),
            orderId: String(layer?.orderId || layer?.exchangeOrderId || ''),
            symbol,
            coin,
            side: layer?.side === 'sell' ? 'sell' : 'buy',
            layerStep,
            layerType: layer?.layerType === 'grid' ? 'grid' : 'average',
            label: String(layer?.label || `BUY → ${amount} ${coin}`).trim(),
            amount,
            costUsdt,
            buyPrice,
            currentPrice,
            estimatedTpPrice,
            estimatedTpPct,
            estimatedTpUsdt: Number(layer?.estimatedTpUsdt ?? (costUsdt * estimatedTpPct / 100)),
            floatingPnlUsdt: Number(layer?.floatingPnlUsdt ?? ((currentPrice - buyPrice) * amount)),
            floatingPnlPct: Number(layer?.floatingPnlPct ?? (buyPrice > 0 ? ((currentPrice - buyPrice) / buyPrice) * 100 : 0)),
            fee: Number(layer?.fee ?? 0),
            feeAsset: String(layer?.feeAsset || 'USDT'),
            date: String(layer?.date || new Date(Number(layer?.timestamp || Date.now())).toISOString()),
            timestamp: Number(layer?.timestamp || Date.now()),
            isInitialEntry: Boolean(layer?.isInitialEntry),
            status: layer?.status === 'closed' ? 'closed' : 'filled',
          };
        })
      : undefined,
  };
}

export function isRuntimeBotForWallet(bot: BotRuntimeState, wallet: UserWallet): boolean {
  const exchange = String(wallet.connectedExchange?.exchange || '').trim().toLowerCase();
  if (exchange && bot.exchange && bot.exchange !== exchange) return false;

  if (wallet.connectedExchange?.isSandbox != null && bot.isSandbox !== Boolean(wallet.connectedExchange.isSandbox)) {
    return false;
  }

  return true;
}

export function hasOpenRuntimePosition(bot: BotRuntimeState): boolean {
  // A ledger mismatch is NOT a verified financial position.
  // Never project runtime/Firestore quantity into the portfolio view.
  if (bot.recoveryState === 'POSITION_LEDGER_MISMATCH') return false;

  return Number(bot.positionQty) > 0 && Number(bot.avgEntryPrice) > 0;
}

export function selectAuthoritativeRuntimeBots(
  engineBots: BotRuntimeState[],
  wallet: UserWallet,
  options: { openOnly?: boolean } = {},
): BotRuntimeState[] {
  return engineBots.filter((bot) => {
    if (!isRuntimeBotForWallet(bot, wallet)) return false;
    if (options.openOnly && !hasOpenRuntimePosition(bot)) return false;
    return true;
  });
}

export function runtimeBotToTradingPosition(
  bot: BotRuntimeState,
  projection?: TradingPosition,
): TradingPosition {
  const qty = Number(bot.positionQty || 0);
  const avgEntry = Number(bot.avgEntryPrice || 0);
  const marketPrice = Number(bot.lastPrice || 0);
  const costBasis = avgEntry > 0 && qty > 0 ? avgEntry * qty : 0;
  const floatingPnl = marketPrice > 0 && avgEntry > 0 && qty > 0
    ? (marketPrice - avgEntry) * qty
    : 0;
  const roiPct = costBasis > 0 ? (floatingPnl / costBasis) * 100 : 0;
  const coin = bot.pair.split('/')[0] || bot.pair;

  const metrics = computeAuthoritativeLayerMetrics({
    maxLayers: bot.maxLayers,
    maxStep: Number(projection?.maxStep || 0),
    stepLayer: Number(bot.stepLayer || projection?.stepLayer || 0),
    positionQty: qty,
    executedLayers: (Array.isArray(bot.executedLayers) && bot.executedLayers.length > 0) ? bot.executedLayers : projection?.executedLayers,
    executedLayerCount: Number(bot.executedLayerCount || projection?.executedLayerCount || 0),
    averagingLayers: bot.averagingLayers ?? projection?.averagingLayers,
    gridLayers: bot.gridLayers ?? projection?.gridLayers,
    strategy: bot.strategy,
    botMode: projection?.botMode,
  });

  const resolvedMaxStep = metrics.maxLayers;
  const effectiveStepLayer = metrics.filledLayers;

  const baseTp = Number((bot as any)?.baseTp ?? projection?.baseTp ?? 1.5);
  const tpCallbackPct = Number((bot as any)?.tpCallbackPct ?? projection?.tpCallbackPct ?? 0.2);
  const gridTp = Number((bot as any)?.gridTp ?? projection?.gridTp ?? 1.2);

  let computedTpPrice: number | undefined = undefined;
  let computedTpTargetPrice: string | undefined = undefined;
  let computedTpTriggerPrice: string | undefined = undefined;

  if (avgEntry > 0) {
    const rawTp = avgEntry * (1 + baseTp / 100);
    computedTpPrice = Number(rawTp.toFixed(rawTp < 1 ? 4 : 2));
    const formattedPrice = '$' + (rawTp < 1 ? rawTp.toFixed(4) : rawTp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
    computedTpTargetPrice = formattedPrice;
    computedTpTriggerPrice = `${formattedPrice} (+${baseTp}%)`;
  } else if (bot.strategy === 'Grid Only') {
    computedTpTargetPrice = `Sub-Grid (+${gridTp}%)`;
    computedTpTriggerPrice = `Sub-Grid (+${gridTp}%)`;
  } else {
    computedTpTargetPrice = `+${baseTp}% Trailing`;
    computedTpTriggerPrice = `+${baseTp}% Trailing`;
  }

  return {
    ...projection,
    id: bot.id,
    exchange: bot.exchange as TradingPosition['exchange'],
    isSandbox: bot.isSandbox,
    botId: bot.botId || projection?.botId || bot.id,
    botName: bot.botName || projection?.botName,
    pair: bot.pair,
    coin,
    badgeSymbol: coin.slice(0, 3).toUpperCase(),
    badgeBg: projection?.badgeBg || 'bg-slate-800',
    badgeColor: projection?.badgeColor || 'text-slate-200',
    price: marketPrice,
    change24h: projection?.change24h || 0,
    engine: `${bot.exchange || 'Exchange'} Spot ${bot.isSandbox ? '(Testnet)' : '(Live)'} · Backend Runtime`,
    botMode: bot.strategy,
    allocationQty: `${qty} ${coin}`,
    allocationUsdt: costBasis > 0 ? `${costBasis.toFixed(2)} USDT` : '0.00 USDT',
    stepLayer: effectiveStepLayer,
    maxStep: resolvedMaxStep,
    layerQuota: `${effectiveStepLayer} s/d ${resolvedMaxStep} Layer`,
    floatingPnl,
    roiPct,
    status: bot.status === 'active' ? 'active' : bot.status === 'error' ? 'averaging' : 'inactive',
    statusLabel: bot.status === 'active' ? 'AKTIF RUNNING' : bot.status === 'paused' ? 'PAUSED / STANDBY' : 'ERROR',
    avgBuyPrice: avgEntry,
    totalCoinQty: qty,
    totalCostUsdt: costBasis,
    timeframe: bot.timeframe,
    initialEntryPrice: bot.entryPrice,
    minPrice: Number(bot.minPrice) > 0 ? Number(bot.minPrice) : null,
    maxPrice: Number(bot.maxPrice) > 0 ? Number(bot.maxPrice) : null,
    priceBoundaryStatus: (() => {
      const minP = Number(bot.minPrice || 0);
      const maxP = Number(bot.maxPrice || 0);
      const priceForScale = bot.lastPrice > 0 ? bot.lastPrice : bot.entryPrice;
      if (!Number.isFinite(priceForScale) || priceForScale <= 0) return 'IN_RANGE';
      if (maxP > 0 && priceForScale > maxP) return 'ABOVE_MAX';
      if (minP > 0 && priceForScale < minP) return 'BELOW_MIN';
      return 'IN_RANGE';
    })(),
    closedLayerIds: (Array.isArray(bot.closedLayerIds) && bot.closedLayerIds.length > 0)
      ? bot.closedLayerIds
      : (Array.isArray(projection?.closedLayerIds) ? projection.closedLayerIds : []),
    executedLayers: (() => {
      const existing = (Array.isArray(bot.executedLayers) && bot.executedLayers.length > 0)
        ? bot.executedLayers
        : (Array.isArray(projection?.executedLayers) && projection.executedLayers.length > 0)
          ? projection.executedLayers
          : [];
      if (existing.length > 0) return existing;
      if (qty > 0 && avgEntry > 0) {
        return [{
          id: `runtime-${bot.id}-layer-1`,
          orderId: bot.botId || bot.id || 'entry-1',
          symbol: bot.pair,
          coin,
          side: 'buy' as const,
          layerStep: 1,
          layerType: (bot.strategy === 'Grid Only' ? 'grid' : 'average') as 'grid' | 'average',
          label: bot.strategy === 'Grid Only' ? `GRID INITIAL BUY -> ${qty.toFixed(4)} ${coin}` : `BUY -> ${qty.toFixed(4)} ${coin}`,
          amount: qty,
          costUsdt: Number(costBasis.toFixed(4)),
          buyPrice: avgEntry,
          currentPrice: marketPrice > 0 ? marketPrice : avgEntry,
          estimatedTpPrice: Number((avgEntry * (1 + baseTp / 100)).toFixed(4)),
          estimatedTpPct: baseTp,
          estimatedTpUsdt: Number((costBasis * (baseTp / 100)).toFixed(4)),
          floatingPnlUsdt: Number(floatingPnl.toFixed(4)),
          floatingPnlPct: Number(roiPct.toFixed(2)),
          fee: 0,
          feeAsset: 'USDT',
          date: 'Live execution snapshot',
          timestamp: Date.now(),
          isInitialEntry: true,
          status: 'filled' as const,
        }];
      }
      return [];
    })(),
    executedLayerCount: metrics.filledLayers,
    pairedCoins: projection?.pairedCoins,
    uptrendFilter: (bot as any)?.uptrendFilter !== undefined ? (bot as any).uptrendFilter : projection?.uptrendFilter,
    uptrendThresholdPct: (bot as any)?.uptrendThresholdPct !== undefined ? (bot as any).uptrendThresholdPct : projection?.uptrendThresholdPct,
    uptrendStatus: (bot as any)?.uptrendStatus || projection?.uptrendStatus,
    baseTp,
    tpCallbackPct,
    layerCallbackPct: projection?.layerCallbackPct,
    gridTp,
    averagingLayers: metrics.averagingMaxLayers,
    gridLayers: metrics.gridMaxLayers,
    averagingFilledLayers: metrics.averagingFilledLayers,
    gridFilledLayers: metrics.gridFilledLayers,
    trailingInfo: projection?.trailingInfo || 'Backend runner authoritative',
    trailingProgressPct: projection?.trailingProgressPct || 0,
    tpPrice: computedTpPrice,
    tpTriggerPrice: computedTpTriggerPrice,
    tpTargetPrice: computedTpTargetPrice,
    nextAveragingTrigger: projection?.nextAveragingTrigger,
    reserveStepsReady: projection?.reserveStepsReady,
    initialEntryAmount: projection?.initialEntryAmount,
  };
}
