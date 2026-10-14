import { useState } from 'react';
import { X, Filter, Search, RotateCcw, Check } from 'lucide-react';
import { BotMode } from '../../types';

export interface HomeFilterState {
  searchQuery: string;
  category: 'all' | 'layer1' | 'defi' | 'ai' | 'meme' | 'rwa';
  strategyMode: 'all' | BotMode;
  botStatus: 'all' | 'active' | 'in_profit' | 'drawdown' | 'paused';
  performance: 'all' | 'gainers' | 'losers' | 'stable';
}

export const DEFAULT_HOME_FILTER: HomeFilterState = {
  searchQuery: '',
  category: 'all',
  strategyMode: 'all',
  botStatus: 'all',
  performance: 'all',
};

interface HomeFilterModalProps {
  isOpen: boolean;
  onClose: () => void;
  filters: HomeFilterState;
  onApply: (newFilters: HomeFilterState) => void;
}

export function HomeFilterModal({
  isOpen,
  onClose,
  filters,
  onApply,
}: HomeFilterModalProps) {
  const [draft, setDraft] = useState<HomeFilterState>(filters);

  if (!isOpen) return null;

  const handleReset = () => {
    setDraft(DEFAULT_HOME_FILTER);
  };

  const handleApply = () => {
    onApply(draft);
    onClose();
  };

  const activeCount = [
    draft.searchQuery ? 1 : 0,
    draft.category !== 'all' ? 1 : 0,
    draft.strategyMode !== 'all' ? 1 : 0,
    draft.botStatus !== 'all' ? 1 : 0,
    draft.performance !== 'all' ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
      <div className="theme-modal-shell relative w-full max-w-lg bg-[#080E1A] border border-[#162740] rounded-2xl shadow-2xl overflow-hidden text-slate-100 max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-[#162740] flex items-center justify-between bg-[#0C1626]">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <Filter className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white font-sans flex items-center gap-1.5">
                Filter Koin &amp; Strategi Bot
                {activeCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-[#8DC63F] text-slate-950 text-[10px] font-extrabold">
                    {activeCount} Aktif
                  </span>
                )}
              </h3>
              <p className="text-[11px] text-slate-400 font-sans">
                Saring pair koin, mode strategi averaging/grid, dan performa bot
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-[#162740] transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1 scrollbar-thin scrollbar-thumb-slate-700">
          {/* Search Input */}
          <div>
            <label className="text-xs font-bold text-slate-300 font-sans uppercase tracking-wider block mb-1.5">
              Cari Koin / Pair
            </label>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={draft.searchQuery}
                onChange={(e) => setDraft((prev) => ({ ...prev, searchQuery: e.target.value }))}
                placeholder="Contoh: BTC, ETH, SOL, ZEC..."
                className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#0F1C2E] border border-[#1C2C42] text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500"
              />
              {draft.searchQuery && (
                <button
                  type="button"
                  onClick={() => setDraft((prev) => ({ ...prev, searchQuery: '' }))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white text-xs font-bold"
                >
                  &times;
                </button>
              )}
            </div>
          </div>

          {/* Mode Strategi Bot */}
          <div>
            <label className="text-xs font-bold text-slate-300 font-sans uppercase tracking-wider block mb-2">
              Mode Strategi Trading
            </label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'all', label: 'Semua Strategi' },
                { id: 'Avarage Only', label: 'DCA Martingale (Averaging Only)' },
                { id: 'Grid Only', label: 'Grid Strategy (Grid Only)' },
                { id: 'Avarage+Grid', label: 'Hybrid (DCA + Grid)' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDraft((prev) => ({ ...prev, strategyMode: opt.id as any }))}
                  className={`p-2.5 rounded-xl text-xs font-semibold font-sans border transition text-left cursor-pointer ${
                    draft.strategyMode === opt.id
                      ? 'bg-sky-500/20 text-sky-300 border-sky-500 font-bold'
                      : 'bg-[#0F1C2E] border-[#1C2C42] text-slate-300 hover:bg-[#162740]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Kategori Pasar */}
          <div>
            <label className="text-xs font-bold text-slate-300 font-sans uppercase tracking-wider block mb-2">
              Kategori Koin
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'all', label: 'Semua Kategori' },
                { id: 'layer1', label: 'Layer 1 / Mainnet' },
                { id: 'defi', label: 'DeFi & DEX' },
                { id: 'ai', label: 'AI & Data' },
                { id: 'meme', label: 'Meme Coins' },
                { id: 'rwa', label: 'RWA & Gold' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDraft((prev) => ({ ...prev, category: opt.id as any }))}
                  className={`p-2 rounded-xl text-xs font-semibold font-sans border transition text-center cursor-pointer ${
                    draft.category === opt.id
                      ? 'bg-[#8DC63F]/20 text-[#8DC63F] border-[#8DC63F] font-bold'
                      : 'bg-[#0F1C2E] border-[#1C2C42] text-slate-300 hover:bg-[#162740]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Status Bot */}
          <div>
            <label className="text-xs font-bold text-slate-300 font-sans uppercase tracking-wider block mb-2">
              Status Bot Positions
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { id: 'all', label: 'Semua Status' },
                { id: 'active', label: 'Bot Running' },
                { id: 'in_profit', label: 'Dalam Profit' },
                { id: 'drawdown', label: 'Drawdown' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDraft((prev) => ({ ...prev, botStatus: opt.id as any }))}
                  className={`p-2 rounded-xl text-xs font-semibold font-sans border transition text-center cursor-pointer ${
                    draft.botStatus === opt.id
                      ? 'bg-amber-500/20 text-amber-300 border-amber-500 font-bold'
                      : 'bg-[#0F1C2E] border-[#1C2C42] text-slate-300 hover:bg-[#162740]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Performa 24h */}
          <div>
            <label className="text-xs font-bold text-slate-300 font-sans uppercase tracking-wider block mb-2">
              Performa Harga 24 Jam
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'all', label: 'Semua' },
                { id: 'gainers', label: '🚀 Top Gainers' },
                { id: 'losers', label: '🔻 Dip / Crash' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDraft((prev) => ({ ...prev, performance: opt.id as any }))}
                  className={`p-2 rounded-xl text-xs font-semibold font-sans border transition text-center cursor-pointer ${
                    draft.performance === opt.id
                      ? 'bg-purple-500/20 text-purple-300 border-purple-500 font-bold'
                      : 'bg-[#0F1C2E] border-[#1C2C42] text-slate-300 hover:bg-[#162740]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[#162740] bg-[#0C1626] flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleReset}
            className="px-3 py-2 rounded-xl bg-[#162740] hover:bg-[#1C3050] text-slate-300 hover:text-white text-xs font-sans font-semibold transition flex items-center gap-1.5 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Filter
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-sans font-semibold transition cursor-pointer"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-sans font-bold transition flex items-center gap-1.5 cursor-pointer shadow-md"
            >
              <Check className="w-4 h-4 stroke-[3]" />
              Terapkan Filter
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
