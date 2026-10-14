import React, { useState, useMemo } from 'react';
import {
  X,
  Layers,
  ArrowUpRight,
  ArrowDownLeft,
  DollarSign,
  TrendingUp,
  TrendingDown,
  Clock,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ShieldCheck,
} from 'lucide-react';
import { TradingPosition, ExecutedLayerDetail } from '../../types';
import { formatUsdt } from '../../utils/formatters';
import { generateDefaultLayersForPosition } from '../../utils/tradingPositionUtils';
import { getBotModeLabel, normalizeBotMode } from '../../utils/botModeLabels';
import { computeAuthoritativeLayerMetrics } from '../../utils/botLayerUtils';
import { CoinLogo } from '../common/CoinLogo';

interface TradeDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  position: TradingPosition | null;
  onForceTakeProfit?: (positionId: string) => void;
  onCloseLayer?: (positionId: string, layerId: string) => void;
}

export function TradeDetailModal({
  isOpen,
  onClose,
  position,
  onForceTakeProfit,
  onCloseLayer,
}: TradeDetailModalProps) {
  const [closingLayerId, setClosingLayerId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'average' | 'grid'>('all');
  const [localClosedIds, setLocalClosedIds] = useState<Set<string>>(new Set());

  const closedLayerIds = useMemo(() => {
    const set = new Set(position?.closedLayerIds || []);
    localClosedIds.forEach((id) => set.add(id));
    return set;
  }, [position?.closedLayerIds, localClosedIds]);

  if (!isOpen || !position) return null;

  const isHybrid = position.botMode === 'Avarage+Grid';
  const isGridOnly = position.botMode === 'Grid Only';

  const hasOpenQuantity = Number(position.totalCoinQty ?? 0) > 0 || parseFloat(String(position.allocationQty || '0')) > 0;

  // Safe deduplication that works whether layer has orderId, id, or generated key
  const rawLayers = Array.isArray(position.executedLayers) ? position.executedLayers : [];
  const uniqueExecutedLayers = rawLayers.filter((layer, index, list) => {
    const id = layer.id || layer.orderId;
    if (!id) return true;
    return list.findIndex((candidate) => (candidate.id && candidate.id === layer.id) || (candidate.orderId && layer.orderId && candidate.orderId === layer.orderId)) === index;
  });

  // Calculate layer metrics dynamically factoring in closed layers
  const layerMetrics = computeAuthoritativeLayerMetrics({
    ...position,
    closedLayerIds: Array.from(closedLayerIds),
    executedLayers: uniqueExecutedLayers.map((l) => closedLayerIds.has(l.id) ? { ...l, status: 'closed' } : l),
  });
  const maxLayers = layerMetrics.maxLayers;
  const filledLayerCount = layerMetrics.filledLayers;

  // If no executedLayers array was sent but bot has an open position, generate default layer(s) matching filled count
  const allLayers: ExecutedLayerDetail[] =
    uniqueExecutedLayers.length > 0
      ? uniqueExecutedLayers
      : (filledLayerCount > 0 || hasOpenQuantity)
        ? generateDefaultLayersForPosition(position, filledLayerCount || 1)
        : [];

  const layers = allLayers;
  const isProfitable = (position.floatingPnl ?? 0) >= 0;

  // Dynamically compute active non-closed layers and their true weighted average entry price
  const activeLayers = layers.filter((layer) => {
    const isClosed = closedLayerIds.has(layer.id) || String(layer.status || '').toLowerCase() === 'closed';
    const isSell = String(layer.side || '').toLowerCase() === 'sell';
    return !isClosed && !isSell;
  });

  const activeDcaLayers = activeLayers.filter((l) => l.layerType !== 'grid');
  const activeDcaQty = activeDcaLayers.reduce((sum, l) => sum + Number(l.amount || 0), 0);
  const activeDcaCost = activeDcaLayers.reduce((sum, l) => sum + (Number(l.costUsdt) || (Number(l.buyPrice) * Number(l.amount)) || 0), 0);

  const dynamicAvgPrice = activeDcaQty > 0
    ? activeDcaCost / activeDcaQty
    : Number(position.avgBuyPrice || position.initialEntryPrice || 0);

  const baseTp = Number(position.baseTp || 1.5);
  const avgEntryPrice = dynamicAvgPrice > 0 ? dynamicAvgPrice : Number(position.avgBuyPrice || position.initialEntryPrice || 0);
  const targetTpPrice = position.tpPrice || (avgEntryPrice > 0 ? avgEntryPrice * (1 + baseTp / 100) : null);
  const formattedTpTarget = targetTpPrice != null && targetTpPrice > 0
    ? `$${targetTpPrice < 1 ? targetTpPrice.toFixed(4) : targetTpPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
    : (position.tpTargetPrice || `+${baseTp}%`);

  const dcaLayersList = layers.filter((l) => l.layerType !== 'grid');
  const gridLayersList = layers.filter((l) => l.layerType === 'grid');
  const displayedLayers = activeTab === 'all'
    ? layers
    : activeTab === 'average'
      ? dcaLayersList
      : gridLayersList;

  const handleCloseSingleLayer = async (layerId: string) => {
    setClosingLayerId(layerId);
    try {
      if (onCloseLayer) {
        await onCloseLayer(position.id, layerId);
        setLocalClosedIds((prev) => new Set([...prev, layerId]));
      }
    } finally {
      setClosingLayerId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/75 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-2xl bg-white dark:bg-[#0C1322] border border-slate-200 dark:border-slate-800 rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh] text-slate-900 dark:text-slate-100">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800/80 flex items-center justify-between bg-slate-50 dark:bg-[#080E1A]">
          <div className="flex items-center gap-3">
            <CoinLogo coin={position.coin} size="lg" />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900 dark:text-white font-mono">{position.pair}</h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/30">
                  {getBotModeLabel(normalizeBotMode(position.botMode), 'id')}
                </span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                  position.status === 'active'
                    ? 'bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700'
                }`}>
                  {position.statusLabel || position.status}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-sans mt-0.5">
                Bot ID: <span className="font-mono text-slate-700 dark:text-slate-300">{position.botId || position.id}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center justify-center transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Overview Stats Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-4 bg-slate-100/70 dark:bg-[#080E1A]/60 border-b border-slate-200 dark:border-slate-800/80">
          <div className="p-3 rounded-xl bg-white dark:bg-[#111A29] border border-slate-200/90 dark:border-slate-800/90 shadow-2xs">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider block font-mono font-medium">Harga Saat Ini</span>
            <span className="text-sm font-extrabold text-slate-900 dark:text-white font-mono block mt-0.5">${position.price?.toFixed(4) || '0.0000'}</span>
            <span className={`text-[10px] font-mono block font-semibold ${position.change24h >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {position.change24h >= 0 ? '+' : ''}{position.change24h?.toFixed(2)}%
            </span>
          </div>

          <div className="p-3 rounded-xl bg-white dark:bg-[#111A29] border border-slate-200/90 dark:border-slate-800/90 shadow-2xs">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider block font-mono font-medium">Floating PnL</span>
            <span className={`text-sm font-extrabold font-mono block mt-0.5 ${isProfitable ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {isProfitable ? '+' : ''}{position.floatingPnl != null ? `$${position.floatingPnl.toFixed(2)}` : '$0.00'}
            </span>
            <span className={`text-[10px] font-mono block font-semibold ${isProfitable ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              ROI: {position.roiPct != null ? `${position.roiPct.toFixed(2)}%` : '0.00%'}
            </span>
          </div>

          <div className="p-3 rounded-xl bg-white dark:bg-[#111A29] border border-slate-200/90 dark:border-slate-800/90 shadow-2xs">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider block font-mono font-medium">
              {isHybrid ? 'Layer Terisi (Hybrid)' : 'Total Layer'}
            </span>
            {isHybrid ? (
              <div className="flex items-center gap-1.5 mt-0.5 font-mono text-xs font-extrabold flex-wrap">
                <span className="text-amber-600 dark:text-amber-400">DCA: {layerMetrics.averagingFilledLayers}/{layerMetrics.averagingMaxLayers}</span>
                <span className="text-slate-400 font-normal">·</span>
                <span className="text-emerald-600 dark:text-emerald-400">Grid: {layerMetrics.gridFilledLayers}/{layerMetrics.gridMaxLayers}</span>
              </div>
            ) : (
              <span className="text-sm font-extrabold text-amber-600 dark:text-amber-400 font-mono block mt-0.5">
                Layer {filledLayerCount || layers.length} / {maxLayers}
              </span>
            )}
            <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono block truncate mt-0.5">
              Alokasi: {position.allocationUsdt || '$0.00'}
            </span>
          </div>

          <div className="p-3 rounded-xl bg-white dark:bg-[#111A29] border border-slate-200/90 dark:border-slate-800/90 shadow-2xs">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider block font-mono font-medium">Target Take Profit</span>
            <span className="text-sm font-extrabold text-[#74b72e] dark:text-[#8DC63F] font-mono block mt-0.5">
              {formattedTpTarget}
            </span>
            <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono block truncate">
              {isGridOnly ? 'Sub-Grid Osilasi' : `+${baseTp}% (Trailing ${position.tpCallbackPct || 0.2}%)`}
            </span>
          </div>
        </div>

        {/* Executed Layers List */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3 bg-slate-50/60 dark:bg-[#09101C]">
          <div className="flex items-center justify-between pb-1 flex-wrap gap-2">
            <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1.5 font-mono">
              <Layers className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
              {isHybrid
                ? `Rincian Layer Hybrid (${layerMetrics.averagingFilledLayers} DCA · ${layerMetrics.gridFilledLayers} Grid / ${maxLayers} Total)`
                : `Detail Layer (${filledLayerCount} Terisi / ${maxLayers} Total)`}
            </h3>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 font-semibold">
              Matrix Engine Active
            </span>
          </div>

          {/* Tab Filter for Hybrid Mode */}
          {isHybrid && (
            <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-200/70 dark:bg-[#070D18] border border-slate-200 dark:border-[#132034] text-xs font-mono">
              <button
                type="button"
                onClick={() => setActiveTab('all')}
                className={`px-3 py-1 rounded-lg font-bold transition cursor-pointer ${
                  activeTab === 'all'
                    ? 'bg-white dark:bg-[#152338] text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Semua Layer ({layers.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('average')}
                className={`px-3 py-1 rounded-lg font-bold transition cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'average'
                    ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 shadow-xs'
                    : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                DCA Averaging ({dcaLayersList.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('grid')}
                className={`px-3 py-1 rounded-lg font-bold transition cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'grid'
                    ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 shadow-xs'
                    : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Grid Osilasi ({gridLayersList.length})
              </button>
            </div>
          )}

          {displayedLayers.length === 0 ? (
            <div className="p-6 rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400 font-mono text-center bg-white dark:bg-[#0D1524]">
              {activeTab === 'grid'
                ? 'Belum ada layer Grid yang terisi. Layer Grid akan otomatis aktif saat harga bergerak dalam koridor rentang batas harga.'
                : activeTab === 'average'
                ? 'Belum ada layer DCA yang terisi.'
                : 'Belum ada layer yang terisi. Layer akan otomatis muncul setelah order eksekusi terisi di bursa.'}
            </div>
          ) : null}

          {displayedLayers.map((layer) => {
            const layerPnlPositive = (layer.floatingPnlUsdt ?? 0) >= 0;
            const isGridLayer = layer.layerType === 'grid';
            return (
              <div
                key={layer.id}
                className="p-3.5 rounded-2xl bg-white dark:bg-[#0E1726] border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 transition shadow-2xs"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`w-5 h-5 rounded-full font-bold text-[10px] font-mono flex items-center justify-center border ${
                      isGridLayer
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
                        : 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30'
                    }`}>
                      L{layer.layerStep}
                    </span>
                    <span className="text-xs font-bold text-slate-900 dark:text-white font-mono">{layer.label}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono uppercase font-bold ${
                      isGridLayer
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                        : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                    }`}>
                      {isGridLayer ? 'Grid Step' : 'Averaging DCA'}
                    </span>
                    {layer.isInitialEntry && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30">
                        Base Entry
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">{layer.date}</span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono pt-2 border-t border-slate-100 dark:border-slate-800/80">
                  <div>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 block font-medium">Buy Price:</span>
                    <span className="text-slate-900 dark:text-slate-100 font-semibold">${layer.buyPrice.toFixed(4)}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 block font-medium">Cost / Size:</span>
                    <span className="text-slate-900 dark:text-slate-100 font-semibold">${layer.costUsdt.toFixed(2)} USDT</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 block font-medium">Est. TP:</span>
                    <span className="text-[#74b72e] dark:text-[#8DC63F] font-semibold">${layer.estimatedTpPrice.toFixed(4)} (+{layer.estimatedTpPct}%)</span>
                  </div>
                  <div className="flex items-center justify-between sm:justify-end gap-2">
                    <div>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 block sm:text-right font-medium">PnL:</span>
                      <span className={`font-bold ${layerPnlPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                        {layerPnlPositive ? '+' : ''}${layer.floatingPnlUsdt.toFixed(2)}
                      </span>
                    </div>
                    {onCloseLayer && (
                      <button
                        onClick={() => handleCloseSingleLayer(layer.id)}
                        disabled={closingLayerId === layer.id || closedLayerIds.has(layer.id)}
                        className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 dark:bg-rose-500/20 dark:hover:bg-rose-500/30 dark:text-rose-300 dark:border-rose-500/40 transition cursor-pointer disabled:opacity-50"
                      >
                        {closingLayerId === layer.id ? 'Closing...' : closedLayerIds.has(layer.id) ? 'Closed' : 'Close'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Next Strategy Trigger Roadmap */}
          {position.status === 'active' && avgEntryPrice > 0 && (
            <div className="p-3.5 rounded-2xl bg-gradient-to-r from-amber-500/5 via-sky-500/5 to-emerald-500/5 border border-slate-200 dark:border-[#152338] space-y-2 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-sky-500" />
                  Roadmap Eksekusi Bot Selanjutnya
                </span>
                <span className="text-[10px] text-slate-400">Target Otomatis</span>
              </div>
              <div className={`grid grid-cols-1 ${layerMetrics.averagingFilledLayers < layerMetrics.averagingMaxLayers ? 'sm:grid-cols-3' : 'sm:grid-cols-2'} gap-2 text-[11px] pt-1`}>
                <div className="p-2.5 rounded-xl bg-white/80 dark:bg-[#0C1424] border border-slate-200/80 dark:border-slate-800">
                  <span className="text-slate-400 block text-[10px]">Harga Rata-Rata Beli (Posisi Aktif):</span>
                  <span className="font-bold text-sky-600 dark:text-sky-400">
                    ${avgEntryPrice < 1 ? avgEntryPrice.toFixed(4) : avgEntryPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                  </span>
                  <span className="text-[10px] text-slate-500 block truncate">
                    {activeDcaLayers.length > 0 ? `${activeDcaLayers.length} Layer DCA Aktif (${activeDcaQty.toFixed(4)} ${position.coin})` : 'Baseline Entry Aktif'}
                  </span>
                </div>
                <div className="p-2.5 rounded-xl bg-white/80 dark:bg-[#0C1424] border border-slate-200/80 dark:border-slate-800">
                  <span className="text-slate-400 block text-[10px]">Pemicu Take Profit (Basket Exit):</span>
                  <span className="font-bold text-emerald-600 dark:text-emerald-400">
                    {formattedTpTarget} (+{baseTp}%)
                  </span>
                  <span className="text-[10px] text-slate-500 block">Trailing Lock Profit: {position.tpCallbackPct || 0.2}% Rebound</span>
                </div>
                {layerMetrics.averagingFilledLayers < layerMetrics.averagingMaxLayers && (
                  <div className="p-2.5 rounded-xl bg-white/80 dark:bg-[#0C1424] border border-slate-200/80 dark:border-slate-800">
                    <span className="text-slate-400 block text-[10px]">Pemicu DCA Berikutnya (Layer #{layerMetrics.averagingFilledLayers + 1}):</span>
                    <span className="font-bold text-amber-600 dark:text-amber-400">
                      ${(avgEntryPrice * (1 - (position.layerCallbackPct || 1.0) / 100)).toFixed(avgEntryPrice < 1 ? 4 : 2)} (-{(position.layerCallbackPct || 1.0)}%)
                    </span>
                    <span className="text-[10px] text-slate-500 block">Jaring Beli Otomatis Siaga</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#080E1A] flex items-center justify-between gap-3">
          <div className="text-xs text-slate-600 dark:text-slate-400 font-mono flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <span>Auto Stop-Loss & Dynamic Matrix Protected</span>
          </div>

          <div className="flex items-center gap-2">
            {onForceTakeProfit && (
              <button
                onClick={() => {
                  onForceTakeProfit(position.id);
                  onClose();
                }}
                className="px-4 py-2 rounded-xl text-xs font-bold font-mono bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white transition shadow-md shadow-emerald-600/20 active:scale-95 cursor-pointer"
              >
                Force Take Profit
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-bold font-mono bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition cursor-pointer"
            >
              Tutup
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
