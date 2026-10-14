import { useState, useEffect } from 'react';
import { fetchBatchTickers, LIVE_TICKER_SYMBOLS, type ExchangeTicker } from '../api/exchangeApi';
import { useLanguage } from '../context/LanguageContext';
import { UserWallet, TradingPosition, BotMode } from '../types';
import { FINANCIAL_CONFIG } from '../config/financialConfig';
import { deriveAllocatedAssetUsdt } from '../utils/portfolioSnapshot';
import { CoinDistributionPieChart } from '../components/CoinDistributionPieChart';
import { CoinLogo } from '../components/common/CoinLogo';
import { SUPPORTED_COINS } from '../data/appData';
import { computeAuthoritativeLayerMetrics } from '../utils/botLayerUtils';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Sliders,
  Key,
  ShieldCheck,
  ChevronRight,
  TrendingUp,
  Layers,
  Users,
  Zap,
  Fuel,
  Building2,
  CheckCircle2,
  PieChart as PieChartIcon,
  Bell,
  Filter,
  RotateCcw,
  Bot,
  Grid,
  ArrowRight,
} from 'lucide-react';
import { formatUsdt, formatPercent } from '../utils/formatters';
import { selectAuthoritativeRuntimeBots, type BotRuntimeState } from '../utils/botRuntimePositions';
import { CustomizeHomeModal, DashboardCustomization, DEFAULT_DASHBOARD_CUSTOMIZATION } from '../components/modals/CustomizeHomeModal';
import { HomeFilterModal, HomeFilterState, DEFAULT_HOME_FILTER } from '../components/modals/HomeFilterModal';
import { useBinanceWebSocket } from '../hooks/useBinanceWebSocket';

export type HomePillTab = 'semua' | 'highlights' | 'spot-vault' | 'gas-tank' | 'dca-martingale' | 'grid-strategy';

interface HomeViewProps {
  wallet: UserWallet;
  positions: TradingPosition[];
  engineBots?: BotRuntimeState[];
  engineStatus?: 'loading' | 'ready' | 'error';
  onOpenDeposit: () => void;
  onOpenWithdraw: () => void;
  onOpenCustomBot: (
    pair?: string,
    mode?: BotMode,
    layers?: number,
    botId?: string | null,
    botName?: string,
    isNewBot?: boolean,
    minPrice?: number | null,
    maxPrice?: number | null,
    pairedCoins?: string[]
  ) => void;
  onOpenApiKey: () => void;
  onNavigateTrading: () => void;
  onOpenProfitShare: () => void;
  onOpenTransfer: () => void;
  onNavigateAccount?: () => void;
  onOpenPriceAlert?: (symbol?: string) => void;
  onOpenGasModal?: () => void;
}

