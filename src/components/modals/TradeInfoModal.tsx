import React from 'react';
import { X, Info, Sliders, ShieldCheck, Activity, TrendingUp, DollarSign } from 'lucide-react';
import { TradingPosition } from '../../types';
import { CoinLogo } from '../common/CoinLogo';
import { getBotModeLabel, normalizeBotMode } from '../../utils/botModeLabels';

interface TradeInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  position: TradingPosition | null;
  onOpenSettings?: ((position: any) => void) | ((pair: string) => void);
}

export function TradeInfoModal({
  isOpen,
  onClose,
  position,
  onOpenSettings,
}: TradeInfoModalProps) {
  if (!isOpen || !position) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/75 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-lg bg-white dark:bg-[#0C1322] border border-slate-200 dark:border-slate-800 rounded-3xl overflow-hidden shadow-2xl text-slate-900 dark:text-slate-100">
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800/80 flex items-center justify-between bg-slate-50 dark:bg-[#080E1A]">
          <div className="flex items-center gap-3">
            <CoinLogo coin={position.coin} size="md" />
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white font-mono">{position.pair} Info</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-sans">
                Algorithmic Execution Parameters
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

        <div className="p-5 space-y-4 text-xs font-mono bg-slate-50/50 dark:bg-[#09101C]">
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-xl bg-white dark:bg-[#111A29] border border-slate-200 dark:border-slate-800 shadow-2xs">
              <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase block font-medium">Bot Engine</span>
              <span className="font-bold text-slate-900 dark:text-white text-sm block mt-0.5">{position.engine || 'GAIN Martingale Matrix'}</span>
            </div>
            <div className="p-3 rounded-xl bg-white dark:bg-[#111A29] border border-slate-200 dark:border-slate-800 shadow-2xs">
              <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase block font-medium">Mode</span>
              <span className="font-bold text-amber-600 dark:text-amber-400 text-sm block mt-0.5">{getBotModeLabel(normalizeBotMode(position.botMode), 'id')}</span>
            </div>
            <div className="p-3 rounded-xl bg-white dark:bg-[#111A29] border border-slate-200 dark:border-slate-800 shadow-2xs">
              <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase block font-medium">Alokasi Total</span>
              <span className="font-bold text-slate-900 dark:text-white text-sm block mt-0.5">{position.allocationUsdt || '$0.00'}</span>
            </div>
            <div className="p-3 rounded-xl bg-white dark:bg-[#111A29] border border-slate-200 dark:border-slate-800 shadow-2xs">
              <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase block font-medium">Max Layer</span>
              <span className="font-bold text-slate-900 dark:text-white text-sm block mt-0.5">{position.maxStep || 100} Layers</span>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-white dark:bg-[#0E1726] border border-slate-200 dark:border-slate-800 space-y-2 shadow-2xs">
            <div className="flex justify-between items-center text-slate-500 dark:text-slate-400">
              <span>Trailing Profit:</span>
              <span className="text-slate-900 dark:text-white font-semibold">{position.trailingInfo || '0.3% Dynamic'}</span>
            </div>
            <div className="flex justify-between items-center text-slate-500 dark:text-slate-400">
              <span>Layer Quota:</span>
              <span className="text-slate-900 dark:text-white font-semibold">{position.layerQuota || '100%'}</span>
            </div>
            <div className="flex justify-between items-center text-slate-500 dark:text-slate-400">
              <span>Status Matrix:</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{position.statusLabel || position.status}</span>
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#080E1A] flex items-center justify-end gap-2">
          {onOpenSettings && (
            <button
              onClick={() => {
                (onOpenSettings as any)(position.pair || position);
                onClose();
              }}
              className="px-4 py-2 rounded-xl text-xs font-bold font-mono bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/30 transition flex items-center gap-1.5 cursor-pointer active:scale-95"
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Buka Konfigurasi Matrix</span>
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
  );
}
