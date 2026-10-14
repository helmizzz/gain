import React, { useState, useMemo, useEffect } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { CoinLogo } from '../common/CoinLogo';
import {
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Download,
  Copy,
  Check,
  Filter,
  Search,
  ExternalLink,
  Layers,
  ArrowUpRight,
  ArrowDownLeft,
  Calendar,
  AlertCircle,
  Eye,
  Info,
  CreditCard,
  ChevronDown,
  ChevronUp,
  Sliders,
  DollarSign,
  Activity,
  ListFilter,
  Printer,
  Trash2,
  Clock,
  XCircle,
  CheckCircle2,
} from 'lucide-react';
import { TradeRecord, UserWallet, TradingPosition, ExecutedLayerDetail, OpenOrderRecord } from '../../types';
import { TradeDetailModal } from '../modals/TradeDetailModal';
import { calculateTradeMetrics, decorateTradesWithRealizedPnl } from '../../utils/tradeMetrics';
import { TradeInfoModal } from '../modals/TradeInfoModal';
import { getBotModeLabel, normalizeBotMode } from '../../utils/botModeLabels';
import { fetchExchangeOpenOrders, cancelExchangeOrder } from '../../api/exchangeApi';

interface TradeHistoryTabProps {
  trades: TradeRecord[];
  wallet: UserWallet;
  currentExchange: string;
  positions?: TradingPosition[];
  activeApiCreds: {
    exchange: string;
    apiKey: string;
    secret: string;
    password?: string;
    isSandbox: boolean;
  } | null;
  onSyncExchangeTrades: () => Promise<void>;
  isSyncing: boolean;
  hasMoreTrades?: boolean;
  isLoadingMoreTrades?: boolean;
  onLoadMoreTrades?: () => void;
  onOpenApiKeyModal: () => void;
  onForceTakeProfit?: (pos: any) => Promise<any> | void;
  onOpenMatrixModal?: (pair: string) => void;
  onCloseLayer?: (positionId: string, layerId: string) => Promise<any> | void;
  onDeleteBot?: (pos: any) => void;
  onDeleteAllStandbyBots?: () => void;
}

