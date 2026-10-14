import React, { useState, useEffect } from 'react';
import {
  Newspaper,
  Flame,
  Zap,
  ChevronLeft,
  ChevronRight,
  X,
  ExternalLink,
  Clock,
  Sparkles,
  TrendingUp,
  ShieldCheck,
  Pause,
  Play,
  Layers,
  ArrowRight
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  category: string;
  timeAgo: string;
  tag: 'HOT' | 'UPDATE' | 'ANALISIS' | 'KEAMANAN' | 'TRENDING' | 'BREAKING';
  source?: string;
  url?: string;
  impact?: string;
  publishedAt?: string;
}

const DEFAULT_NEWS_ID: NewsItem[] = [
  {
    id: 'n1',
    title: 'Bitcoin Tembus Level Kritis, Total Kapitalisasi Pasar Krypto Pertahankan $2.92 Triliun',
    summary: 'Pasar crypto global menunjukkan resiliensi tinggi di tengah lonjakan volume akumulasi institusional. Dominasi Bitcoin (BTC) kini mencapai 57.2% dengan dominasi Ethereum (ETH) berada pada level 10.8%.',
    category: 'BTC / MARKET',
    timeAgo: '10m lalu',
    tag: 'HOT',
    source: 'Gain Market Desk',
    impact: 'Positif untuk Akumulasi Spot & Trading Grid'
  },
  {
    id: 'n2',
    title: 'GAIN NiagaKoin Vault V4 Rilis Algoritma Trading Grid Dynamic Layering 24/7',
    summary: 'Platform GAIN meluncurkan optimasi algoritma otomatisasi baru yang meningkatkan akurasi entry posisi DCA dan mengurangi risiko drawdown ekstrem di bursa terhubung (Reku, Binance, Bybit, OKX).',
    category: 'GAIN VAULT',
    timeAgo: '25m lalu',
    tag: 'UPDATE',
    source: 'GAIN Engineering',
    impact: 'Meningkatkan Rasio Win-Rate & Efisiensi Gas'
  },
  {
    id: 'n3',
    title: 'Biaya Transaksi Gas ETH Melandai ke 15 Gwei, Aktivitas L2 Arbitrum & Base Melonjak',
    summary: 'Penurunan gas fee Ethereum memicu peningkatan frekuensi transaksi mikro smart contract dan bot trading terdesentralisasi secara efisien.',
    category: 'ETHEREUM',
    timeAgo: '45m lalu',
    tag: 'ANALISIS',
    source: 'On-Chain Intel',
    impact: 'Penghematan Biaya Eksekusi Transaksi'
  },
  {
    id: 'n4',
    title: 'Lisensi Bursa Kripto Global Diperketat, Lebih dari 1.500 Exchange Tingkatkan Audit PoR',
    summary: 'Transparansi dana nasabah menjadi prioritas utama. GAIN NiagaKoin menegaskan komitmen 100% non-kustodian melalui koneksi API key aman tanpa akses penarikan.',
    category: 'REGULASI',
    timeAgo: '1j lalu',
    tag: 'KEAMANAN',
    source: 'Crypto Regulatory Watch',
    impact: 'Keamanan Modal Exchange 100% Terjaga'
  },
  {
    id: 'n5',
    title: 'Rotasi Likuiditas Makro Moneter Mendorong Inflow Signifikan ke Aset Digital Kripto',
    summary: 'Pasar derivatif dan spot mencatatkan kenaikan volume harian hingga $110B+, mengindikasikan partisipasi kuat dari pelaku pasar institusional maupun retail.',
    category: 'MAKRO',
    timeAgo: '2j lalu',
    tag: 'TRENDING',
    source: 'Global Macro Insights',
    impact: 'Meningkatkan Volatilitas Trading Swing'
  }
];

