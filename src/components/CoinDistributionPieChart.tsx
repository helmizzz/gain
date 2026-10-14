import { useState, useMemo } from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import { TradingPosition, UserWallet } from '../types';
import { SUPPORTED_COINS } from '../data/appData';
import { CoinLogo } from './common/CoinLogo';
import { PieChart as PieChartIcon, TrendingUp, TrendingDown, DollarSign, Percent, Sparkles, Layers } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

interface CoinDistributionPieChartProps {
  positions: TradingPosition[];
  wallet?: UserWallet;
  compact?: boolean;
}

interface ChartSliceData {
  name: string;
  coin: string;
  pair: string;
  value: number; // Nilai dalam USD
  percentage: number; // Porsi dalam %
  pnl: number; // PNL dalam USD
  pnlPct: number; // PNL ROI %
  color: string;
  status: string;
  stepLayer: number;
  maxStep: number;
}

const COIN_COLORS: Record<string, string> = {
  BTC: '#F59E0B', // Amber
  ETH: '#6366F1', // Indigo
  BNB: '#EAB308', // Yellow
  SOL: '#A855F7', // Purple
  HYPE: '#8DC63F', // Gecko Green
  LINK: '#3B82F6', // Blue
  TAO: '#2DD4BF', // Teal (Bittensor)
  NEAR: '#10B981', // Emerald
  XRP: '#0EA5E9', // Sky
  SUI: '#06B6D4', // Cyan
  ZEC: '#F59E0B', // Amber Gold (Zcash)
  DOGE: '#EAB308', // Yellow
  XAUT: '#D97706', // Gold (Tether Gold)
  AVAX: '#EF4444', // Red (Avalanche)
  TIA: '#EC4899', // Pink (Celestia)
  ASTER: '#8B5CF6', // Purple (Aster)
  USDT: '#10B981', // Emerald
};

const DEFAULT_COLORS = ['#8DC63F', '#3B82F6', '#F59E0B', '#A855F7', '#14B8A6', '#EC4899', '#EAB308', '#6366F1'];

