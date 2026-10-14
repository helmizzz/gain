import { useState } from 'react';
import { X, Sliders, Check, RotateCcw, Eye, EyeOff, LayoutGrid, Sparkles } from 'lucide-react';
import { SUPPORTED_COINS } from '../../data/appData';

export interface DashboardCustomization {
  showHighlights: boolean;
  showDualVault: boolean;
  showPortfolio: boolean;
  showPieChart: boolean;
  showActivePositions: boolean;
  showEcosystem: boolean;
  defaultPill: 'semua' | 'highlights' | 'spot-vault' | 'gas-tank' | 'dca-martingale' | 'grid-strategy';
  defaultPair: string;
}

export const DEFAULT_DASHBOARD_CUSTOMIZATION: DashboardCustomization = {
  showHighlights: true,
  showDualVault: true,
  showPortfolio: true,
  showPieChart: true,
  showActivePositions: true,
  showEcosystem: true,
  defaultPill: 'semua',
  defaultPair: 'BTC/USDT',
};

interface CustomizeHomeModalProps {
  isOpen: boolean;
  onClose: () => void;
  customization: DashboardCustomization;
  onSave: (newSettings: DashboardCustomization) => void;
}

export function CustomizeHomeModal({
  isOpen,
  onClose,
  customization,
  onSave,
}: CustomizeHomeModalProps) {
  const [settings, setSettings] = useState<DashboardCustomization>(customization);

  if (!isOpen) return null;

  const handleToggle = (key: keyof DashboardCustomization) => {
    setSettings((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleReset = () => {
    setSettings(DEFAULT_DASHBOARD_CUSTOMIZATION);
  };

  const handleSave = () => {
    onSave(settings);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
      <div className="theme-modal-shell relative w-full max-w-lg bg-[#080E1A] border border-[#162740] rounded-2xl shadow-2xl overflow-hidden text-slate-100 max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-[#162740] flex items-center justify-between bg-[#0C1626]">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#8DC63F]/15 border border-[#8DC63F]/30 flex items-center justify-center text-[#8DC63F]">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white font-sans flex items-center gap-1.5">
                Customize Home Dashboard
                <Sparkles className="w-3.5 h-3.5 text-[#8DC63F]" />
              </h3>
              <p className="text-[11px] text-slate-400 font-sans">
                Atur tampilan widget, urutan informasi, dan preferensi beranda Anda
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
          {/* Section 1: Toggle Widget Visibilities */}
          <div>
            <label className="text-xs font-bold text-slate-300 font-sans uppercase tracking-wider block mb-2.5">
              Widget & Modul Beranda
            </label>
            <div className="space-y-2">
              <div
                onClick={() => handleToggle('showHighlights')}
                className="p-3 rounded-xl bg-[#0F1C2E] border border-[#1C2C42] hover:border-slate-600 flex items-center justify-between cursor-pointer transition select-none"
              >
                <div className="flex items-center gap-2.5">
                  <div className={`p-1.5 rounded-lg ${settings.showHighlights ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                    {settings.showHighlights ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </div>
                  <div>
                    <span className="text-xs font-bold text-slate-200 block font-sans">Market Highlights & Sparkline</span>
                    <span className="text-[10.5px] text-slate-400 block font-sans">Card Market Cap, 24h Volume, Trending & Top Gainers</span>
                  </div>
                </div>
                <div className={`w-5 h-5 rounded-md flex items-center justify-center border ${settings.showHighlights ? 'bg-[#8DC63F] border-[#8DC63F] text-slate-950' : 'border-slate-600 bg-slate-800'}`}>
                  {settings.showHighlights && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                </div>
              </div>

              <div
                onClick={() => handleToggle('showDualVault')}
                className="p-3 rounded-xl bg-[#0F1C2E] border border-[#1C2C42] hover:border-slate-600 flex items-center justify-between cursor-pointer transition select-none"
              >
                <div className="flex items-center gap-2.5">
                  <div className={`p-1.5 rounded-lg ${settings.showDualVault ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                    {settings.showDualVault ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </div>
                  <div>
                    <span className="text-xs font-bold text-slate-200 block font-sans">Dual-Vault Architecture Card</span>
                    <span className="text-[10.5px] text-slate-400 block font-sans">Spot Vault Exchange & Gas Tank GAIN Wallet</span>
                  </div>
                </div>
                <div className={`w-5 h-5 rounded-md flex items-center justify-center border ${settings.showDualVault ? 'bg-[#8DC63F] border-[#8DC63F] text-slate-950' : 'border-slate-600 bg-slate-800'}`}>
                  {settings.showDualVault && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                </div>
              </div>

              <div
                onClick={() => handleToggle('showPortfolio')}
                className="p-3 rounded-xl bg-[#0F1C2E] border border-[#1C2C42] hover:border-slate-600 flex items-center justify-between cursor-pointer transition select-none"
              >
                <div className="flex items-center gap-2.5">
                  <div className={`p-1.5 rounded-lg ${settings.showPortfolio ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                    {settings.showPortfolio ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </div>
                  <div>
                    <span className="text-xs font-bold text-slate-200 block font-sans">Ringkasan Portfolio & Asset</span>
                    <span className="text-[10.5px] text-slate-400 block font-sans">Saldo USDT, alokasi aset koin, dan volume 24h</span>
                  </div>
                </div>
                <div className={`w-5 h-5 rounded-md flex items-center justify-center border ${settings.showPortfolio ? 'bg-[#8DC63F] border-[#8DC63F] text-slate-950' : 'border-slate-600 bg-slate-800'}`}>
                  {settings.showPortfolio && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                </div>
              </div>

              <div
                onClick={() => handleToggle('showPieChart')}
                className="p-3 rounded-xl bg-[#0F1C2E] border border-[#1C2C42] hover:border-slate-600 flex items-center justify-between cursor-pointer transition select-none"
              >
                <div className="flex items-center gap-2.5">
                  <div className={`p-1.5 rounded-lg ${settings.showPieChart ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                    {settings.showPieChart ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </div>
                  <div>
                    <span className="text-xs font-bold text-slate-200 block font-sans">Bagan Pie Distribusi Komposisi Koin</span>
                    <span className="text-[10.5px] text-slate-400 block font-sans">Visualisasi persentase &amp; nilai alokasi koin di exchange</span>
                  </div>
                </div>
                <div className={`w-5 h-5 rounded-md flex items-center justify-center border ${settings.showPieChart ? 'bg-[#8DC63F] border-[#8DC63F] text-slate-950' : 'border-slate-600 bg-slate-800'}`}>
                  {settings.showPieChart && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                </div>
              </div>

              <div
                onClick={() => handleToggle('showActivePositions')}
                className="p-3 rounded-xl bg-[#0F1C2E] border border-[#1C2C42] hover:border-slate-600 flex items-center justify-between cursor-pointer transition select-none"
              >
                <div className="flex items-center gap-2.5">
                  <div className={`p-1.5 rounded-lg ${settings.showActivePositions ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                    {settings.showActivePositions ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </div>
                  <div>
                    <span className="text-xs font-bold text-slate-200 block font-sans">Posisi Bot Aktif (Top 3)</span>
                    <span className="text-[10.5px] text-slate-400 block font-sans">Daftar running bot, floating PnL, layer step &amp; floating</span>
                  </div>
                </div>
                <div className={`w-5 h-5 rounded-md flex items-center justify-center border ${settings.showActivePositions ? 'bg-[#8DC63F] border-[#8DC63F] text-slate-950' : 'border-slate-600 bg-slate-800'}`}>
                  {settings.showActivePositions && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                </div>
              </div>

              <div
                onClick={() => handleToggle('showEcosystem')}
                className="p-3 rounded-xl bg-[#0F1C2E] border border-[#1C2C42] hover:border-slate-600 flex items-center justify-between cursor-pointer transition select-none"
              >
                <div className="flex items-center gap-2.5">
                  <div className={`p-1.5 rounded-lg ${settings.showEcosystem ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                    {settings.showEcosystem ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </div>
                  <div>
                    <span className="text-xs font-bold text-slate-200 block font-sans">Fitur &amp; Ekosistem GAIN</span>
                    <span className="text-[10.5px] text-slate-400 block font-sans">Akses cepat Matrix Setting &amp; Referral Network</span>
                  </div>
                </div>
                <div className={`w-5 h-5 rounded-md flex items-center justify-center border ${settings.showEcosystem ? 'bg-[#8DC63F] border-[#8DC63F] text-slate-950' : 'border-slate-600 bg-slate-800'}`}>
                  {settings.showEcosystem && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Default Pill Tab Selection */}
          <div className="pt-2 border-t border-[#162740]">
            <label className="text-xs font-bold text-slate-300 font-sans uppercase tracking-wider block mb-2">
              Tab Filter Default Saat Aplikasi Dibuka
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {[
                { id: 'semua', label: 'Semua' },
                { id: 'highlights', label: 'Highlights' },
                { id: 'spot-vault', label: 'Spot Vault' },
                { id: 'gas-tank', label: 'Gas Tank' },
                { id: 'dca-martingale', label: 'DCA Martingale' },
                { id: 'grid-strategy', label: 'Grid Strategy' },
              ].map((pill) => (
                <button
                  key={pill.id}
                  type="button"
                  onClick={() => setSettings((prev) => ({ ...prev, defaultPill: pill.id as any }))}
                  className={`p-2 rounded-xl text-xs font-semibold font-sans border transition text-center cursor-pointer ${
                    settings.defaultPill === pill.id
                      ? 'bg-[#8DC63F] text-slate-950 border-[#8DC63F] font-bold shadow-sm'
                      : 'bg-[#0F1C2E] border-[#1C2C42] text-slate-300 hover:bg-[#162740]'
                  }`}
                >
                  {pill.label}
                </button>
              ))}
            </div>
          </div>

          {/* Section 3: Default Pair Selection */}
          <div className="pt-2 border-t border-[#162740]">
            <label className="text-xs font-bold text-slate-300 font-sans uppercase tracking-wider block mb-2">
              Pair Koin Default untuk Bot Matrix
            </label>
            <select
              value={settings.defaultPair}
              onChange={(e) => setSettings((prev) => ({ ...prev, defaultPair: e.target.value }))}
              className="w-full p-2.5 rounded-xl bg-[#0F1C2E] border border-[#1C2C42] text-xs font-mono font-semibold text-slate-200 focus:outline-none focus:border-[#8DC63F]"
            >
              {SUPPORTED_COINS.map((c) => (
                <option key={c.pair} value={c.pair}>
                  {c.pair} ({c.name})
                </option>
              ))}
            </select>
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
            Reset Default
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
              onClick={handleSave}
              className="px-4 py-2 rounded-xl bg-[#8DC63F] hover:bg-[#7ab232] text-slate-950 text-xs font-sans font-bold transition flex items-center gap-1.5 cursor-pointer shadow-md"
            >
              <Check className="w-4 h-4 stroke-[3]" />
              Simpan Pengaturan
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