const DEFAULT_NEWS_EN: NewsItem[] = [
  {
    id: 'n1',
    title: 'Bitcoin Holds Critical Support as Total Crypto Market Cap Holds $2.92 Trillion',
    summary: 'Global crypto markets demonstrate strong resilience amidst institutional accumulation. Bitcoin dominance stands at 57.2% with Ethereum at 10.8%.',
    category: 'BTC / MARKET',
    timeAgo: '10m ago',
    tag: 'HOT',
    source: 'Gain Market Desk',
    impact: 'Positive for Spot Accumulation & Grid Vault'
  },
  {
    id: 'n2',
    title: 'GAIN NiagaKoin Vault V4 Releases 24/7 Dynamic Layering Trading Algorithm',
    summary: 'GAIN Platform rolls out new automation algorithm optimizations, improving DCA position entry precision and minimizing drawdown risk on connected exchanges (Reku, Binance, Bybit, OKX).',
    category: 'GAIN VAULT',
    timeAgo: '25m ago',
    tag: 'UPDATE',
    source: 'GAIN Engineering',
    impact: 'Boosts Win-Rate Ratio & Gas Efficiency'
  },
  {
    id: 'n3',
    title: 'ETH Gas Fees Ease to 15 Gwei as Arbitrum & Base Layer-2 Activity Surges',
    summary: 'Lower Ethereum gas fees trigger higher micro-transaction frequency across smart contracts and automated vault execution.',
    category: 'ETHEREUM',
    timeAgo: '45m ago',
    tag: 'ANALISIS',
    source: 'On-Chain Intel',
    impact: 'Lower Execution Cost for Users'
  },
  {
    id: 'n4',
    title: 'Global Exchange Licensing Tightens: 1,500+ Exchanges Enhance Proof of Reserve Audits',
    summary: 'Fund transparency remains top priority. GAIN NiagaKoin reaffirms 100% non-custodial API integration with strict no-withdrawal key permissions.',
    category: 'REGULASI',
    timeAgo: '1h ago',
    tag: 'KEAMANAN',
    source: 'Crypto Regulatory Watch',
    impact: '100% Safe Non-Custodial Security'
  },
  {
    id: 'n5',
    title: 'Macro Liquidity Rotation Drives Capital Inflow to Digital Crypto Assets',
    summary: '24h trading volume reaches $110B+, signaling solid momentum and sustained trading volume across major spot & futures markets.',
    category: 'MAKRO',
    timeAgo: '2h ago',
    tag: 'TRENDING',
    source: 'Global Macro Insights',
    impact: 'Favorable Volatility for Algorithmic Bots'
  }
];