export function HomeView({
  wallet,
  positions,
  engineBots = [],
  engineStatus = 'loading',
  onOpenDeposit,
  onOpenWithdraw,
  onOpenCustomBot,
  onOpenApiKey,
  onNavigateTrading,
  onOpenProfitShare,
  onOpenTransfer,
  onNavigateAccount,
  onOpenPriceAlert,
  onOpenGasModal,
}: HomeViewProps) {
  const { t } = useLanguage();

  const [marketData, setMarketData] = useState<Record<string, ExchangeTicker>>({});
  const wsTickers = useBinanceWebSocket(wallet.connectedExchange?.isSandbox);

  useEffect(() => {
    let isMounted = true;
    const fetchTickers = async () => {
      try {
        const response = await fetchBatchTickers('binance', LIVE_TICKER_SYMBOLS);
        if (isMounted && response.success) {
          setMarketData(response.tickers);
        }
      } catch (error) {
        console.warn('[HomeView] Failed to fetch market data:', error);
      }
    };
    fetchTickers();
    // Refresh data periodically as fallback
    const intervalId = setInterval(fetchTickers, 60000); // refresh every 60 seconds
    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, []);

  // Merge WebSocket tickers for absolute realtime Updates
  const mergedMarketData = { ...marketData, ...wsTickers };


  const trendingList = ['BTC', 'ETH', 'SOL', 'BNB'].map(symbol => {
    const coinDef = SUPPORTED_COINS.find(c => c.coin === symbol);
    const ticker = coinDef ? mergedMarketData[coinDef.pair] : null;
    const price = ticker?.last || coinDef?.price || 0;
    const change = ticker?.percentage || coinDef?.change24h || 0;
    return { ...(coinDef || {}), coin: symbol, price, change };
  });

  const topGainersList = SUPPORTED_COINS.map(coinDef => {
    const ticker = mergedMarketData[coinDef.pair];
    const price = ticker?.last || coinDef.price || 0;
    const change = ticker?.percentage || coinDef.change24h || 0;
    return { ...coinDef, price, change };
  }).sort((a, b) => b.change - a.change).slice(0, 4);

  // State 1: Active Pill Tab Filter
  const [activePill, setActivePill] = useState<HomePillTab>('semua');

  // State 2: Customization Modal & Local Storage Settings
  const [isCustomizeModalOpen, setIsCustomizeModalOpen] = useState(false);
  const [customization, setCustomization] = useState<DashboardCustomization>(() => {
    try {
      const saved = localStorage.getItem('gain_home_customization');
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('[GAIN_HOME_CUSTOMIZATION_READ_ERROR]', e);
    }
    return DEFAULT_DASHBOARD_CUSTOMIZATION;
  });

  // State 3: Filter Modal State
  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const [filterState, setFilterState] = useState<HomeFilterState>(DEFAULT_HOME_FILTER);

  // Accordion & Pie Chart states
  const [showPieChart, setShowPieChart] = useState(true);
  const [showBeginnerGuide, setShowBeginnerGuide] = useState(false);

  // Authoritative Runtime Bots
  const runtimeCandidates = engineStatus === 'loading'
    ? []
    : selectAuthoritativeRuntimeBots(engineBots, wallet, { openOnly: true });

  const isExchangeConnected = Boolean(wallet.connectedExchange?.isConnected);

  // Smooth Scrolling helper
  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Pill tab click handler
  const handlePillClick = (pill: HomePillTab) => {
    setActivePill(pill);
    if (pill === 'semua') {
      setFilterState(DEFAULT_HOME_FILTER);
    } else if (pill === 'highlights') {
      scrollToSection('section-highlights');
    } else if (pill === 'spot-vault') {
      scrollToSection('section-spot-vault');
      if (!isExchangeConnected) {
        onOpenApiKey();
      }
    } else if (pill === 'gas-tank') {
      scrollToSection('section-gas-tank');
      if (onOpenGasModal) {
        onOpenGasModal();
      } else {
        onOpenDeposit();
      }
    } else if (pill === 'dca-martingale') {
      scrollToSection('section-active-positions');
    } else if (pill === 'grid-strategy') {
      scrollToSection('section-active-positions');
    }
  };

  const handleSaveCustomization = (newCustomization: DashboardCustomization) => {
    setCustomization(newCustomization);
    try {
      localStorage.setItem('gain_home_customization', JSON.stringify(newCustomization));
    } catch (e) {
      console.warn('[GAIN_HOME_CUSTOMIZATION_SAVE_ERROR]', e);
    }
  };

  // Filtering runtime bot positions
  let filteredBots = runtimeCandidates;

  if (activePill === 'dca-martingale') {
    filteredBots = filteredBots.filter((bot) => {
      const mode = (bot.strategy || bot.pair || '').toLowerCase();
      return mode.includes('avarage') || mode.includes('martingale') || !mode.includes('grid');
    });
  } else if (activePill === 'grid-strategy') {
    filteredBots = filteredBots.filter((bot) => {
      const mode = (bot.strategy || bot.pair || '').toLowerCase();
      return mode.includes('grid');
    });
  }

  if (filterState.searchQuery) {
    const q = filterState.searchQuery.toLowerCase();
    filteredBots = filteredBots.filter(
      (bot) => (bot.pair || '').toLowerCase().includes(q) || (bot.exchange || '').toLowerCase().includes(q)
    );
  }

  if (filterState.strategyMode !== 'all') {
    filteredBots = filteredBots.filter(
      (bot) => (bot.strategy || '').toLowerCase() === filterState.strategyMode.toLowerCase()
    );
  }

  const activePositionCount = filteredBots.length;
  const activePositions = filteredBots.slice(0, 5).map((bot) => {
    const layerMetrics = computeAuthoritativeLayerMetrics(bot);
    const stepCount = layerMetrics.filledLayers;
    const maxLayers = layerMetrics.maxLayers;

    return {
      id: bot.id,
      coin: String(bot.pair || '').split('/')[0] || 'COIN',
      pair: bot.pair || '—',
      badgeSymbol: String(bot.pair || '').split('/')[0] || 'C',
      badgeBg: 'bg-slate-800',
      badgeColor: 'text-slate-200',
      status: bot.strategy ? 'active' : 'averaging',
      statusLabel: bot.strategy?.toUpperCase() || 'ACTIVE',
      engine: `${bot.exchange || 'Exchange'} Spot ${bot.isSandbox ? '(Testnet)' : '(Live)'} · ${bot.strategy || 'Backend Runtime'}`,
      price: Number(bot.lastPrice || 0),
      change24h: 0,
      totalCoinQty: Number(bot.positionQty || 0),
      allocationQty: `${Number(bot.positionQty || 0)} ${String(bot.pair || '').split('/')[0] || ''}`.trim(),
      allocationUsdt: '',
      floatingPnl: Number(((Number(bot.lastPrice || 0) - Number(bot.avgEntryPrice || 0)) * Number(bot.positionQty || 0)).toFixed(4)),
      avgBuyPrice: Number(bot.avgEntryPrice || 0),
      totalCostUsdt: Number(bot.avgEntryPrice || 0) * Number(bot.positionQty || 0),
      roiPct: Number(bot.avgEntryPrice || 0) > 0 ? Number((((Number(bot.lastPrice || 0) - Number(bot.avgEntryPrice || 0)) / Number(bot.avgEntryPrice || 0) * 100).toFixed(2))) : 0,
      stepLayer: stepCount,
      executedLayerCount: stepCount,
      executedLayers: bot.executedLayers,
      maxStep: maxLayers,
      averagingLayers: bot.averagingLayers,
      gridLayers: bot.gridLayers,
      trailingInfo: 'Trailing Take Profit 1.3% (Callback 0.2%)',
    } as TradingPosition;
  });

  const exchangeUsdt = wallet.connectedExchange?.totalPortfolioUsdt ?? wallet.connectedExchange?.usdtBalance ?? 0;
  const portfolioSyncStatus = wallet.connectedExchange?.portfolioSyncStatus || (isExchangeConnected ? 'SYNCING' : 'ERROR');

  const exchangeAllocatedAssetUsdt = deriveAllocatedAssetUsdt({
    portfolioAssets: wallet.connectedExchange?.portfolioAssets,
    totalPortfolioUsdt: wallet.connectedExchange?.totalPortfolioUsdt,
    usdtBalance: wallet.connectedExchange?.usdtBalance,
    legacyAllocatedAssetUsdt: wallet.allocatedAssetUsdt,
  });
  const gasReserve = wallet.gasReserve ?? 0;
  const isGasCritical = gasReserve <= FINANCIAL_CONFIG.gasTankRules.criticalPauseUsdt;
  const isGasWarning = gasReserve > FINANCIAL_CONFIG.gasTankRules.criticalPauseUsdt && gasReserve <= FINANCIAL_CONFIG.gasTankRules.minUsdt;

  const activeFilterCount = [
    filterState.searchQuery ? 1 : 0,
    filterState.category !== 'all' ? 1 : 0,
    filterState.strategyMode !== 'all' ? 1 : 0,
    filterState.botStatus !== 'all' ? 1 : 0,
    filterState.performance !== 'all' ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4 pb-28 md:pb-8">
      {/* COINGECKO FILTER PILLS BAR (FULLY DIRECTED & FUNCTIONAL) */}
      <div className="flex items-center justify-between gap-2 overflow-x-auto py-1 scrollbar-none sticky top-14 z-20 bg-slate-50/90 dark:bg-[#0B101D]/90 backdrop-blur-md">
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => handlePillClick('semua')}
            className={`px-3 py-1.5 rounded-full text-xs font-sans flex items-center gap-1.5 shadow-xs cursor-pointer transition ${
              activePill === 'semua'
                ? 'bg-[#8DC63F] text-slate-950 font-bold'
                : 'bg-white dark:bg-[#141E2E] border border-slate-200 dark:border-[#233044] text-slate-700 dark:text-slate-300 font-semibold hover:bg-slate-50 dark:hover:bg-[#1C2A3D]'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${activePill === 'semua' ? 'bg-slate-950' : 'bg-slate-400'}`}></span>
            Semua
          </button>

          <button
            type="button"
            onClick={() => handlePillClick('highlights')}
            className={`px-3 py-1.5 rounded-full text-xs font-sans transition cursor-pointer ${
              activePill === 'highlights'
                ? 'bg-[#8DC63F] text-slate-950 font-bold'
                : 'bg-white dark:bg-[#141E2E] border border-slate-200 dark:border-[#233044] text-slate-700 dark:text-slate-300 font-semibold hover:bg-slate-50 dark:hover:bg-[#1C2A3D]'
            }`}
          >
            Highlights
          </button>

          <button
            type="button"
            onClick={() => handlePillClick('spot-vault')}
            className={`px-3 py-1.5 rounded-full text-xs font-sans transition cursor-pointer flex items-center gap-1 ${
              activePill === 'spot-vault'
                ? 'bg-[#8DC63F] text-slate-950 font-bold'
                : 'bg-white dark:bg-[#141E2E] border border-slate-200 dark:border-[#233044] text-slate-700 dark:text-slate-300 font-semibold hover:bg-slate-50 dark:hover:bg-[#1C2A3D]'
            }`}
          >
            <Building2 className="w-3 h-3" />
            Spot Vault
          </button>

          <button
            type="button"
            onClick={() => handlePillClick('gas-tank')}
            className={`px-3 py-1.5 rounded-full text-xs font-sans transition cursor-pointer flex items-center gap-1 ${
              activePill === 'gas-tank'
                ? 'bg-[#8DC63F] text-slate-950 font-bold'
                : 'bg-white dark:bg-[#141E2E] border border-slate-200 dark:border-[#233044] text-slate-700 dark:text-slate-300 font-semibold hover:bg-slate-50 dark:hover:bg-[#1C2A3D]'
            }`}
          >
            <Fuel className="w-3 h-3" />
            Gas Tank
          </button>

          <button
            type="button"
            onClick={() => handlePillClick('dca-martingale')}
            className={`px-3 py-1.5 rounded-full text-xs font-sans transition cursor-pointer flex items-center gap-1 ${
              activePill === 'dca-martingale'
                ? 'bg-[#8DC63F] text-slate-950 font-bold'
                : 'bg-white dark:bg-[#141E2E] border border-slate-200 dark:border-[#233044] text-slate-700 dark:text-slate-300 font-semibold hover:bg-slate-50 dark:hover:bg-[#1C2A3D]'
            }`}
          >
            <Bot className="w-3 h-3" />
            DCA Martingale
          </button>

          <button
            type="button"
            onClick={() => handlePillClick('grid-strategy')}
            className={`px-3 py-1.5 rounded-full text-xs font-sans transition cursor-pointer flex items-center gap-1 ${
              activePill === 'grid-strategy'
                ? 'bg-[#8DC63F] text-slate-950 font-bold'
                : 'bg-white dark:bg-[#141E2E] border border-slate-200 dark:border-[#233044] text-slate-700 dark:text-slate-300 font-semibold hover:bg-slate-50 dark:hover:bg-[#1C2A3D]'
            }`}
          >
            <Grid className="w-3 h-3" />
            Grid Strategy
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          <button
            type="button"
            onClick={() => setIsCustomizeModalOpen(true)}
            className="px-3 py-1.5 rounded-full bg-white dark:bg-[#141E2E] border border-slate-200 dark:border-[#233044] text-slate-700 dark:text-slate-300 font-semibold text-xs font-sans hover:bg-slate-50 dark:hover:bg-[#1C2A3D] transition cursor-pointer flex items-center gap-1"
          >
            <Sliders className="w-3.5 h-3.5 text-slate-400" />
            <span>Customize</span>
          </button>

          <button
            type="button"
            onClick={() => setIsFilterModalOpen(true)}
            className={`px-3 py-1.5 rounded-full text-xs font-sans transition cursor-pointer flex items-center gap-1 ${
              activeFilterCount > 0
                ? 'bg-sky-500 text-slate-950 font-bold border border-sky-400'
                : 'bg-white dark:bg-[#141E2E] border border-slate-200 dark:border-[#233044] text-slate-700 dark:text-slate-300 font-semibold hover:bg-slate-50 dark:hover:bg-[#1C2A3D]'
            }`}
          >
            <Filter className="w-3.5 h-3.5" />
            <span>Filter</span>
            {activeFilterCount > 0 && (
              <span className="w-4 h-4 rounded-full bg-slate-950 text-white text-[9px] flex items-center justify-center font-bold">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ACTIVE FILTER NOTICE BADGE */}
      {activeFilterCount > 0 && (
        <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-between text-xs font-sans">
          <div className="flex items-center gap-2 text-sky-400">
            <Filter className="w-4 h-4 shrink-0" />
            <span>
              Menampilkan hasil dengan <strong>{activeFilterCount} filter aktif</strong> (
              {filterState.searchQuery ? `Kata kunci: "${filterState.searchQuery}", ` : ''}
              {filterState.strategyMode !== 'all' ? `Strategi: ${filterState.strategyMode}, ` : ''}
              {filterState.category !== 'all' ? `Kategori: ${filterState.category}` : ''}
              )
            </span>
          </div>
          <button
            type="button"
            onClick={() => setFilterState(DEFAULT_HOME_FILTER)}
            className="text-[11px] font-bold text-sky-400 hover:underline flex items-center gap-1 cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
        </div>
      )}

      {/* STRATEGY HERO ACTION BANNER (When DCA Martingale or Grid Strategy is Active) */}
      {activePill === 'dca-martingale' && (
        <div className="p-4 rounded-2xl bg-gradient-to-r from-emerald-950/50 via-[#0E1A2B] to-[#0B121E] border border-emerald-500/30 shadow-md flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 animate-in fade-in duration-200">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="font-bold text-sm text-white font-sans">Strategi DCA Martingale (Averaging Dinamis)</h4>
                <span className="px-2 py-0.5 rounded text-[9.5px] font-extrabold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  100 STEP READY
                </span>
              </div>
              <p className="text-[11px] text-slate-300 font-sans mt-0.5">
                Membeli koin secara bertingkat saat pasar drawdown untuk menurunkan harga rata-rata beli (Average Entry). Dilengkapi Trailing Take Profit &amp; Anti-FOMO Price Ceiling.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenCustomBot(customization.defaultPair || 'BTC/USDT', 'Avarage Only')}
            className="px-4 py-2 rounded-xl bg-[#8DC63F] hover:bg-[#7ab232] text-slate-950 font-bold text-xs font-sans transition flex items-center gap-1.5 shadow-md shrink-0 cursor-pointer"
          >
            <span>Buat Bot DCA</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {activePill === 'grid-strategy' && (
        <div className="p-4 rounded-2xl bg-gradient-to-r from-sky-950/50 via-[#0E1A2B] to-[#0B121E] border border-sky-500/30 shadow-md flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 animate-in fade-in duration-200">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-500/20 border border-sky-500/40 flex items-center justify-center text-sky-400 shrink-0">
              <Grid className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="font-bold text-sm text-white font-sans">Grid Strategy (Grid Oscillating 5-100 Layer)</h4>
                <span className="px-2 py-0.5 rounded text-[9.5px] font-extrabold bg-sky-500/20 text-sky-400 border border-sky-500/30">
                  SIDEWAY PROFIT
                </span>
              </div>
              <p className="text-[11px] text-slate-300 font-sans mt-0.5">
                Memanfaatkan pergerakan pasar osilasi/sideway dengan memasang jaring beli/jual bertingkat secara otomatis untuk profit berkelanjutan.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenCustomBot(customization.defaultPair || 'BTC/USDT', 'Grid Only')}
            className="px-4 py-2 rounded-xl bg-sky-400 hover:bg-sky-500 text-slate-950 font-bold text-xs font-sans transition flex items-center gap-1.5 shadow-md shrink-0 cursor-pointer"
          >
            <span>Buat Bot Grid</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* COINGECKO 3-COLUMN HIGHLIGHTS DASHBOARD */}
      {customization.showHighlights && (
        <div id="section-highlights" className="grid grid-cols-1 lg:grid-cols-3 gap-3.5 scroll-mt-24">
          {/* Card 1: Market Cap & Sparkline Chart */}
          <div className="p-4 rounded-2xl bg-white dark:bg-[#141E2E] border border-slate-200 dark:border-[#233044] flex flex-col justify-between shadow-xs">
            <div>
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-sans">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-900 dark:text-white">$2.925T</span>
                  <span className="text-rose-500 font-bold text-[10.5px]">▼ 2.8%</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-900 dark:text-white">$110.293B</span>
                  <span className="text-emerald-500 font-bold text-[10.5px]">▲ 43.6%</span>
                </div>
              </div>
              <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 font-sans mt-0.5">
                <span>Market Cap</span>
                <span>24h Trading Volume</span>
              </div>

              {/* Sparkline SVG Chart (CoinGecko Style) */}
              <div className="mt-3 relative h-24 w-full">
                <svg className="w-full h-full overflow-visible" viewBox="0 0 300 80" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="cgGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#EA3943" stopOpacity="0.25" />
                      <stop offset="100%" stopColor="#EA3943" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M 0 20 Q 30 5, 60 40 T 120 35 T 180 55 T 240 45 T 300 30 L 300 80 L 0 80 Z"
                    fill="url(#cgGradient)"
                  />
                  <path
                    d="M 0 20 Q 30 5, 60 40 T 120 35 T 180 55 T 240 45 T 300 30"
                    fill="none"
                    stroke="#EA3943"
                    strokeWidth="2"
                  />
                </svg>
                <div className="flex items-center justify-between text-[9px] text-slate-400 font-mono mt-1">
                  <span>12:00</span>
                  <span>18:00</span>
                  <span>8. Oct</span>
                  <span>06:00</span>
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: 🔥 Trending > */}
          <div className="p-4 rounded-2xl bg-white dark:bg-[#141E2E] border border-slate-200 dark:border-[#233044] flex flex-col justify-between shadow-xs">
            <div>
              <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-[#1E2C3F]">
                <span className="font-bold text-xs text-slate-900 dark:text-white flex items-center gap-1 font-sans">
                  🔥 Trending <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                </span>
                <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-[#1C2A3D] text-[9.5px] font-bold text-slate-600 dark:text-slate-300 font-sans">
                  Crypto
                </span>
              </div>

              
              <div className="mt-2 space-y-2 text-xs">
                {trendingList.map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CoinLogo coin={item.coin} size="sm" />
                      <span className="font-semibold text-slate-900 dark:text-white">{item.name || item.coin}</span>
                      <span className="text-[10px] text-slate-400 font-mono">{item.coin}</span>
                    </div>
                    <div className="text-right font-mono">
                      <span className="font-bold text-slate-900 dark:text-white">${formatUsdt(item.price, item.price < 1 ? 4 : 2)}</span>
                      <span className={`font-bold ml-1.5 text-[11px] ${item.change >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {formatPercent(item.change)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Card 3: 🚀 Top Gainers / Active Bots > */}
          <div className="p-4 rounded-2xl bg-white dark:bg-[#141E2E] border border-slate-200 dark:border-[#233044] flex flex-col justify-between shadow-xs">
            <div>
              <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-[#1E2C3F]">
                <span className="font-bold text-xs text-slate-900 dark:text-white flex items-center gap-1 font-sans">
                  🚀 Top Gainers <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                </span>
                <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-[#1C2A3D] text-[9.5px] font-bold text-slate-600 dark:text-slate-300 font-sans">
                  24h Gain
                </span>
              </div>

              <div className="mt-2 space-y-2 text-xs">
                {topGainersList.map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CoinLogo coin={item.coin} size="sm" />
                      <span className="font-semibold text-slate-900 dark:text-white">{item.name || item.coin}</span>
                      <span className="text-[10px] text-slate-400 font-mono">{item.coin}</span>
                    </div>
                    <div className="text-right font-mono">
                      <span className="font-bold text-slate-900 dark:text-white">${formatUsdt(item.price, item.price < 1 ? 4 : 2)}</span>
                      <span className={`font-bold ml-1.5 text-[11px] ${item.change >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {formatPercent(item.change)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DUAL-VAULT ARCHITECTURE INFOGRAPHIC */}
      {customization.showDualVault && (
        <div className="rounded-2xl bg-white dark:bg-[#141E2E] border border-slate-200 dark:border-[#233044] p-4 sm:p-5 shadow-xs transition-colors">
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-200 dark:border-[#233044]">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-[#1C2A3D] text-slate-700 dark:text-slate-300 flex items-center justify-center">
                <ShieldCheck className="w-4 h-4 text-[#8DC63F]" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-900 dark:text-white font-sans uppercase tracking-tight">
                  {t('vaultTitle')}
                </h3>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 font-sans">
                  {t('vaultDesc')}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowBeginnerGuide(!showBeginnerGuide)}
              className="text-[11px] font-sans font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:underline cursor-pointer flex items-center gap-1 shrink-0"
            >
              <span>{showBeginnerGuide ? t('closeGuide') : t('howItWorks')}</span>
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showBeginnerGuide ? 'rotate-90' : ''}`} />
            </button>
          </div>

          {/* Dual Vault Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* VAULT 1: EXCHANGER SPOT BALANCE */}
            <div id="section-spot-vault" className="rounded-xl bg-slate-50 dark:bg-[#1C2A3D] border border-slate-200 dark:border-[#283952] p-3.5 flex flex-col justify-between shadow-xs scroll-mt-24">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 flex items-center justify-center">
                      <Building2 className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-[11px] font-bold text-slate-900 dark:text-white uppercase font-sans">
                      {t('spotCapital')} (Spot Vault)
                    </span>
                  </div>
                  <span className={`px-1.5 py-0.2 rounded text-[9.5px] font-mono font-bold ${
                    isExchangeConnected
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
                      : 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border border-amber-500/30'
                  }`}>
                    {isExchangeConnected ? wallet.connectedExchange?.exchange : 'Belum Konek'}
                  </span>
                </div>

                <div className="mt-2.5 flex items-baseline gap-1.5">
                  <span className="text-2xl font-extrabold font-mono text-slate-900 dark:text-white tabular-nums">
                    {isExchangeConnected ? formatUsdt(exchangeUsdt) : '0.00'}
                  </span>
                  <span className="text-xs font-mono font-bold text-slate-500 dark:text-slate-400">USDT</span>
                </div>

                <p className="text-[10.5px] text-slate-500 dark:text-slate-400 font-sans mt-1.5 leading-tight">
                  Tersimpan di akun {isExchangeConnected ? wallet.connectedExchange?.exchange : 'Exchange'} Anda. Bot hanya memiliki hak baca &amp; beli/jual spot (<strong>Tanpa Hak Penarikan/No Withdrawal</strong>).
                </p>
              </div>

              <div className="mt-3 pt-2.5 border-t border-slate-200 dark:border-[#283952] flex items-center justify-between">
                <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-sans flex items-center gap-1 font-medium">
                  <CheckCircle2 className="w-3 h-3" /> Dana 100% Milik Anda
                </span>
                <button
                  type="button"
                  onClick={onOpenApiKey}
                  className="text-[10px] text-emerald-600 dark:text-[#8DC63F] font-sans font-semibold hover:underline cursor-pointer"
                >
                  {isExchangeConnected ? 'Cek API' : t('connectApi')}
                </button>
              </div>
            </div>

            {/* VAULT 2: GAS FEE & LISENSI (GAIN WALLET) */}
            <div id="section-gas-tank" className="rounded-xl bg-slate-50 dark:bg-[#1C2A3D] border border-slate-200 dark:border-[#283952] p-3.5 flex flex-col justify-between shadow-xs scroll-mt-24">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-[#8DC63F] flex items-center justify-center">
                      <Fuel className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-[11px] font-bold text-slate-900 dark:text-white uppercase font-sans">
                      {t('gasLicense')} (Gas Tank)
                    </span>
                  </div>
                  <span className={`px-1.5 py-0.2 rounded text-[9.5px] font-mono font-bold border ${
                    isGasCritical
                      ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border-rose-500/30'
                      : isGasWarning
                      ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border-amber-500/30'
                      : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                  }`}>
                    {isGasCritical ? 'Kritis ≤ 5' : isGasWarning ? 'Waspada' : 'Aman'}
                  </span>
                </div>

                <div className="mt-2.5 flex items-baseline gap-1.5">
                  <span className="text-2xl font-extrabold font-mono text-slate-900 dark:text-white tabular-nums">
                    {formatUsdt(gasReserve)}
                  </span>
                  <span className="text-xs font-mono font-bold text-slate-500 dark:text-slate-400">USDT Gas</span>
                  <span className="text-[10px] text-slate-400 font-sans ml-1">
                    (Total Liquid: {formatUsdt(wallet.liquidBalance)})
                  </span>
                </div>

                <p className="text-[10.5px] text-slate-500 dark:text-slate-400 font-sans mt-1.5 leading-tight">
                  Bahan bakar operasional bot. Otomatis dipotong 20% hanya saat bot berhasil mencetak profit di exchange Anda (80% profit bersih untuk Anda).
                </p>
              </div>

              <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-[#17253B] flex items-center justify-between">
                <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans">
                  Min. Cadangan: 10 USDT
                </span>
                <button
                  type="button"
                  onClick={onOpenGasModal ? onOpenGasModal : onOpenDeposit}
                  className="text-[10px] text-[#8DC63F] font-sans font-semibold hover:underline cursor-pointer"
                >
                  + {t('fillGas')} (Top-Up)
                </button>
              </div>
            </div>
          </div>

          {/* Accordion: 3 Langkah Cepat untuk Pemula */}
          {showBeginnerGuide && (
            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-[#16253B] animate-in fade-in duration-200">
              <h4 className="text-[11px] font-bold text-slate-900 dark:text-white font-sans uppercase mb-2">
                Panduan 3 Langkah Cepat Memulai Trading Bot:
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs font-sans">
                <div className="p-2.5 rounded-xl bg-white dark:bg-[#0C1422] border border-slate-200 dark:border-[#16253B]">
                  <div className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200 text-[11px]">
                    <span className="w-4 h-4 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 flex items-center justify-center text-[10px]">1</span>
                    <span>Siapkan Modal di Exchange</span>
                  </div>
                  <p className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                    Deposit USDT di akun exchange resmi Anda (Binance/Bitget/OKX). Hubungkan API Key spot tanpa akses withdraw.
                  </p>
                </div>

                <div className="p-2.5 rounded-xl bg-white dark:bg-[#0C1422] border border-slate-200 dark:border-[#16253B]">
                  <div className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200 text-[11px]">
                    <span className="w-4 h-4 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 flex items-center justify-center text-[10px]">2</span>
                    <span>{t('fillGas')} di GAIN</span>
                  </div>
                  <p className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                    Kirim 10-20 USDT ke Wallet GAIN sebagai cadangan biaya 20% bagi hasil profit ketika bot menghasilkan cuan.
                  </p>
                </div>

                <div className="p-2.5 rounded-xl bg-white dark:bg-[#0C1422] border border-slate-200 dark:border-[#16253B]">
                  <div className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200 text-[11px]">
                    <span className="w-4 h-4 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 flex items-center justify-center text-[10px]">3</span>
                    <span>Aktifkan Bot Matrix</span>
                  </div>
                  <p className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                    Pilih koin favorit (BTC, ETH, SOL) di menu Bot Matrix &rarr; klik Aktifkan Bot. Bot otomatis trading 24 jam nonstop!
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Portfolio Card */}
      {customization.showPortfolio && (
        <div className="relative overflow-hidden rounded-2xl bg-white dark:bg-gradient-to-br dark:from-[#111A29] dark:via-[#0E1624] dark:to-[#0B101B] border border-slate-200 dark:border-[#1E2E44] p-5 shadow-xs dark:shadow-md transition-colors">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-sans">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-500"></span>
              <span className="font-medium">{t('portfolioBalance')}</span>
            </div>
            <button
              onClick={onOpenProfitShare}
              className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white flex items-center gap-0.5 font-medium cursor-pointer"
            >
              Vault Settle <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl sm:text-4xl font-extrabold font-mono tracking-tight text-slate-900 dark:text-white tabular-nums">
              {formatUsdt(wallet.liquidBalance)}
            </span>
            <span className="text-sm font-bold font-mono text-slate-500 dark:text-slate-400">USDT</span>
          </div>

          {/* Sub metrics */}
          <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-slate-100 dark:border-[#162338] text-xs">
            <div>
              <span className="text-[10.5px] text-slate-500 dark:text-slate-400 font-sans font-medium block">
                Aset Koin Alokasi
              </span>
              {isExchangeConnected && (
                <span className={`text-[9px] font-mono font-bold ${portfolioSyncStatus === 'LIVE' ? 'text-emerald-400' : portfolioSyncStatus === 'STALE' ? 'text-amber-400' : portfolioSyncStatus === 'ERROR' ? 'text-rose-400' : 'text-sky-400'}`}>
                  {portfolioSyncStatus} · {wallet.connectedExchange?.portfolioAsOf ? new Date(wallet.connectedExchange.portfolioAsOf).toLocaleTimeString() : '—'}
                </span>
              )}
              <span className="text-sm font-bold font-mono text-slate-900 dark:text-white mt-0.5 block tabular-nums">
                {formatUsdt(exchangeAllocatedAssetUsdt)} USDT
              </span>
            </div>
            <div className="text-right">
              <span className="text-[10.5px] text-slate-500 dark:text-slate-400 font-sans font-medium block">
                Volume Trading (24h)
              </span>
              <span className="text-sm font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-0.5 block tabular-nums">
                +{formatUsdt(wallet.volume24h)} USDT
              </span>
            </div>
          </div>
        </div>
      )}

      {/* The Real Money Machine VIP Banner */}
      <div className="relative overflow-hidden rounded-xl bg-slate-50 dark:bg-gradient-to-r dark:from-[#0E1A2B] dark:via-[#0C1625] dark:to-[#0A111E] border border-slate-200 dark:border-[#1E2E44] p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-xs transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-300">
            <Zap className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold tracking-tight text-slate-900 dark:text-white font-sans">
                Gain Your Future
              </span>
              <span title="Verified Engine">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              </span>
            </div>
            <p className="text-[10.5px] text-slate-500 dark:text-slate-400 font-sans mt-0.5">
              Automate Today Grow Tomorrow
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
        </div>
      </div>

      {/* Quick Action Grid */}
      <div className="grid grid-cols-2 xs:grid-cols-5 sm:grid-cols-5 gap-2">
        <button
          onClick={onOpenDeposit}
          className="flex flex-col items-center justify-center p-2.5 sm:p-3 rounded-xl bg-white dark:bg-[#101A29] border border-slate-200 dark:border-[#1A283D] hover:border-emerald-500/40 hover:bg-slate-50 dark:hover:bg-[#142033] shadow-xs transition group text-center cursor-pointer active:scale-95 select-none"
        >
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-1 group-hover:scale-105 transition">
            <ArrowDownLeft className="w-4 h-4" />
          </div>
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 font-sans">Deposit</span>
          <span className="text-[9px] sm:text-[9.5px] text-slate-500 dark:text-slate-400 font-mono mt-0.5">BEP-20</span>
        </button>

        <button
          onClick={onOpenWithdraw}
          className="flex flex-col items-center justify-center p-2.5 sm:p-3 rounded-xl bg-white dark:bg-[#101A29] border border-slate-200 dark:border-[#1A283D] hover:border-sky-500/40 hover:bg-slate-50 dark:hover:bg-[#142033] shadow-xs transition group text-center cursor-pointer active:scale-95 select-none"
        >
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 flex items-center justify-center mb-1 group-hover:scale-105 transition">
            <ArrowUpRight className="w-4 h-4" />
          </div>
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 font-sans">Withdraw</span>
          <span className="text-[9px] sm:text-[9.5px] text-slate-500 dark:text-slate-400 font-mono mt-0.5">2 USDT</span>
        </button>

        <button
          onClick={() => onOpenCustomBot(customization.defaultPair || 'BTC/USDT')}
          className="flex flex-col items-center justify-center p-2.5 sm:p-3 rounded-xl bg-white dark:bg-[#101A29] border border-slate-200 dark:border-[#1A283D] hover:border-purple-500/40 hover:bg-slate-50 dark:hover:bg-[#142033] shadow-xs transition group text-center cursor-pointer active:scale-95 select-none"
        >
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 flex items-center justify-center mb-1 group-hover:scale-105 transition">
            <Sliders className="w-4 h-4" />
          </div>
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 font-sans">Custom Bot</span>
          <span className="text-[9px] sm:text-[9.5px] text-slate-500 dark:text-slate-400 font-sans mt-0.5">100 Steps</span>
        </button>

        {onOpenPriceAlert && (
          <button
            onClick={() => onOpenPriceAlert()}
            className="flex flex-col items-center justify-center p-2.5 sm:p-3 rounded-xl bg-white dark:bg-[#101A29] border border-slate-200 dark:border-[#1A283D] hover:border-amber-500/40 hover:bg-slate-50 dark:hover:bg-[#142033] shadow-xs transition group text-center cursor-pointer active:scale-95 select-none"
          >
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 flex items-center justify-center mb-1 group-hover:scale-105 transition">
              <TrendingUp className="w-4 h-4" />
            </div>
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 font-sans">Price Alert</span>
            <span className="text-[9px] sm:text-[9.5px] text-slate-500 dark:text-slate-400 font-sans mt-0.5">Notifikasi</span>
          </button>
        )}

        <button
          onClick={onOpenApiKey}
          className="flex flex-col items-center justify-center p-2.5 sm:p-3 rounded-xl bg-white dark:bg-[#101A29] border border-slate-200 dark:border-[#1A283D] hover:border-slate-400 dark:hover:border-slate-500 hover:bg-slate-50 dark:hover:bg-[#142033] shadow-xs transition group text-center cursor-pointer active:scale-95 select-none"
        >
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 flex items-center justify-center mb-1 group-hover:scale-105 transition">
            <Key className="w-4 h-4" />
          </div>
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 font-sans">API Key</span>
          <span className="text-[9px] sm:text-[9.5px] text-slate-500 dark:text-slate-400 font-sans mt-0.5">Exchange</span>
        </button>
      </div>

      {/* Bagan Lingkaran Distribusi Komposisi Koin */}
      {customization.showPieChart && (
        <div className="pt-1">
          <div className="flex items-center justify-between pb-2">
            <div className="flex items-center gap-2">
              <PieChartIcon className="w-4 h-4 text-sky-500 dark:text-sky-400" />
              <h3 className="font-bold text-sm text-slate-900 dark:text-white tracking-tight font-sans">
                {t('coinDistribution')}
              </h3>
            </div>
            <button
              onClick={() => setShowPieChart((prev) => !prev)}
              className="text-xs text-sky-600 dark:text-sky-400 hover:underline font-sans font-medium cursor-pointer flex items-center gap-1"
            >
              <span>{showPieChart ? 'Sembunyikan' : 'Tampilkan Bagan'}</span>
            </button>
          </div>

          {showPieChart && (
            <CoinDistributionPieChart positions={positions} wallet={wallet} />
          )}
        </div>
      )}

      {/* Posisi Trading Aktif Header */}
      {customization.showActivePositions && (
        <div id="section-active-positions" className="scroll-mt-24 space-y-2.5">
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
              <h3 className="font-bold text-sm text-slate-900 dark:text-white tracking-tight font-sans">{t('activePositions')}</h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                {activePositionCount}
              </span>
            </div>
            <button
              onClick={onNavigateTrading}
              className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline font-sans font-medium flex items-center gap-0.5 cursor-pointer"
            >
              {t('viewAll')} →
            </button>
          </div>

          {/* Position Cards */}
          <div className="space-y-2.5">
            {activePositions.length === 0 ? (
              <div className="p-6 rounded-2xl bg-white dark:bg-[#101A29] border border-dashed border-slate-300 dark:border-[#1E2E44] text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-300 mx-auto">
                  <TrendingUp className="w-6 h-6" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-slate-900 dark:text-white font-sans">
                    {isExchangeConnected ? t('noBotPositions') : t('noActivePositions')}
                  </h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-sans mt-1 max-w-sm mx-auto">
                    {isExchangeConnected
                      ? `${wallet.connectedExchange?.exchange || 'Exchange'} ${wallet.connectedExchange?.isSandbox ? 'Testnet' : 'Live'} sudah terhubung. Saldo dan aset exchange ditampilkan pada ${t('coinDistribution')}; saat ini belum ada bot GAIN yang memegang posisi aktif.`
                      : `${SUPPORTED_COINS.length} pair koin resmi siap trading (termasuk TAO/USDT & XAUT/USDT). Hubungkan API exchange Anda untuk sinkronisasi saldo riil atau aktifkan bot averaging.`}
                  </p>
                </div>
                <div className="flex items-center justify-center gap-2 pt-1 flex-wrap">
                  {isExchangeConnected ? (
                    <button
                      onClick={() => onOpenCustomBot(customization.defaultPair || 'BTC/USDT', activePill === 'grid-strategy' ? 'Grid Only' : 'Avarage Only')}
                      className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white font-bold text-xs font-sans shadow-sm transition cursor-pointer"
                    >
                      {t('openBotMatrix')}
                    </button>
                  ) : (
                    <button
                      onClick={onOpenApiKey}
                      className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white font-bold text-xs font-sans shadow-sm transition cursor-pointer"
                    >
                      Hubungkan API Exchange
                    </button>
                  )}
                  <button
                    onClick={onNavigateTrading}
                    className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-[#152238] text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white border border-slate-200 dark:border-[#1E2E44] font-semibold text-xs font-sans transition cursor-pointer"
                  >
                    Lihat {SUPPORTED_COINS.length} Pair Standby
                  </button>
                </div>
              </div>
            ) : (
              activePositions.map((pos, idx) => (
                <div
                  key={`${pos.id || pos.coin}-${idx}`}
                  className="p-4 rounded-xl bg-white dark:bg-[#101A29] border border-slate-200 dark:border-[#1A283D] hover:border-amber-400/40 shadow-xs transition space-y-3"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2.5">
                      <CoinLogo
                        coin={pos.coin || pos.pair}
                        size="md"
                        fallbackSymbol={pos.badgeSymbol}
                        fallbackBg={pos.badgeBg}
                        fallbackColor={pos.badgeColor}
                      />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-slate-900 dark:text-white font-sans">{pos.pair}</span>
                          {onOpenPriceAlert && (
                            <button
                              type="button"
                              onClick={() => onOpenPriceAlert(pos.pair)}
                              title={`Pasang Price Alert ${pos.pair}`}
                              className="p-1 rounded-lg text-slate-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition cursor-pointer"
                            >
                              <Bell className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-sans font-semibold ${
                              pos.status === 'active'
                                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20'
                                : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-500/20'
                            }`}
                          >
                            {pos.statusLabel}
                          </span>
                        </div>
                        <p className="text-[10.5px] text-slate-500 dark:text-slate-400 font-sans mt-0.5">{pos.engine}</p>
                      </div>
                    </div>

                    <div className="text-right">
                      <span className="font-mono text-sm font-bold text-slate-900 dark:text-white block tabular-nums">
                        {Number.isFinite(Number(pos.price)) && Number(pos.price) > 0
                          ? `$${Number(pos.price).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                          : '—'}
                      </span>
                      <span
                        className={`text-[11px] font-mono font-semibold tabular-nums ${
                          Number(pos.change24h) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {Number.isFinite(Number(pos.change24h))
                          ? (Number(pos.change24h) >= 0 ? `+${Number(pos.change24h)}%` : `${Number(pos.change24h)}%`)
                          : '—'}
                      </span>
                    </div>
                  </div>

                  {/* Position stats */}
                  <div className="grid grid-cols-3 gap-2 py-2 px-3 rounded-lg bg-slate-50 dark:bg-[#0B121E] border border-slate-100 dark:border-[#162338] text-xs">
                    <div>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans block">Alokasi / Qty</span>
                      <span className="text-slate-800 dark:text-slate-200 font-mono font-semibold tabular-nums">{pos.allocationQty}</span>
                    </div>
                    <div className="text-center">
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans block">Layer Step</span>
                      <span className="text-slate-900 dark:text-slate-100 font-mono font-bold tabular-nums">
                        #{pos.stepLayer} / {pos.maxStep}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans block">Floating PnL</span>
                      <span
                        className={`font-mono font-bold tabular-nums ${
                          pos.floatingPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {pos.floatingPnl >= 0 ? `+${formatUsdt(pos.floatingPnl)}` : formatUsdt(pos.floatingPnl)} USDT
                      </span>
                    </div>
                  </div>

                  {/* Trailing Progress & Action */}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 font-sans">{pos.trailingInfo}</span>
                    <button
                      onClick={() => onOpenCustomBot(pos.pair)}
                      className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-[#142033] border border-slate-200 dark:border-[#1C3050] text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-[#1A2B44] text-[11px] font-sans font-semibold transition cursor-pointer"
                    >
                      Formula 100 Step →
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Fitur & Ekosistem GAIN */}
      {customization.showEcosystem && (
        <div className="pt-3 space-y-2.5">
          <h4 className="text-xs font-sans font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
            Fitur & Ekosistem GAIN
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div
              onClick={() => onOpenCustomBot(customization.defaultPair || 'BTC/USDT')}
              className="p-3.5 rounded-xl bg-white dark:bg-[#101A29] border border-slate-200 dark:border-[#1A283D] hover:border-amber-400/50 shadow-xs transition cursor-pointer flex items-center gap-3"
            >
              <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-500/30 flex items-center justify-center text-amber-600 dark:text-[#F0B90B]">
                <Layers className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-slate-900 dark:text-white font-sans">Bot Setting & Grid Matrix</span>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                </div>
                <p className="text-[10.5px] text-slate-500 dark:text-slate-400 font-sans mt-0.5">
                  Konfigurasi 100 layer averaging dinamis & trailing take profit
                </p>
              </div>
            </div>

            <div
              onClick={onNavigateAccount || onOpenTransfer}
              className="p-3.5 rounded-xl bg-white dark:bg-[#101A29] border border-slate-200 dark:border-[#1A283D] hover:border-purple-500/50 shadow-xs transition cursor-pointer flex items-center gap-3"
            >
              <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-500/30 flex items-center justify-center text-purple-600 dark:text-purple-400">
                <Users className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-slate-900 dark:text-white font-sans">Jaringan & Referral Matrix</span>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                </div>
                <p className="text-[10.5px] text-slate-500 dark:text-slate-400 font-sans mt-0.5">
                  Spillover reward, bagi hasil 20% & transfer instan 0% fee
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODALS */}
      <CustomizeHomeModal
        isOpen={isCustomizeModalOpen}
        onClose={() => setIsCustomizeModalOpen(false)}
        customization={customization}
        onSave={handleSaveCustomization}
      />

      <HomeFilterModal
        isOpen={isFilterModalOpen}
        onClose={() => setIsFilterModalOpen(false)}
        filters={filterState}
        onApply={(newFilters) => setFilterState(newFilters)}
      />
    </div>
  );
}