export function CoinDistributionPieChart({
  positions,
  wallet,
  compact = false,
}: CoinDistributionPieChartProps) {
  const { theme } = useTheme();
  const [includeCash, setIncludeCash] = useState(true);
  const [activeCoinIndex, setActiveCoinIndex] = useState<number | null>(null);

  // Helper parse USD value
  const parseUsdt = (val: unknown): number => {
    if (typeof val === 'number') {
      return Number.isFinite(val) ? val : 0;
    }

    if (typeof val !== 'string') {
      return 0;
    }
    const cleaned = val.replace(/[^0-9.-]/g, '');
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const defaultCoinSet = useMemo(() => new Set(SUPPORTED_COINS.map((coin) => coin.coin.toUpperCase())), []);

  const realPortfolioAssets = useMemo(() => {
    const assets = wallet?.connectedExchange?.portfolioAssets || [];
    if (!Array.isArray(assets)) return [];
    return assets.filter((asset) => {
      const val = Number(asset?.valueUsdt || 0);
      const total = Number(asset?.total || 0);
      return val > 0 && total > 0;
    });
  }, [wallet?.connectedExchange?.portfolioAssets]);

  const exchangeCashUsdt = useMemo(() => {
    const connectedCash = Number(wallet?.connectedExchange?.usdtTotalBalance ?? wallet?.connectedExchange?.usdtBalance ?? 0);
    return Number.isFinite(connectedCash) && connectedCash > 0 ? connectedCash : 0;
  }, [wallet?.connectedExchange?.usdtTotalBalance, wallet?.connectedExchange?.usdtBalance]);

  const chartData = useMemo(() => {
    const items: Omit<ChartSliceData, 'percentage'>[] = [];
    if (realPortfolioAssets.length > 0) {
      realPortfolioAssets.forEach((asset, idx) => {
        const coin = String(asset.coin || asset.pair || '').split('/')[0].toUpperCase();
        const value = Number(asset.valueUsdt || 0);
        const matched = positions.find((pos) => String(pos?.coin ?? pos?.pair ?? '').split('/')[0].toUpperCase() === coin);
        if (value <= 0) return;
        const maxLayers = Math.max(1, Number(matched?.maxStep || 10));
        const executedCount = Number(matched?.executedLayerCount ?? matched?.executedLayers?.length ?? 0);
        const hasOpenQty = Number(matched?.totalCoinQty ?? 0) > 0 || value > 0;
        const rawStep = Math.max(0, Number(matched?.stepLayer) || 0);
        const effectiveStep = executedCount > 0
          ? Math.min(maxLayers, executedCount)
          : (hasOpenQty ? Math.min(maxLayers, Math.max(1, rawStep > 0 ? rawStep - 1 : 1)) : 0);

        items.push({
          name: coin,
          coin,
          pair: asset.pair || `${coin}/USDT`,
          value: Number(value.toFixed(2)),
          pnl: Number(matched?.floatingPnl ?? 0),
          pnlPct: Number(matched?.roiPct ?? asset.change24h ?? 0),
          color: COIN_COLORS[coin] || DEFAULT_COLORS[idx % DEFAULT_COLORS.length],
          status: matched?.status || 'active',
          stepLayer: effectiveStep,
          maxStep: maxLayers,
        });
      });
    } else {
      positions.forEach((pos, idx) => {
        const coin = String(pos?.coin ?? pos?.pair ?? '').split('/')[0].toUpperCase();
        const val = parseUsdt(pos.allocationUsdt);
        if (val <= 0) return;
        const maxLayers = Math.max(1, Number(pos?.maxStep || 10));
        const executedCount = Number(pos?.executedLayerCount ?? pos?.executedLayers?.length ?? 0);
        const hasOpenQty = Number(pos?.totalCoinQty ?? 0) > 0 || val > 0;
        const rawStep = Math.max(0, Number(pos?.stepLayer) || 0);
        const effectiveStep = executedCount > 0
          ? Math.min(maxLayers, executedCount)
          : (hasOpenQty ? Math.min(maxLayers, Math.max(1, rawStep > 0 ? rawStep - 1 : 1)) : 0);

        items.push({
          name: coin,
          coin,
          pair: pos.pair || `${coin}/USDT`,
          value: Number(val.toFixed(2)),
          pnl: Number(pos.floatingPnl ?? 0),
          pnlPct: Number(pos.roiPct || pos.change24h || 0),
          color: COIN_COLORS[coin] || DEFAULT_COLORS[idx % DEFAULT_COLORS.length],
          status: pos.status,
          stepLayer: effectiveStep,
          maxStep: maxLayers,
        });
      });
    }

    if (includeCash && exchangeCashUsdt > 0) {
      items.push({
        name: 'USDT Cash',
        coin: 'USDT',
        pair: `${wallet?.connectedExchange?.exchange || 'Exchange'} USDT Cash`,
        value: Number(exchangeCashUsdt.toFixed(2)),
        pnl: 0,
        pnlPct: 0,
        color: COIN_COLORS.USDT || '#10B981',
        status: 'active',
        stepLayer: 0,
        maxStep: 100,
      });
    }

    const itemsSum = items.reduce((acc, curr) => acc + curr.value, 0);
    const authoritativeTotal = Number(wallet?.connectedExchange?.totalPortfolioUsdt ?? 0);

    if (includeCash && authoritativeTotal > itemsSum + 1) {
      const remainingValue = Number((authoritativeTotal - itemsSum).toFixed(2));
      items.push({
        name: 'Aset Lainnya',
        coin: 'OTHER',
        pair: 'Aset Bursa Lainnya',
        value: remainingValue,
        pnl: 0,
        pnlPct: 0,
        color: '#64748B',
        status: 'active',
        stepLayer: 0,
        maxStep: 0,
      });
    }

    // Sort descending by value so largest holdings (BTC, USDT Cash) appear first
    items.sort((a, b) => b.value - a.value);

    const totalVal = items.reduce((acc, curr) => acc + curr.value, 0);
    return items.map((item) => ({ ...item, percentage: totalVal > 0 ? Number(((item.value / totalVal) * 100).toFixed(1)) : 0 }));
  }, [positions, wallet?.connectedExchange?.exchange, wallet?.connectedExchange?.totalPortfolioUsdt, includeCash, realPortfolioAssets, exchangeCashUsdt]);

  const displayedTotalValue = useMemo(() => {
    return chartData.reduce((acc, curr) => acc + curr.value, 0);
  }, [chartData]);

  const totalPortfolioValue = useMemo(() => {
    const authoritative = Number(wallet?.connectedExchange?.totalPortfolioUsdt ?? 0);
    return authoritative > 0 ? authoritative : displayedTotalValue;
  }, [wallet?.connectedExchange?.totalPortfolioUsdt, displayedTotalValue]);

  const totalPnl = useMemo(() => {
    return chartData.reduce((acc, curr) => acc + curr.pnl, 0);
  }, [chartData]);

  const activeSlice: ChartSliceData | undefined =
    activeCoinIndex !== null && chartData[activeCoinIndex]
      ? chartData[activeCoinIndex]
      : undefined;

  return (
    <div className="theme-surface p-4 rounded-2xl border shadow-xl space-y-4 transition-colors">
      {/* Header with Title and Cash Toggle */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-[#8DC63F]/10 border border-[#8DC63F]/30 flex items-center justify-center text-[#8DC63F]">
            <PieChartIcon className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white tracking-wide flex items-center gap-1.5 font-sans">
              <span>Distribusi Komposisi Koin</span>
              <span className="px-1.5 py-0.2 rounded text-[9px] font-mono bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-[#8DC63F] border border-emerald-500/30 font-bold">
                {SUPPORTED_COINS.length} Koin Default ({chartData.length} Aset Bursa)
              </span>
            </h3>
            <p className="text-[10px] text-slate-500 dark:text-slate-400 font-sans">
              Porsi (%) · Nilai Bursa Riil ($) · Floating PNL · Kas USDT Bursa ${exchangeCashUsdt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        {wallet && (
          <button
            onClick={() => setIncludeCash((prev) => !prev)}
            title={`Kas USDT bursa: $${exchangeCashUsdt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            className={`px-2.5 py-1 rounded-lg text-xs font-mono transition flex items-center gap-1.5 border cursor-pointer ${
              includeCash
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-[#8DC63F] font-bold'
                : 'bg-slate-50 dark:bg-[#1C2A3D] border-slate-200 dark:border-[#283952] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${includeCash ? 'bg-[#8DC63F]' : 'bg-slate-500'}`} />
            <span>{includeCash ? `Termasuk Kas USDT ($${exchangeCashUsdt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : `+ Tambah Kas USDT ($${exchangeCashUsdt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`}</span>
          </button>
        )}
      </div>

      {/* Summary KPI Pills */}
      <div className="grid grid-cols-3 gap-2 font-mono text-xs">
        <div className="theme-surface-secondary p-2.5 rounded-xl border">
          <div className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400 uppercase font-sans">
            <DollarSign className="w-3 h-3 text-[#8DC63F]" />
            <span>Total Nilai ($)</span>
          </div>
          <span className="text-sm font-bold text-slate-900 dark:text-white mt-1 block font-mono">
            ${displayedTotalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>

        <div className="theme-surface-secondary p-2.5 rounded-xl border">
          <div className="flex items-center gap-1 text-[10px] text-slate-400 uppercase">
            <Percent className="w-3 h-3 text-emerald-400" />
            <span>Akumulasi PNL</span>
          </div>
          <span
            className={`text-sm font-bold mt-1 block font-mono ${
              totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`}
          </span>
        </div>

        <div className="theme-surface-secondary p-2.5 rounded-xl border">
          <div className="flex items-center gap-1 text-[10px] text-slate-400 uppercase">
            <Sparkles className="w-3 h-3 text-amber-400" />
            <span>Porsi Dominan</span>
          </div>
          <div className="text-xs font-bold text-slate-900 dark:text-white mt-1 truncate">
            {chartData.length > 0
              ? `${chartData[0].coin} (${chartData[0].percentage}%)`
              : '-'}
          </div>
        </div>
      </div>

      {/* Main Visuals: Donut Chart + Center Focus Badge */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center pt-2 min-w-0">
        {/* Donut Chart Canvas */}
        <div className="md:col-span-6 min-w-0 w-full flex flex-col items-center justify-center relative">
          <div className="w-full max-w-full min-w-0 h-56 relative flex items-center justify-center overflow-hidden">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={62}
                  outerRadius={92}
                  paddingAngle={3}
                  dataKey="value"
                  onMouseEnter={(_, index) => setActiveCoinIndex(index)}
                  onMouseLeave={() => setActiveCoinIndex(null)}
                >
                  {chartData.map((entry, index) => (
                    <Cell
                      key={`cell-${entry.coin}-${index}`}
                      fill={entry.color}
                      stroke={theme === 'light' ? '#FFFFFF' : '#08101D'}
                      strokeWidth={3}
                      className="cursor-pointer transition-opacity duration-200"
                      opacity={activeCoinIndex === null || activeCoinIndex === index ? 1 : 0.45}
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>

            {/* Donut Center Focus Display (Replaces floating tooltip to prevent collision) */}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center px-4">
              {activeSlice ? (
                <>
                  <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider truncate max-w-[110px]">
                    {activeSlice.pair}
                  </span>
                  <span className="text-lg font-black font-mono text-slate-900 dark:text-white">
                    {activeSlice.percentage}%
                  </span>
                  <span className="text-[10px] font-mono font-bold text-slate-700 dark:text-slate-200">
                    ${activeSlice.value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                  </span>
                  <span
                    className={`text-[9px] font-mono font-bold ${
                      activeSlice.pnl >= 0 ? 'text-emerald-500 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'
                    }`}
                  >
                    {activeSlice.pnl >= 0 ? `+$${activeSlice.pnl.toFixed(2)}` : `-$${Math.abs(activeSlice.pnl).toFixed(2)}`}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                    {includeCash ? 'Portofolio' : 'Aset Koin'}
                  </span>
                  <span className="text-base font-black font-mono text-slate-900 dark:text-white">
                    100%
                  </span>
                  <span className="text-[10px] font-mono text-[#8DC63F]">
                    ${displayedTotalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="text-[11px] text-slate-400 font-mono text-center mt-1">
            {chartData.length > 0 ? 'Sentuh atau hover sektor koin untuk melihat rincian' : `Belum ada saldo bernilai dari ${SUPPORTED_COINS.length} koin default exchange.`}
          </div>
        </div>

        {/* Breakdown List (Porsi %, Nilai $, PNL) */}
        <div className="md:col-span-6 space-y-2 max-h-72 overflow-y-auto custom-scrollbar pr-1">
          {chartData.map((item, index) => {
            const isHovered = activeCoinIndex === index;
            return (
              <div
                key={`${item.coin || "asset"}-${index}`}
                onMouseEnter={() => setActiveCoinIndex(index)}
                onMouseLeave={() => setActiveCoinIndex(null)}
                className={`p-2.5 rounded-xl border transition cursor-pointer flex items-center justify-between gap-2 text-xs font-mono ${
                  isHovered
                    ? 'bg-slate-100 dark:bg-[#0E1B2E] border-[#8DC63F]/60 shadow-md'
                    : 'bg-slate-50 dark:bg-[#060B14] border-slate-200 dark:border-[#121E31] hover:border-[#8DC63F]/30'
                }`}
              >
                {/* Left: Coin identifier & Color */}
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: item.color }}
                  />
                  {item.coin !== 'USDT' && item.coin !== 'OTHER' ? (
                    <CoinLogo coin={item.coin} size="xs" />
                  ) : item.coin === 'USDT' ? (
                    <div className="w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 flex items-center justify-center text-[10px] font-bold shrink-0">
                      $
                    </div>
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-slate-700/30 border border-slate-600/40 text-slate-400 flex items-center justify-center text-[10px] font-bold shrink-0">
                      <Layers className="w-3 h-3" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-white text-xs">{item.coin}</span>
                      {item.stepLayer > 0 && (
                        <span className="px-1 py-0.2 rounded text-[9px] bg-slate-800 text-slate-300">
                          L{item.stepLayer}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-slate-400 truncate block">
                      {item.pair}
                    </span>
                  </div>
                </div>

                {/* Center: Porsi % Badge */}
                <div className="text-center px-2 py-1 rounded-md bg-[#081220] border border-[#142338]">
                  <span className="text-[10px] text-slate-400 block">Porsi</span>
                  <span className="font-bold text-white text-xs">{item.percentage}%</span>
                </div>

                {/* Right: Nilai $ & PNL */}
                <div className="text-right shrink-0">
                  <span className="font-bold text-white text-xs block">
                    ${item.value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
                  </span>
                  <span
                    className={`text-[10px] font-bold flex items-center justify-end gap-0.5 ${
                      item.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {item.pnlPct >= 0 ? (
                      <TrendingUp className="w-2.5 h-2.5 inline" />
                    ) : (
                      <TrendingDown className="w-2.5 h-2.5 inline" />
                    )}
                    <span>
                      {item.pnl !== 0 ? (
                        <>
                          {item.pnl > 0 ? '+' : ''}${item.pnl.toFixed(2)} <span className="opacity-75">({item.pnlPct > 0 ? '+' : ''}{item.pnlPct.toFixed(2)}%)</span>
                        </>
                      ) : (
                        `${item.pnlPct > 0 ? '+' : ''}${item.pnlPct.toFixed(2)}%`
                      )}
                    </span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