export function HeaderNewsTicker() {
  const { language } = useLanguage();
  const isEn = language === 'en';

  const defaultList = isEn ? DEFAULT_NEWS_EN : DEFAULT_NEWS_ID;
  const [news, setNews] = useState<NewsItem[]>(defaultList);
  const [selectedNews, setSelectedNews] = useState<NewsItem | null>(null);
  const [isAllModalOpen, setIsAllModalOpen] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);

  // Sync default list on language change if not custom fetched
  useEffect(() => {
    setNews(defaultList);
  }, [language]);

  // Live news fetch removed to prevent CORS and 401 Unauthorized errors from CryptoCompare API.
  // The ticker now exclusively uses the curated static news defined in DEFAULT_NEWS_ID and DEFAULT_NEWS_EN.

  // Cycle current headline index for manual/compact view if needed
  const handlePrev = () => {
    setCurrentIndex((prev) => (prev === 0 ? news.length - 1 : prev - 1));
  };

  const handleNext = () => {
    setCurrentIndex((prev) => (prev === news.length - 1 ? 0 : prev + 1));
  };

  const getTagColor = (tag: NewsItem['tag']) => {
    switch (tag) {
      case 'HOT':
      case 'BREAKING':
        return 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30';
      case 'UPDATE':
        return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30';
      case 'ANALISIS':
        return 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30';
      case 'KEAMANAN':
        return 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30';
      default:
        return 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30';
    }
  };

  // Double list for 100% seamless infinite marquee scrolling
  const marqueeItems = [...news, ...news];

  return (
    <>
      {/* Modern Compact Top News Ticker Bar */}
      <div className="w-full bg-slate-900 text-white dark:bg-[#070A11] dark:text-slate-200 border-b border-slate-800 dark:border-[#1E2E44] px-2.5 sm:px-4 py-1.5 text-[11px] font-sans flex items-center justify-between gap-2 overflow-hidden select-none">
        
        {/* Left Badge: Live News Indicator */}
        <div className="flex items-center gap-1.5 shrink-0 z-10 bg-slate-900 dark:bg-[#070A11] pr-2 border-r border-slate-700/60 dark:border-slate-800">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <div className="flex items-center gap-1 text-[10px] sm:text-[11px] font-bold tracking-wider uppercase text-emerald-400 font-mono">
            <Zap className="w-3 h-3 text-amber-400 fill-amber-400/20" />
            <span className="hidden xs:inline">{isEn ? 'Krypto News' : 'Kabar Krypto'}</span>
            <span className="xs:hidden">News</span>
          </div>
        </div>

        {/* Center: Running Marquee / Ticker (Seamless CSS Marquee with Hover Pause) */}
        <div 
          className="flex-1 overflow-hidden relative group py-0.5 cursor-pointer"
          onMouseEnter={() => setIsPaused(true)}
          onMouseLeave={() => setIsPaused(false)}
        >
          <div 
            className={`flex items-center gap-6 whitespace-nowrap transition-all ${
              isPaused ? '[animation-play-state:paused]' : ''
            } animate-news-marquee`}
          >
            {marqueeItems.map((item, index) => (
              <div
                key={`${item.id}-${index}`}
                onClick={() => setSelectedNews(item)}
                className="inline-flex items-center gap-2 text-slate-200 hover:text-emerald-400 transition-colors group-hover:underline decoration-emerald-500/50 underline-offset-2 shrink-0"
              >
                <span className={`px-1.5 py-0.2 rounded text-[9.5px] font-bold uppercase border ${getTagColor(item.tag)} font-mono`}>
                  {item.tag}
                </span>
                <span className="font-semibold text-xs text-slate-100 dark:text-slate-200">
                  [{item.category}]
                </span>
                <span className="text-slate-300 dark:text-slate-300 font-normal">
                  {item.title}
                </span>
                <span className="text-[10px] text-slate-400 font-mono">
                  • {item.timeAgo}
                </span>
                <span className="text-slate-700 dark:text-slate-700 ml-3">|</span>
              </div>
            ))}
          </div>

          {/* Hover Overlay Hint */}
          <div className="absolute right-0 top-0 bottom-0 pointer-events-none bg-gradient-to-l from-slate-900 dark:from-[#070A11] to-transparent w-8 z-10"></div>
        </div>

        {/* Right Action Controls: Prev/Next & View All Modal */}
        <div className="flex items-center gap-1.5 shrink-0 pl-1 z-10 bg-slate-900 dark:bg-[#070A11]">
          <button
            onClick={() => setIsPaused(!isPaused)}
            className="p-1 rounded hover:bg-slate-800 dark:hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
            title={isPaused ? (isEn ? 'Resume Scrolling' : 'Jalankan Ticker') : (isEn ? 'Pause Scrolling' : 'Jeda Ticker')}
          >
            {isPaused ? <Play className="w-3 h-3 text-emerald-400" /> : <Pause className="w-3 h-3" />}
          </button>

          <button
            onClick={() => setIsAllModalOpen(true)}
            className="px-2 py-0.5 rounded bg-slate-800 dark:bg-[#141F32] hover:bg-slate-700 dark:hover:bg-[#1E2E44] text-slate-300 hover:text-white border border-slate-700/60 dark:border-[#27374D] text-[10px] font-mono font-medium flex items-center gap-1 transition-all"
            title={isEn ? 'View all news articles' : 'Lihat semua berita'}
          >
            <Newspaper className="w-3 h-3 text-emerald-400" />
            <span className="hidden sm:inline">{isEn ? 'All Articles' : 'Semua News'}</span>
            <span className="px-1 py-0.2 text-[9px] rounded bg-emerald-500/20 text-emerald-400 font-bold">
              {news.length}
            </span>
          </button>
        </div>
      </div>

      {/* ARTICLE READER MODAL */}
      {selectedNews && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-md animate-fadeIn">
          <div className="bg-white dark:bg-[#0D1424] border border-slate-200 dark:border-[#1E2E44] rounded-2xl shadow-2xl max-w-xl w-full overflow-hidden text-slate-900 dark:text-white transition-all transform duration-200 scale-100">
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-slate-200 dark:border-[#1E2E44] flex items-center justify-between bg-slate-50 dark:bg-[#111827]">
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold border font-mono ${getTagColor(selectedNews.tag)}`}>
                  {selectedNews.tag}
                </span>
                <span className="text-xs font-mono font-bold text-slate-500 dark:text-slate-400">
                  {selectedNews.category}
                </span>
              </div>
              <button
                onClick={() => setSelectedNews(null)}
                className="w-8 h-8 rounded-full bg-slate-200/60 dark:bg-slate-800/80 hover:bg-slate-300 dark:hover:bg-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-300 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
              <h2 className="text-base sm:text-lg font-bold leading-snug text-slate-900 dark:text-white">
                {selectedNews.title}
              </h2>

              <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 font-mono border-b border-slate-100 dark:border-[#1E2E44] pb-3">
                <span className="flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-emerald-500" />
                  {selectedNews.timeAgo}
                </span>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  {selectedNews.source || 'GAIN News Feed'}
                </span>
              </div>

              <div className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed font-sans space-y-3">
                <p>{selectedNews.summary}</p>
              </div>

              {/* Impact / Takeaway Card */}
              {selectedNews.impact && (
                <div className="p-3.5 rounded-xl bg-emerald-500/10 dark:bg-emerald-950/30 border border-emerald-500/20 flex items-start gap-3">
                  <TrendingUp className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-[11px] font-bold uppercase text-emerald-600 dark:text-emerald-400 block font-mono">
                      {isEn ? 'Market & Vault Impact' : 'Dampak Pasar & Strategi Vault'}
                    </span>
                    <p className="text-xs font-medium text-slate-800 dark:text-slate-200 mt-0.5">
                      {selectedNews.impact}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-3.5 border-t border-slate-200 dark:border-[#1E2E44] bg-slate-50 dark:bg-[#111827] flex items-center justify-between">
              {selectedNews.url ? (
                <a
                  href={selectedNews.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-500 text-slate-900 font-bold text-xs hover:bg-emerald-400 transition"
                >
                  {isEn ? 'Read Source' : 'Buka Artikel Asli'}
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              ) : (
                <div className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                  {isEn ? 'Verified Gain Intelligence' : 'Terverifikasi GAIN Intelligence'}
                </div>
              )}

              <button
                onClick={() => setSelectedNews(null)}
                className="px-4 py-1.5 rounded-lg bg-slate-200 dark:bg-[#1E2E44] text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-[#27374D] font-medium text-xs transition"
              >
                {isEn ? 'Close' : 'Tutup'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ALL ARTICLES MODAL */}
      {isAllModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-md animate-fadeIn">
          <div className="bg-white dark:bg-[#0D1424] border border-slate-200 dark:border-[#1E2E44] rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden text-slate-900 dark:text-white transition-all transform duration-200">
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-200 dark:border-[#1E2E44] flex items-center justify-between bg-slate-50 dark:bg-[#111827]">
              <div className="flex items-center gap-2">
                <Newspaper className="w-5 h-5 text-emerald-500" />
                <h3 className="font-bold text-base text-slate-900 dark:text-white">
                  {isEn ? 'Latest Crypto News & Articles' : 'Berita & Artikel Krypto Terbaru'}
                </h3>
              </div>
              <button
                onClick={() => setIsAllModalOpen(false)}
                className="w-8 h-8 rounded-full bg-slate-200/60 dark:bg-slate-800/80 hover:bg-slate-300 dark:hover:bg-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-300 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* News List */}
            <div className="p-5 space-y-3 max-h-[65vh] overflow-y-auto divide-y divide-slate-100 dark:divide-[#1E2E44]">
              {news.map((item) => (
                <div
                  key={item.id}
                  onClick={() => {
                    setSelectedNews(item);
                    setIsAllModalOpen(false);
                  }}
                  className="pt-3 first:pt-0 group cursor-pointer p-3 rounded-xl hover:bg-slate-50 dark:hover:bg-[#141E2E] transition-all"
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className={`px-1.5 py-0.2 rounded text-[9.5px] font-bold border font-mono ${getTagColor(item.tag)}`}>
                        {item.tag}
                      </span>
                      <span className="text-xs font-mono font-bold text-slate-500 dark:text-slate-400">
                        {item.category}
                      </span>
                    </div>
                    <span className="text-[11px] text-slate-400 font-mono">
                      {item.timeAgo}
                    </span>
                  </div>

                  <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100 group-hover:text-emerald-500 transition-colors leading-snug">
                    {item.title}
                  </h4>
                  <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2 mt-1 leading-relaxed">
                    {item.summary}
                  </p>

                  <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                    <span className="flex items-center gap-1 font-semibold">
                      {isEn ? 'Read article' : 'Baca selengkapnya'}
                      <ArrowRight className="w-3 h-3 group-hover:translate-x-1 transition-transform" />
                    </span>
                    <span className="text-slate-400 font-normal">
                      {item.source || 'GAIN News'}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-slate-200 dark:border-[#1E2E44] bg-slate-50 dark:bg-[#111827] flex items-center justify-between">
              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                {news.length} {isEn ? 'articles available' : 'artikel tersedia'}
              </span>
              <button
                onClick={() => setIsAllModalOpen(false)}
                className="px-4 py-1.5 rounded-lg bg-slate-200 dark:bg-[#1E2E44] text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-[#27374D] font-medium text-xs transition"
              >
                {isEn ? 'Close' : 'Tutup'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