export const TradeHistoryTab: React.FC<TradeHistoryTabProps> = ({
  trades,
  wallet,
  currentExchange,
  positions = [],
  activeApiCreds,
  onSyncExchangeTrades,
  isSyncing,
  hasMoreTrades = false,
  isLoadingMoreTrades = false,
  onLoadMoreTrades,
  onOpenApiKeyModal,
  onForceTakeProfit,
  onOpenMatrixModal,
  onCloseLayer,
  onDeleteBot,
  onDeleteAllStandbyBots,
}) => {
  const { t, language } = useLanguage();
  const [viewMode, setViewMode] = useState<'cards' | 'open_orders' | 'table'>('table');
  const [selectedPair, setSelectedPair] = useState<string>('ALL');
  const [selectedStatus, setSelectedStatus] = useState<'ALL' | 'active' | 'inactive'>('ALL');
  const [selectedSide, setSelectedSide] = useState<'ALL' | 'buy' | 'sell'>('ALL');
  const [selectedTimeRange, setSelectedTimeRange] = useState<'ALL' | '24h' | '7d' | '30d'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Open Orders state
  const [openOrders, setOpenOrders] = useState<OpenOrderRecord[]>([]);
  const [isLoadingOpenOrders, setIsLoadingOpenOrders] = useState(false);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ title: string; message: string; isError?: boolean } | null>(null);

  // Modals state
  const [selectedPositionForDetail, setSelectedPositionForDetail] = useState<TradingPosition | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedPositionForInfo, setSelectedPositionForInfo] = useState<TradingPosition | null>(null);
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);

  // Accordion state for pair cards
  const [collapsedPairs, setCollapsedPairs] = useState<Record<string, boolean>>({});

  const [isSelling, setIsSelling] = useState(false);
  const [sellToast, setSellToast] = useState<{ title: string; message: string; isError?: boolean } | null>(null);

  const togglePairCollapse = (pairName: string) => {
    setCollapsedPairs((prev) => ({
      ...prev,
      [pairName]: !prev[pairName],
    }));
  };

  // Build active bot pairs that have actual active positions or recorded trades
  const botPositions = useMemo(() => {
    return positions.filter((p) => {
      const matchPair = selectedPair === 'ALL' || p.pair === selectedPair;
      const matchStatus =
        selectedStatus === 'ALL' ||
        (selectedStatus === 'active' && p.status === 'active') ||
        (selectedStatus === 'inactive' && p.status !== 'active');
      const matchQuery =
        !searchQuery ||
        p.pair.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.coin.toLowerCase().includes(searchQuery.toLowerCase());
      const hasRealTrade = trades.some((t) => t.symbol === p.pair);
      const hasRealLayers = Boolean(p.executedLayers && p.executedLayers.length > 0);
      const hasRealAllocation = parseFloat(p.allocationQty || '0') > 0 && p.status === 'active';
      return matchPair && matchStatus && matchQuery && (hasRealTrade || hasRealLayers || hasRealAllocation);
    });
  }, [positions, selectedPair, selectedStatus, searchQuery, trades]);

  // Available pairs from trades & positions
  const availablePairs = useMemo(() => {
    const set = new Set<string>();
    positions.forEach((p) => set.add(p.pair));
    trades.forEach((t) => set.add(t.symbol));
    return ['ALL', ...Array.from(set)];
  }, [trades, positions]);

  // Enrich exchange fills with FIFO realized PnL when the API does not provide it.
  const enrichedTrades = useMemo(() => decorateTradesWithRealizedPnl(trades), [trades]);

  // Filtered trades for table view
  const filteredTrades = useMemo(() => {
    const now = Date.now();
    return enrichedTrades.filter((t) => {
      const matchPair = selectedPair === 'ALL' || t.symbol === selectedPair;
      const matchSide = selectedSide === 'ALL' || t.side === selectedSide;
      const matchQuery =
        !searchQuery ||
        t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (t.orderId && t.orderId.toLowerCase().includes(searchQuery.toLowerCase())) ||
        t.exchange.toLowerCase().includes(searchQuery.toLowerCase());

      let matchTime = true;
      if (selectedTimeRange === '24h') matchTime = now - t.timestamp <= 24 * 3600 * 1000;
      else if (selectedTimeRange === '7d') matchTime = now - t.timestamp <= 7 * 24 * 3600 * 1000;
      else if (selectedTimeRange === '30d') matchTime = now - t.timestamp <= 30 * 24 * 3600 * 1000;

      return matchPair && matchSide && matchQuery && matchTime;
    });
  }, [enrichedTrades, selectedPair, selectedSide, searchQuery, selectedTimeRange]);

  // Filtered open orders
  const filteredOpenOrders = useMemo(() => {
    return openOrders.filter((o) => {
      const matchPair = selectedPair === 'ALL' || o.symbol === selectedPair;
      const matchSide = selectedSide === 'ALL' || o.side === selectedSide;
      const matchQuery =
        !searchQuery ||
        o.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
        o.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (o.orderId && o.orderId.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchPair && matchSide && matchQuery;
    });
  }, [openOrders, selectedPair, selectedSide, searchQuery]);

  // Aggregate metrics dari trade fill exchange, bukan data demo/statis.
  const metrics = useMemo(() => calculateTradeMetrics(enrichedTrades), [enrichedTrades]);
  const connectedExchange = useMemo(() => {
  const target = String(currentExchange || '').trim().toLowerCase();

  return (
    (
      wallet.connectedExchange?.isConnected &&
      String(wallet.connectedExchange.exchange || '').trim().toLowerCase() === target
    )
      ? wallet.connectedExchange
      : undefined
  ) ||
    (wallet.connectedExchanges || []).find(
      (item) =>
        item.isConnected &&
        item.isActive &&
        String(item.exchange || '').trim().toLowerCase() === target
    ) ||
    (wallet.connectedExchanges || []).find(
      (item) =>
        item.isConnected &&
        String(item.exchange || '').trim().toLowerCase() === target
    ) ||
    null;
}, [
  wallet.connectedExchange,
  wallet.connectedExchanges,
  currentExchange,
]);
  const hasExchangeConnection = Boolean(connectedExchange?.isConnected && connectedExchange?.exchange);

  const handleCopy = (id: string, textToCopy: string) => {
    navigator.clipboard.writeText(textToCopy);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleLoadOpenOrders = async () => {
    const ex = String(currentExchange || '').toLowerCase();
    if (!ex) return;
    setIsLoadingOpenOrders(true);
    try {
      const resp = await fetchExchangeOpenOrders({ exchange: ex });
      if (resp?.success && Array.isArray(resp.openOrders)) {
        setOpenOrders(resp.openOrders as OpenOrderRecord[]);
      }
    } catch (err) {
      console.warn('[LOAD_OPEN_ORDERS_FAILED]', err);
    } finally {
      setIsLoadingOpenOrders(false);
    }
  };

  useEffect(() => {
    if (hasExchangeConnection) {
      handleLoadOpenOrders();
    }
  }, [currentExchange, hasExchangeConnection]);

  const handleCancelOpenOrder = async (order: OpenOrderRecord) => {
    if (cancellingOrderId) return;
    setCancellingOrderId(order.orderId);
    try {
      const resp = await cancelExchangeOrder({
        exchange: currentExchange.toLowerCase(),
        orderId: order.orderId,
        symbol: order.symbol,
      });
      if (resp?.success) {
        setActionFeedback({
          title: 'Order Dibatalkan',
          message: resp.message || `Order ${order.orderId} (${order.symbol}) berhasil dibatalkan di bursa.`,
        });
        setOpenOrders((prev) => prev.filter((o) => o.orderId !== order.orderId));
      } else {
        setActionFeedback({
          title: 'Gagal Membatalkan Order',
          message: resp?.error || 'Bursa menolak pembatalan order. Periksa status order di bursa.',
          isError: true,
        });
      }
    } catch (err: any) {
      setActionFeedback({
        title: 'Gagal Membatalkan Order',
        message: err?.message || 'Terjadi kesalahan saat membatalkan order di bursa.',
        isError: true,
      });
    } finally {
      setCancellingOrderId(null);
    }
  };

  const handleSyncAll = async () => {
    await onSyncExchangeTrades();
    await handleLoadOpenOrders();
  };

  const handleForceSell = async (position: TradingPosition) => {
    if (!onForceTakeProfit || isSelling) return;
    setIsSelling(true);
    setSellToast(null);
    try {
      const result = await onForceTakeProfit(position.id);
      if (!result?.success) {
        setSellToast({
          title: 'Sell belum berhasil',
          message: result?.error || 'Order tidak terkonfirmasi. Periksa status exchange sebelum mencoba lagi.',
          isError: true,
        });
        return;
      }

      setSellToast({
        title: result.partial ? 'Sell terisi sebagian' : 'Sell berhasil',
        message: result.persistenceWarning || (result.partial
          ? `Terjual ${Number(result.filledAmount || 0).toFixed(8)} ${position.coin}; sisa ${Number(result.remainingAmount || 0).toFixed(8)} ${position.coin} tetap aktif.`
          : `Posisi ${position.pair} berhasil dijual${result.orderId ? ` (order ${result.orderId})` : ''}.`),
        isError: Boolean(result.persistenceWarning),
      });
    } catch (error) {
      setSellToast({
        title: 'Status sell perlu diperiksa',
        message: error instanceof Error ? error.message : 'Terjadi kendala saat menyimpan hasil sell. Periksa exchange sebelum mengulang order.',
        isError: true,
      });
    } finally {
      setIsSelling(false);
    }
  };

  const handleOpenDetail = (pos: TradingPosition) => {
    setSelectedPositionForDetail(pos);
    setIsDetailModalOpen(true);
  };

  const handleOpenInfo = (pos: TradingPosition) => {
    setSelectedPositionForInfo(pos);
    setIsInfoModalOpen(true);
  };

  const handleExportCsv = () => {
    if (filteredTrades.length === 0) return;
    const headers = [
      'Trade ID',
      'Order ID',
      'Exchange',
      'Symbol',
      'Side',
      'Price (USDT)',
      'Amount',
      'Cost (USDT)',
      'Realized PnL (USDT)',
      'Timestamp',
      'Status',
    ];
    const rows = filteredTrades.map((t) => [
      t.id,
      t.orderId || '-',
      t.exchange,
      t.symbol,
      t.side.toUpperCase(),
      t.price,
      t.amount,
      t.costUsdt,
      t.realizedPnl ?? 0,
      new Date(t.timestamp).toLocaleString('id-ID'),
      t.status,
    ]);

    const csvContent =
      'data:text/csv;charset=utf-8,' +
      [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `GAIN_Trade_History_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportPdfReport = () => {
    if (filteredTrades.length === 0) return;

    const printableHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>GAIN - Laporan Resmi Riwayat Transaksi Trading</title>
        <style>
          @media print {
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 24px; color: #1e293b; background: #fff; }
          .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 20px; }
          .title { font-size: 20px; font-weight: 800; color: #0f172a; letter-spacing: -0.5px; }
          .subtitle { font-size: 11px; color: #64748b; margin-top: 4px; }
          .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
          .metric-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; }
          .metric-label { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 600; }
          .metric-val { font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 4px; font-family: monospace; }
          .metric-val.green { color: #059669; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; }
          th { background: #0f172a; color: #ffffff; text-align: left; padding: 8px 10px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
          td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; font-family: monospace; }
          tr:nth-child(even) { background: #f8fafc; }
          .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 700; text-transform: uppercase; }
          .badge-buy { background: #dcfce7; color: #15803d; }
          .badge-sell { background: #e0f2fe; color: #0369a1; }
          .footer { margin-top: 30px; font-size: 10px; color: #94a3b8; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 12px; }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="title">GAIN NIAGA KOIN · LAPORAN AUDIT RIWAYAT TRADING</div>
            <div class="subtitle">Platform Algoritma Kuantitatif Non-Kustodial · Dicetak pada ${new Date().toLocaleString('id-ID')}</div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 12px; font-weight: 700; color: #0f172a;">Member ID: ${wallet.memberId || '-'}</div>
            <div style="font-size: 10px; color: #64748b;">${wallet.email || 'Akun Terverifikasi'}</div>
          </div>
        </div>

        <div class="summary-grid">
          <div class="metric-card">
            <div class="metric-label">Total Realized PnL</div>
            <div class="metric-val green">+${metrics.totalRealizedPnl.toFixed(2)} USDT</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Total Transaksi</div>
            <div class="metric-val">${filteredTrades.length} Order</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Win Rate Bot</div>
            <div class="metric-val green">${metrics.winRate === '—' ? '—' : `${metrics.winRate}%`}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Estimasi Gas Tank (20%)</div>
            <div class="metric-val">${(Math.max(0, metrics.totalRealizedPnl) * 0.2).toFixed(2)} USDT</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Waktu / Tanggal</th>
              <th>Bursa</th>
              <th>Pasangan Koin</th>
              <th>Side</th>
              <th>Harga (USDT)</th>
              <th>Jumlah Koin</th>
              <th>Total Biaya</th>
              <th>PnL (USDT)</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${filteredTrades
              .map(
                (t) => `
              <tr>
                <td>${new Date(t.timestamp).toLocaleString('id-ID')}</td>
                <td><strong>${t.exchange}</strong></td>
                <td>${t.symbol}</td>
                <td><span class="badge ${t.side.toLowerCase() === 'buy' ? 'badge-buy' : 'badge-sell'}">${t.side}</span></td>
                <td>$${Number(t.price).toFixed(t.price < 1 ? 4 : 2)}</td>
                <td>${Number(t.amount).toFixed(4)}</td>
                <td>$${Number(t.costUsdt).toFixed(2)}</td>
                <td style="font-weight: 700; color: ${(t.realizedPnl || 0) >= 0 ? '#059669' : '#dc2626'};">
                  ${(t.realizedPnl || 0) >= 0 ? '+' : ''}${(t.realizedPnl || 0).toFixed(2)}
                </td>
                <td><span style="color: #059669; font-weight: 600;">FILLED</span></td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>

        <div class="footer">
          Dokumen ini digenerate secara otomatis oleh sistem analitik trading GAIN Algorithmic Platform. Seluruh catatan transaksi berasal langsung dari API resmi bursa terhubung.
        </div>
      </body>
      </html>
    `;

    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.open();
      printWindow.document.write(printableHtml);
      printWindow.document.close();
      printWindow.focus();
      setTimeout(() => {
        printWindow.print();
      }, 300);
    }
  };

  return (
    <div className="space-y-4">
      {sellToast && (
        <div
          role="status"
          aria-live="polite"
          className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${sellToast.isError
            ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-200'
            : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'}`}
        >
          <div>
            <p className="font-semibold">{sellToast.title}</p>
            <p className="mt-1 text-xs opacity-90">{sellToast.message}</p>
          </div>
          <button type="button" onClick={() => setSellToast(null)} aria-label="Tutup pesan sell" className="shrink-0 px-1 text-lg leading-none cursor-pointer">×</button>
        </div>
      )}

      {actionFeedback && (
        <div
          role="status"
          aria-live="polite"
          className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${actionFeedback.isError
            ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-200'
            : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'}`}
        >
          <div>
            <p className="font-semibold">{actionFeedback.title}</p>
            <p className="mt-1 text-xs opacity-90">{actionFeedback.message}</p>
          </div>
          <button type="button" onClick={() => setActionFeedback(null)} aria-label="Tutup notifikasi" className="shrink-0 px-1 text-lg leading-none cursor-pointer">×</button>
        </div>
      )}

      {/* Overview Metric Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <div className="p-3.5 rounded-xl bg-white dark:bg-[#08101D] border border-slate-200 dark:border-[#14233A] shadow-2xs">
          <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider block font-mono font-medium">
            {t('totalRealizedPnl')}
          </span>
          <div
            className={`text-lg font-bold font-mono mt-1 ${
              metrics.totalRealizedPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
            }`}
          >
            {metrics.totalRealizedPnl >= 0
              ? `+${metrics.totalRealizedPnl.toFixed(2)}`
              : metrics.totalRealizedPnl.toFixed(2)}{' '}
            <span className="text-xs text-slate-400">USDT</span>
          </div>
          <span className="text-[10px] text-emerald-600 dark:text-emerald-300 font-mono mt-0.5 block font-semibold">
            {metrics.sellCount} Order SELL Realized
          </span>
        </div>

        <div className="p-3.5 rounded-xl bg-white dark:bg-[#08101D] border border-slate-200 dark:border-[#14233A] shadow-2xs">
          <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider block font-mono font-medium">
            {t('totalTrades')}
          </span>
          <div className="text-lg font-bold text-slate-900 dark:text-white font-mono mt-1">
            ${metrics.totalVolumeUsdt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <span className="text-[10px] text-slate-400 font-mono mt-0.5 block">
            {metrics.totalCount} Order Terisi
          </span>
        </div>

        <div className="p-3.5 rounded-xl bg-white dark:bg-[#08101D] border border-slate-200 dark:border-[#14233A] shadow-2xs">
          <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider block font-mono font-medium">
            {t('winRate')}
          </span>
          <div className="text-lg font-bold text-[#74b72e] dark:text-[#8DC63F] font-mono mt-1">
            {metrics.winRate === '—' ? '—' : `${metrics.winRate}%`}
          </div>
          <span className="text-[10px] text-slate-400 font-mono mt-0.5 block">
            {metrics.realizedTradeCount > 0 ? `${metrics.winCount} W / ${metrics.lossCount} L` : '—'}
          </span>
        </div>

        <div className="p-3.5 rounded-xl bg-white dark:bg-[#08101D] border border-slate-200 dark:border-[#14233A] shadow-2xs">
          <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider block font-mono font-medium">
            Spot DCA & Averaging
          </span>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400 font-mono">
              {metrics.buyCount} BUY
            </span>
            <span className="text-slate-300 dark:text-slate-600 font-mono">/</span>
            <span className="text-sm font-bold text-[#74b72e] dark:text-[#8DC63F] font-mono">
              {metrics.sellCount} SELL
            </span>
          </div>
          <span className="text-[10px] text-slate-400 font-mono mt-0.5 block">
            Spot Matrix Engine
          </span>
        </div>
      </div>

      {/* View Mode Switcher + Action Controls */}
      <div className="p-3 rounded-xl bg-white dark:bg-[#08101D] border border-slate-200 dark:border-[#14233A] flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 shadow-2xs">
        {/* Left: View Mode Toggle */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-xl bg-slate-100 dark:bg-slate-900/80 p-1 border border-slate-200 dark:border-[#162740] font-mono text-xs">
            <button
              onClick={() => setViewMode('cards')}
              className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 font-bold cursor-pointer ${
                viewMode === 'cards'
                  ? 'bg-[#0099ff] text-white shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Kartu Bot</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-black/20 text-white font-mono">
                {botPositions.length}
              </span>
            </button>

            <button
              onClick={() => setViewMode('open_orders')}
              className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 font-bold cursor-pointer ${
                viewMode === 'open_orders'
                  ? 'bg-amber-500 text-white shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              <span>Order Terbuka</span>
              {openOrders.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-black/20 text-white font-mono animate-pulse">
                  {openOrders.length}
                </span>
              )}
            </button>

            <button
              onClick={() => setViewMode('table')}
              className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 font-bold cursor-pointer ${
                viewMode === 'table'
                  ? 'bg-slate-200 dark:bg-[#152742] text-slate-900 dark:text-[#8DC63F] shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <ListFilter className="w-3.5 h-3.5" />
              <span>Riwayat Transaksi</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-black/10 dark:bg-white/10 text-slate-700 dark:text-slate-300 font-mono">
                {filteredTrades.length}
              </span>
            </button>
          </div>

          {/* Pair filter dropdown */}
          <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-[#060B14] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-[#162740]">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <select
              id="trade-pair-filter"
              name="trade-pair-filter"
              value={selectedPair}
              onChange={(e) => setSelectedPair(e.target.value)}
              className="bg-transparent text-xs text-slate-800 dark:text-white font-mono focus:outline-none cursor-pointer"
            >
              {availablePairs.map((p) => (
                <option key={p} value={p} className="bg-white dark:bg-[#0B1525] text-slate-800 dark:text-white">
                  {p === 'ALL' ? t('allPairs') : p}
                </option>
              ))}
            </select>
          </div>

          {/* Side filter dropdown (BUY vs SELL) for table & open orders */}
          {viewMode !== 'cards' && (
            <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-[#060B14] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-[#162740]">
              <select
                id="trade-side-filter"
                name="trade-side-filter"
                value={selectedSide}
                onChange={(e) => setSelectedSide(e.target.value as any)}
                className="bg-transparent text-xs text-slate-800 dark:text-white font-mono focus:outline-none cursor-pointer"
              >
                <option value="ALL" className="bg-white dark:bg-[#0B1525] text-slate-800 dark:text-white">Semua Arah</option>
                <option value="buy" className="bg-white dark:bg-[#0B1525] text-emerald-600">BUY Saja</option>
                <option value="sell" className="bg-white dark:bg-[#0B1525] text-rose-600">SELL Saja</option>
              </select>
            </div>
          )}

          {/* Time range filter for table */}
          {viewMode === 'table' && (
            <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-[#060B14] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-[#162740]">
              <Calendar className="w-3.5 h-3.5 text-slate-400" />
              <select
                id="trade-time-filter"
                name="trade-time-filter"
                value={selectedTimeRange}
                onChange={(e) => setSelectedTimeRange(e.target.value as any)}
                className="bg-transparent text-xs text-slate-800 dark:text-white font-mono focus:outline-none cursor-pointer"
              >
                <option value="ALL" className="bg-white dark:bg-[#0B1525] text-slate-800 dark:text-white">Semua Waktu</option>
                <option value="24h" className="bg-white dark:bg-[#0B1525] text-slate-800 dark:text-white">24 Jam Terakhir</option>
                <option value="7d" className="bg-white dark:bg-[#0B1525] text-slate-800 dark:text-white">7 Hari Terakhir</option>
                <option value="30d" className="bg-white dark:bg-[#0B1525] text-slate-800 dark:text-white">30 Hari Terakhir</option>
              </select>
            </div>
          )}

          {/* Status filter dropdown (Active vs Standby/Histori) for cards */}
          {viewMode === 'cards' && (
            <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-[#060B14] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-[#162740]">
              <Activity className="w-3.5 h-3.5 text-[#74b72e] dark:text-[#8DC63F]" />
              <select
                id="trade-status-filter"
                name="trade-status-filter"
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value as any)}
                className="bg-transparent text-xs text-slate-800 dark:text-white font-mono focus:outline-none cursor-pointer"
              >
                <option value="ALL" className="bg-white dark:bg-[#0B1525] text-slate-800 dark:text-white">{t('allStatuses')}</option>
                <option value="active" className="bg-white dark:bg-[#0B1525] text-slate-800 dark:text-white">Running</option>
                <option value="inactive" className="bg-white dark:bg-[#0B1525] text-slate-800 dark:text-white">Standby</option>
              </select>
            </div>
          )}
        </div>

        {/* Right: Search, Sync & Export */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              id="trade-search-query"
              name="trade-search-query"
              type="text"
              placeholder={t('searchTradePairs')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 rounded-lg bg-slate-50 dark:bg-[#060B14] border border-slate-200 dark:border-[#162740] text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 font-mono focus:outline-none focus:border-[#8DC63F]/50 w-44 sm:w-56"
            />
          </div>

          <button
            onClick={hasExchangeConnection ? handleSyncAll : onOpenApiKeyModal}
            disabled={isSyncing || isLoadingOpenOrders}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#0F1E33] dark:hover:bg-[#152B4A] border border-slate-200 dark:border-[#1F3A60] text-xs font-mono text-[#74b72e] dark:text-[#8DC63F] font-semibold transition disabled:opacity-50 cursor-pointer"
            title="Tarik transaksi riil & order terbuka dari bursa via CCXT API"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${(isSyncing || isLoadingOpenOrders) ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{(isSyncing || isLoadingOpenOrders) ? 'Sinkron...' : 'Tarik Bursa'}</span>
          </button>

          <button
            onClick={handleExportCsv}
            disabled={filteredTrades.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#0F1E33] dark:hover:bg-[#152B4A] border border-slate-200 dark:border-[#1F3A60] text-xs font-mono text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition disabled:opacity-40 cursor-pointer"
            title="Ekspor data ke file CSV"
          >
            <Download className="w-3.5 h-3.5" />
            <span>CSV</span>
          </button>

          <button
            onClick={handleExportPdfReport}
            disabled={filteredTrades.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#8DC63F]/10 dark:hover:bg-[#8DC63F]/20 border border-slate-200 dark:border-[#8DC63F]/30 text-xs font-mono text-[#74b72e] dark:text-[#8DC63F] transition disabled:opacity-40 cursor-pointer"
            title="Cetak Laporan Audit / Simpan PDF"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>PDF / Cetak</span>
          </button>
        </div>
      </div>

      {/* VIEW MODE 1: TRADE HISTORY CARDS */}
      {viewMode === 'cards' && (
        <div className="space-y-4">
          {botPositions.length === 0 ? (
            <div className="p-8 rounded-2xl bg-[#08101D] border border-dashed border-[#1B2F4D] text-center space-y-2 font-mono">
              <Layers className="w-8 h-8 text-[#8DC63F] mx-auto opacity-70" />
              <p className="text-xs text-slate-300 font-bold">
                {selectedStatus === 'active'
                  ? 'Tidak ada bot aktif yang sedang berjalan di engine.'
                  : 'Tidak ada posisi bot yang cocok dengan filter.'}
              </p>
              <p className="text-[11px] text-slate-500 max-w-md mx-auto">
                Status bot 0 terhubung menandakan semua runner bot saat ini berstatus standby atau di-pause. Data posisi histori tersimpan di database proyeksi.
              </p>
            </div>
          ) : (
            botPositions.map((pos, idx) => {
              const coin = pos.coin || pos.pair.split('/')[0];
              const isCollapsed = !!collapsedPairs[pos.pair];
              const currentPrice = typeof pos.price === 'number' ? pos.price : parseFloat(pos.price) || 1;

              // Real Position & Trade Metrics
              const pairTrades = trades.filter((t) => t.symbol === pos.pair);
              const latestTrade = pairTrades[0];
              const totalPairTradeVol = pairTrades.reduce((sum, t) => sum + (t.costUsdt || 0), 0);
              const totalPairTradeAmount = pairTrades.reduce((sum, t) => sum + (t.amount || 0), 0);

              const executedLayersCoinQty = Array.isArray(pos.executedLayers)
                ? pos.executedLayers.reduce((acc, l) => acc + (l.amount || 0), 0)
                : 0;
              const executedLayersCostUsdt = Array.isArray(pos.executedLayers)
                ? pos.executedLayers.reduce((acc, l) => acc + (l.costUsdt || 0), 0)
                : 0;

              const avgCoinAmount = totalPairTradeAmount > 0
                ? totalPairTradeAmount
                : (executedLayersCoinQty > 0
                    ? executedLayersCoinQty
                    : (pos.totalCoinQty || parseFloat(pos.allocationQty || '0')));
              const avgCostUsdt = totalPairTradeVol > 0
                ? totalPairTradeVol
                : (executedLayersCostUsdt > 0
                    ? executedLayersCostUsdt
                    : (pos.totalCostUsdt || parseFloat(pos.allocationUsdt || '0')));
              const avgBuyPrice = pos.avgBuyPrice || (pairTrades[0]?.price ? Number(pairTrades[0].price) : currentPrice);
              const avgFloatingPnl = pos.floatingPnl || (avgCostUsdt > 0 ? ((currentPrice - avgBuyPrice) * avgCoinAmount) : 0);
              const avgRoiPct = pos.roiPct || (avgCostUsdt > 0 ? (avgFloatingPnl / avgCostUsdt) * 100 : 0);
              const avgDate = latestTrade
                ? new Date(latestTrade.timestamp).toLocaleString('id-ID', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : (pos.status === 'active' ? 'Posisi Berjalan' : 'Standby');

              const executedCount = Number(pos.executedLayerCount ?? pos.executedLayers?.length ?? (pos.status === 'active' && avgCoinAmount > 0 ? 1 : 0));
              const maxLayers = Math.max(1, Number(pos.maxStep) || 100);
              const modeLabel = getBotModeLabel(normalizeBotMode(pos.botMode), (language as any) || 'id');

              const rawAlloc = String(pos.allocationUsdt || '').replace(/[^0-9.]/g, '');
              const allocVal = parseFloat(rawAlloc);
              const allocDisplay = !isNaN(allocVal) && allocVal > 0 ? `$${allocVal.toFixed(2)}` : (pos.allocationUsdt || '—');

              return (
                <div
                  key={`${pos.id || 'pos'}-${idx}`}
                  className="rounded-2xl overflow-hidden border border-slate-200 dark:border-[#162947] bg-white dark:bg-[#070D18] shadow-sm transition hover:border-slate-300 dark:hover:border-[#223d68]"
                >
                  {/* Pair Header Ribbon */}
                  <div
                    className={`w-full px-4 py-3 flex items-center justify-between font-mono text-sm transition border-b ${
                      pos.status === 'active'
                        ? 'bg-slate-50 dark:bg-gradient-to-r dark:from-[#0C1B33] dark:via-[#10274B] dark:to-[#153466] border-slate-200 dark:border-[#1B3B6D]'
                        : 'bg-slate-50 dark:bg-gradient-to-r dark:from-[#0E1B2E] dark:to-[#1A2E4B] border-slate-200 dark:border-[#1A2E4B]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                      <button
                        type="button"
                        onClick={() => togglePairCollapse(pos.pair)}
                        className="flex items-center gap-2.5 text-left cursor-pointer hover:opacity-90 transition"
                      >
                        <CoinLogo coin={coin} size="sm" />
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="tracking-wide uppercase font-black text-slate-900 dark:text-white text-sm">{pos.pair}</span>
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                            {modeLabel}
                          </span>
                        </div>
                      </button>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`text-[10.5px] sm:text-xs font-semibold px-2.5 py-1 rounded-lg font-mono flex items-center gap-1.5 ${
                          pos.status === 'active'
                            ? 'bg-emerald-500/10 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                            : 'bg-slate-200 dark:bg-slate-700/60 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-600/40'
                        }`}
                      >
                        {pos.status === 'active' ? (
                          <>
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-pulse" />
                            <span>RUNNING · {executedCount} / {maxLayers} Layer</span>
                          </>
                        ) : (
                          <span>STANDBY · {executedCount} Layer</span>
                        )}
                      </span>

                      {onDeleteBot && pos.status !== 'active' && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteBot(pos);
                          }}
                          className="p-1 hover:bg-rose-500/10 dark:hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 rounded transition cursor-pointer"
                          title="Hapus proyeksi bot standby ini"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => togglePairCollapse(pos.pair)}
                        className="p-1 text-slate-500 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
                        aria-label={isCollapsed ? 'Buka kartu' : 'Tutup kartu'}
                      >
                        {isCollapsed ? (
                          <ChevronDown className="w-4 h-4 stroke-[2.5]" />
                        ) : (
                          <ChevronUp className="w-4 h-4 stroke-[2.5]" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Body Content */}
                  {!isCollapsed && (
                    <div className="p-4 sm:p-5 space-y-4 bg-white dark:bg-[#070D18]">
                      {/* 4 Primary Metric Cards */}
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
                        {/* Metric 1: Total Coin Qty */}
                        <div className="p-3 sm:p-3.5 rounded-xl bg-slate-50 dark:bg-[#0B1527] border border-slate-200 dark:border-[#142642] flex flex-col justify-between shadow-2xs">
                          <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider block font-mono font-medium">
                            Total Koin Terisi
                          </span>
                          <div className="mt-1">
                            <div className="text-sm sm:text-base font-extrabold text-slate-900 dark:text-white font-mono truncate">
                              {avgCoinAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} {coin}
                            </div>
                            <div className="text-[10.5px] text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                              ≈ ${(avgCoinAmount * currentPrice).toFixed(2)} USDT
                            </div>
                          </div>
                        </div>

                        {/* Metric 2: Modal Masuk (Cost) */}
                        <div className="p-3 sm:p-3.5 rounded-xl bg-slate-50 dark:bg-[#0B1527] border border-slate-200 dark:border-[#142642] flex flex-col justify-between shadow-2xs">
                          <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider block font-mono font-medium">
                            Modal Terpakai (Cost)
                          </span>
                          <div className="mt-1">
                            <div className="text-sm sm:text-base font-extrabold text-slate-900 dark:text-white font-mono truncate">
                              ${avgCostUsdt.toFixed(2)} USDT
                            </div>
                            <div className="text-[10.5px] text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                              Alokasi: {allocDisplay}
                            </div>
                          </div>
                        </div>

                        {/* Metric 3: Harga Beli Rata-Rata -> Pasar */}
                        <div className="p-3 sm:p-3.5 rounded-xl bg-slate-50 dark:bg-[#0B1527] border border-slate-200 dark:border-[#142642] flex flex-col justify-between shadow-2xs">
                          <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider block font-mono font-medium">
                            Harga Beli &rarr; Pasar
                          </span>
                          <div className="mt-1">
                            <div className="text-xs sm:text-sm font-bold font-mono text-[#74b72e] dark:text-[#8DC63F] truncate">
                              ${avgBuyPrice.toFixed(4)} &rarr; ${currentPrice.toFixed(4)}
                            </div>
                            <div className="text-[10.5px] text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                              Target TP: {pos.tpTargetPrice ? `$${pos.tpTargetPrice}` : '+1.50% Trailing'}
                            </div>
                          </div>
                        </div>

                        {/* Metric 4: Floating PnL & ROI */}
                        <div className="p-3 sm:p-3.5 rounded-xl bg-slate-50 dark:bg-[#0B1527] border border-slate-200 dark:border-[#142642] flex flex-col justify-between shadow-2xs">
                          <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider block font-mono font-medium">
                            Floating PnL / ROI
                          </span>
                          <div className="mt-1">
                            <div
                              className={`text-sm sm:text-base font-extrabold font-mono truncate ${
                                avgFloatingPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                              }`}
                            >
                              {avgFloatingPnl >= 0 ? `+${avgFloatingPnl.toFixed(4)}` : avgFloatingPnl.toFixed(4)} USDT
                            </div>
                            <div
                              className={`text-[10.5px] font-bold font-mono mt-0.5 ${
                                avgRoiPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                              }`}
                            >
                              {avgRoiPct >= 0 ? `+${avgRoiPct.toFixed(2)}%` : `${avgRoiPct.toFixed(2)}%`} ROI
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Strategy & Status Ribbon */}
                      <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#0B1527]/70 border border-slate-200 dark:border-[#142642] flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-mono shadow-2xs">
                        <div className="flex items-center gap-2 flex-wrap text-slate-600 dark:text-slate-300">
                          <span className="text-slate-500 dark:text-slate-400">Strategi Engine:</span>
                          <span className="font-bold text-slate-900 dark:text-white">{modeLabel}</span>
                          <span className="text-slate-300 dark:text-slate-600">•</span>
                          <span className="text-slate-500 dark:text-slate-400">Terisi:</span>
                          <span className="font-bold text-amber-600 dark:text-amber-400">{executedCount} dari {maxLayers} Layer</span>
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          Status: <span className="text-slate-700 dark:text-slate-300 font-medium">{avgDate}</span>
                        </div>
                      </div>

                      {/* Action Controls: 3 Buttons (View, Info, Sell) */}
                      <div className="pt-2 border-t border-slate-200 dark:border-[#142642] grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                        <button
                          type="button"
                          onClick={() => handleOpenDetail(pos)}
                          className="py-2 px-3 rounded-xl bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 dark:bg-[#0099ff]/15 dark:hover:bg-[#0099ff]/25 dark:border-[#0099ff]/40 dark:text-[#38bdf8] hover:text-sky-800 dark:hover:text-white font-bold text-xs font-mono flex items-center justify-center gap-2 transition shadow-2xs cursor-pointer active:scale-95"
                          title="Buka rincian detail seluruh layer order terisi"
                        >
                          <Eye className="w-4 h-4 stroke-[2.2]" />
                          <span>Detail Layer ({executedCount})</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleOpenInfo(pos)}
                          className="py-2 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 dark:bg-slate-800/80 dark:hover:bg-slate-700/80 dark:border-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white font-bold text-xs font-mono flex items-center justify-center gap-2 transition shadow-2xs cursor-pointer active:scale-95"
                          title="Buka parameter konfigurasi & info strategi bot"
                        >
                          <Info className="w-4 h-4 stroke-[2.2]" />
                          <span>Info Algoritma</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleForceSell(pos)}
                          disabled={isSelling || !onForceTakeProfit}
                          className="py-2 px-3 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 dark:bg-rose-500/15 dark:hover:bg-rose-500/25 dark:border-rose-500/40 dark:text-rose-300 hover:text-rose-800 dark:hover:text-rose-100 font-bold text-xs font-mono flex items-center justify-center gap-2 transition shadow-2xs cursor-pointer active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Eksekusi manual Sell / Take Profit posisi ini di bursa"
                        >
                          <CreditCard className="w-4 h-4 stroke-[2.2]" />
                          <span>{isSelling ? 'Memproses Sell...' : 'Sell Posisi (Market TP)'}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* VIEW MODE 2: OPEN ORDERS (ANTREAN ORDER DI BURSA) */}
      {viewMode === 'open_orders' && (
        <div className="space-y-3">
          {isLoadingOpenOrders ? (
            <div className="p-12 text-center text-slate-400 font-mono text-xs flex flex-col items-center justify-center gap-3 bg-white dark:bg-[#08101D] rounded-2xl border border-slate-200 dark:border-[#14233A]">
              <RefreshCw className="w-6 h-6 animate-spin text-[#8DC63F]" />
              <p>Menghubungi bursa via CCXT API untuk memeriksa order limit terbuka...</p>
            </div>
          ) : filteredOpenOrders.length === 0 ? (
            <div className="p-8 sm:p-12 rounded-2xl bg-white dark:bg-[#08101D] border border-dashed border-slate-300 dark:border-[#1B2F4D] text-center space-y-3 shadow-2xs">
              <Clock className="w-10 h-10 text-amber-500 mx-auto opacity-70" />
              <h4 className="text-sm font-bold text-slate-900 dark:text-white font-mono">Tidak Ada Order Terbuka di Bursa</h4>
              <p className="text-xs font-mono text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
                Semua pesanan limit telah terisi (filled) atau dibatalkan. Ketika bot trading memasang antrean jaring beli DCA atau limit take profit, pesanan aktif yang belum tereksekusi akan tampil di sini.
              </p>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleLoadOpenOrders}
                  disabled={isLoadingOpenOrders}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs font-mono font-bold transition cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingOpenOrders ? 'animate-spin' : ''}`} />
                  <span>Segarkan Order Terbuka</span>
                </button>
              </div>
            </div>
          ) : (
            filteredOpenOrders.map((o) => {
              const isBuy = o.side === 'buy';
              const formattedDate = new Date(o.timestamp).toLocaleString('id-ID', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              });
              const isCancelling = cancellingOrderId === o.orderId;

              return (
                <div
                  key={o.id}
                  className="p-3.5 rounded-xl bg-white dark:bg-[#08101D] border border-amber-500/30 dark:border-[#2A2B1D] hover:border-amber-500/50 transition flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs font-mono shadow-2xs"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 ${
                        isBuy
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                          : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
                      }`}
                    >
                      <Clock className="w-4 h-4 text-amber-500 stroke-[2.2]" />
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <CoinLogo coin={o.symbol} size="xs" />
                        <span className="font-extrabold text-sm text-slate-900 dark:text-white">{o.symbol}</span>
                        <span
                          className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider ${
                            isBuy
                              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                              : 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30'
                          }`}
                        >
                          {isBuy ? 'BUY LIMIT' : 'SELL LIMIT'}
                        </span>
                        <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 animate-pulse">
                          Antrean Aktif
                        </span>
                        {o.isSandbox && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/10 text-amber-600 border border-amber-500/20">
                            Testnet
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 text-[10.5px] mt-1.5 flex-wrap">
                        <span>{formattedDate}</span>
                        <span>·</span>
                        <span>Bursa: <strong className="text-slate-700 dark:text-slate-300 font-semibold">{o.exchange}</strong></span>
                        <span>·</span>
                        <button
                          type="button"
                          onClick={() => handleCopy(o.id, o.orderId)}
                          className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-900 dark:hover:text-white transition cursor-pointer font-mono group"
                          title="Salin Order ID"
                        >
                          <span>ID: {o.orderId.substring(0, 14)}</span>
                          {copiedId === o.id ? (
                            <Check className="w-3 h-3 text-emerald-500 shrink-0" />
                          ) : (
                            <Copy className="w-3 h-3 opacity-60 group-hover:opacity-100 shrink-0" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between md:justify-end gap-5 pt-2.5 md:pt-0 border-t md:border-t-0 border-slate-100 dark:border-[#121E31] shrink-0">
                    <div>
                      <span className="text-[9px] text-slate-500 dark:text-slate-400 block uppercase font-medium">Harga Antre</span>
                      <span className="font-bold text-slate-900 dark:text-white text-xs">${o.price.toFixed(o.price < 1 ? 4 : 2)}</span>
                    </div>

                    <div>
                      <span className="text-[9px] text-slate-500 dark:text-slate-400 block uppercase font-medium">Jumlah</span>
                      <span className="text-slate-700 dark:text-slate-300 font-semibold text-xs">{o.amount}</span>
                    </div>

                    <div className="text-right min-w-[85px]">
                      <span className="text-[9px] text-slate-500 dark:text-slate-400 block uppercase font-medium">Nilai USDT</span>
                      <span className="font-bold text-slate-900 dark:text-white block text-xs">${o.costUsdt.toFixed(2)} USDT</span>
                    </div>

                    <div className="shrink-0">
                      <button
                        type="button"
                        onClick={() => handleCancelOpenOrder(o)}
                        disabled={isCancelling}
                        className="px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 dark:bg-rose-500/15 dark:hover:bg-rose-500/25 dark:border-rose-500/40 dark:text-rose-300 text-[11px] font-bold font-mono transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5 active:scale-95 shadow-2xs"
                        title="Batalkan order antrean ini langsung di bursa"
                      >
                        {isCancelling ? (
                          <>
                            <RefreshCw className="w-3 h-3 animate-spin" />
                            <span>Membatalkan...</span>
                          </>
                        ) : (
                          <>
                            <XCircle className="w-3.5 h-3.5" />
                            <span>Batalkan Order</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* VIEW MODE 3: TABLE LOG OF ALL FILLED TRADES (RIWAYAT TRANSAKSI) */}
      {viewMode === 'table' && (
        <div className="space-y-2">
          {filteredTrades.length === 0 ? (
            <div className="p-8 sm:p-12 rounded-2xl bg-white dark:bg-[#08101D] border border-dashed border-slate-300 dark:border-[#1B2F4D] text-center space-y-3 shadow-2xs">
              <Layers className="w-10 h-10 text-[#74b72e] dark:text-[#8DC63F] mx-auto opacity-70" />
              <h4 className="text-sm font-bold text-slate-900 dark:text-white font-mono">Belum Ada Riwayat Transaksi Eksekusi Bursa</h4>
              <p className="text-xs font-mono text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
                {hasExchangeConnection
                  ? `Bursa ${connectedExchange?.exchange} (${connectedExchange?.isSandbox ? 'Testnet' : 'Live'}) terhubung melalui server. Belum ada fill transaksi pada rentang filter saat ini.`
                  : 'Hubungkan API Key bursa untuk menyinkronkan catatan transaksi riil.'}
              </p>
              {hasExchangeConnection ? (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={handleSyncAll}
                    disabled={isSyncing}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#8DC63F]/15 hover:bg-[#8DC63F]/25 border border-[#8DC63F]/30 text-[#74b72e] dark:text-[#8DC63F] text-xs font-mono font-bold transition cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                    <span>{isSyncing ? 'Menyinkronkan dari Bursa...' : 'Tarik Riwayat dari Bursa Sekarang'}</span>
                  </button>
                </div>
              ) : (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={onOpenApiKeyModal}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#8DC63F] hover:bg-[#7cb333] text-white text-xs font-mono font-bold transition cursor-pointer"
                  >
                    <span>Hubungkan API Bursa</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            filteredTrades.map((t, idx) => {
              const isBuy = t.side === 'buy';
              const formattedDate = new Date(t.timestamp).toLocaleString('id-ID', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              });

              return (
                <div
                  key={`${t.id || 'trade'}-${t.timestamp || ''}-${idx}`}
                  className="p-3.5 rounded-xl bg-white dark:bg-[#08101D] border border-slate-200 dark:border-[#14233A] hover:border-slate-300 dark:hover:border-[#1E365C] transition flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs font-mono shadow-2xs"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 ${
                        isBuy
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                          : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
                      }`}
                    >
                      {isBuy ? (
                        <ArrowDownLeft className="w-4 h-4 text-emerald-600 dark:text-emerald-400 stroke-[2.5]" />
                      ) : (
                        <ArrowUpRight className="w-4 h-4 text-rose-600 dark:text-rose-400 stroke-[2.5]" />
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <CoinLogo coin={t.symbol} size="xs" />
                        <span className="font-extrabold text-sm text-slate-900 dark:text-white">{t.symbol}</span>
                        <span
                          className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider ${
                            isBuy
                              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                              : 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30'
                          }`}
                        >
                          {isBuy ? 'BUY' : 'SELL'}
                        </span>
                        {t.layerStep ? (
                          <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                            Layer #{t.layerStep}
                          </span>
                        ) : isBuy ? (
                          <span className="px-2 py-0.5 rounded-md text-[9px] font-semibold bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/20">
                            Spot Entry
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-md text-[9px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20">
                            Take Profit
                          </span>
                        )}
                        {t.isSandbox && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/10 text-amber-600 border border-amber-500/20">
                            Testnet
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 text-[10.5px] mt-1.5 flex-wrap">
                        <span>{formattedDate}</span>
                        <span>·</span>
                        <span>Bursa: <strong className="text-slate-700 dark:text-slate-300 font-semibold">{t.exchange}</strong></span>
                        <span>·</span>
                        <button
                          type="button"
                          onClick={() => handleCopy(t.id, t.orderId || t.id)}
                          className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-900 dark:hover:text-white transition cursor-pointer font-mono group"
                          title="Salin ID Order"
                        >
                          <span>ID: {String(t.orderId || t.id).substring(0, 12)}</span>
                          {copiedId === t.id ? (
                            <Check className="w-3 h-3 text-emerald-500 shrink-0" />
                          ) : (
                            <Copy className="w-3 h-3 opacity-60 group-hover:opacity-100 shrink-0" />
                          )}
                        </button>
                        {t.fee && t.fee.cost > 0 && (
                          <>
                            <span>·</span>
                            <span className="text-slate-400">
                              Fee: <strong className="text-slate-600 dark:text-slate-300">{t.fee.cost.toFixed(4)} {t.fee.currency || 'USDT'}</strong>
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between md:justify-end gap-5 pt-2.5 md:pt-0 border-t md:border-t-0 border-slate-100 dark:border-[#121E31] shrink-0">
                    <div>
                      <span className="text-[9px] text-slate-500 dark:text-slate-400 block uppercase font-medium">Harga</span>
                      <span className="font-bold text-slate-900 dark:text-white text-xs">${t.price.toFixed(t.price < 1 ? 4 : 2)}</span>
                    </div>

                    <div>
                      <span className="text-[9px] text-slate-500 dark:text-slate-400 block uppercase font-medium">Jumlah</span>
                      <span className="text-slate-700 dark:text-slate-300 font-semibold text-xs">{t.amount}</span>
                    </div>

                    <div className="text-right min-w-[85px]">
                      <span className="text-[9px] text-slate-500 dark:text-slate-400 block uppercase font-medium">Total</span>
                      <span className="font-bold text-slate-900 dark:text-white block text-xs">${t.costUsdt.toFixed(2)} USDT</span>
                    </div>

                    {/* Realized PnL / Status Badge */}
                    <div className="text-right min-w-[105px]">
                      <span className="text-[9px] text-slate-500 dark:text-slate-400 block uppercase font-medium">
                        {isBuy ? 'Status' : 'Realized PnL'}
                      </span>
                      {isBuy ? (
                        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20 font-semibold mt-0.5">
                          ✓ TERISI
                        </span>
                      ) : t.realizedPnl !== undefined && Number.isFinite(t.realizedPnl) ? (
                        <div className="flex flex-col items-end mt-0.5">
                          <span
                            className={`font-black font-mono text-xs px-2 py-0.5 rounded-md border ${
                              t.realizedPnl >= 0
                                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                                : 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30'
                            }`}
                          >
                            {t.realizedPnl >= 0 ? `+` : ``}${t.realizedPnl.toFixed(2)} USDT
                          </span>
                          {t.pnlPercent !== undefined && Number.isFinite(t.pnlPercent) && (
                            <span className={`text-[10px] font-mono font-bold mt-0.5 ${t.pnlPercent >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                              ({t.pnlPercent >= 0 ? `+` : ``}{t.pnlPercent.toFixed(2)}%)
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md mt-0.5">
                          FILLED (SELL)
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {hasMoreTrades && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={onLoadMoreTrades}
            disabled={isLoadingMoreTrades}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#0E1A2C] border border-[#182B48] text-xs text-slate-300 hover:bg-[#142640] disabled:opacity-50"
          >
            {isLoadingMoreTrades && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            {isLoadingMoreTrades ? 'Memuat...' : 'Muat trade lebih lama'}
          </button>
        </div>
      )}

      {/* Trade Detail Modal (Image 1) */}
      <TradeDetailModal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        position={selectedPositionForDetail}
        onForceTakeProfit={onForceTakeProfit}
        onCloseLayer={onCloseLayer}
      />

      {/* Trade Info Modal (Image 2) */}
      <TradeInfoModal
        isOpen={isInfoModalOpen}
        onClose={() => setIsInfoModalOpen(false)}
        position={selectedPositionForInfo}
        onOpenSettings={onOpenMatrixModal}
      />
    </div>
  );
};
