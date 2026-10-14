import { useLanguage } from '../../context/LanguageContext';
import { useEffect, useState } from 'react';
import { X, RefreshCw, ShieldCheck, WalletCards, Sparkles, PieChart } from 'lucide-react';
import { getProfitShare } from '../../api/walletApi';

interface ProfitShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenGasModal?: () => void;
}

const money = (v: number) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(6)} USDT`;

export function ProfitShareModal({ isOpen, onClose, onOpenGasModal }: ProfitShareModalProps) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<any>(null);

  const load = async () => {
    setLoading(true); setError('');
    try { setData(await getProfitShare()); }
    catch (err: any) { setError(err?.message || t('dataUnavailable')); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (isOpen) void load(); }, [isOpen]);
  if (!isOpen) return null;

  const s = data?.summary || {};
  const c = data?.config || {
    traderNetProfitPct: 80,
    platformProfitSharePct: 20,
    managementShareOfPlatformPct: 80,
    uplineCashShareOfPlatformPct: 20,
    activationCashPct: 20,
    tradingFeeCashPct: 20,
    topupGasNonCashPct: 10,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
      <div className="w-full max-w-lg rounded-2xl border border-[#1A2D4A] bg-[#080E1A] text-slate-100 shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[#14233A] flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-emerald-400" />
              <span>Transparansi Bagi Hasil 80:20 & Gas Pool</span>
            </h3>
            <p className="text-[11px] text-slate-400">
              80% Net Trader • 20% Platform (80% Manajemen : 20% Referral Upline Cash)
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-[#0F1A2D] flex items-center justify-center hover:bg-[#162740] transition">
            <X className="w-4 h-4"/>
          </button>
        </div>
        <div className="p-5 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <RefreshCw className="w-4 h-4 animate-spin"/>
              {t('loadingSettlement')}
            </div>
          )}
          {error && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {error}
            </div>
          )}

          {/* Model Breakdown Diagram Banner */}
          <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 space-y-2 text-xs font-mono">
            <div className="flex items-center justify-between font-bold text-emerald-400">
              <span className="flex items-center gap-1.5">
                <PieChart className="w-4 h-4 text-emerald-400" />
                <span>Pembagian Profit Trading (Gross Profit)</span>
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] pt-1">
              <div className="p-2 rounded-lg bg-[#0B1527] border border-emerald-500/20">
                <span className="text-slate-400 block text-[10px]">Net Trader (Dipotong ke Vault)</span>
                <span className="text-emerald-400 font-bold text-sm">80% Total Profit</span>
              </div>
              <div className="p-2 rounded-lg bg-[#0B1527] border border-amber-500/20">
                <span className="text-slate-400 block text-[10px]">Platform Fee (Dipotong dari Gas)</span>
                <span className="text-amber-400 font-bold text-sm">20% Total Profit</span>
              </div>
            </div>
            <div className="p-2 rounded-lg bg-[#0A1220] border border-[#182A45] text-[10px] text-slate-300 space-y-1">
              <div className="font-semibold text-slate-200">Alokasi Platform Fee 20%:</div>
              <div className="flex justify-between text-slate-400">
                <span>• Manajemen Pool Platform (80% dari Platform Fee):</span>
                <span className="text-emerald-400 font-bold">16% Gross Profit</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>• Referral Upline Cash (20% dari Platform Fee):</span>
                <span className="text-emerald-400 font-bold">4% Gross Profit</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-xl bg-[#0B1527] border border-[#162740]">
              <div className="text-[10px] text-slate-400">Activation Cash ({c.activationCashPct}%)</div>
              <div className="text-lg font-bold text-emerald-400">{money(Number(s.activationCashUsdt || 0))}</div>
            </div>
            <div className="p-3 rounded-xl bg-[#0B1527] border border-[#162740]">
              <div className="text-[10px] text-slate-400">Trading Profit Cash ({c.tradingFeeCashPct}%)</div>
              <div className="text-lg font-bold text-emerald-400">{money(Number(s.tradingFeeCashUsdt || 0))}</div>
            </div>
            <div className="p-3 rounded-xl bg-[#0B1527] border border-[#162740]">
              <div className="text-[10px] text-slate-400">Top-Up Non-Cash ({c.topupGasNonCashPct}%)</div>
              <div className="text-lg font-bold text-amber-400">{money(Number(s.topupNonCashUsdt || 0))}</div>
            </div>
            <div className="p-3 rounded-xl bg-[#0B1527] border border-[#162740]">
              <div className="text-[10px] text-slate-400">Total Cashable</div>
              <div className="text-lg font-bold text-white">{money(Number(s.totalCashUsdt || 0))}</div>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 text-xs text-slate-300 flex gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5"/>
            <span>Cash reward hanya berasal dari event profit sharing & referral yang sudah settled di PostgreSQL. UI tidak menghitung saldo sendiri.</span>
          </div>

          <div className="flex gap-2">
            <button onClick={() => void load()} disabled={loading} className="flex-1 py-2.5 rounded-xl border border-[#263956] text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#111F35] transition">
              <RefreshCw className="w-4 h-4"/>{t('refresh')}
            </button>
            {onOpenGasModal && (
              <button onClick={onOpenGasModal} className="flex-1 py-2.5 rounded-xl bg-emerald-500 text-slate-950 text-xs font-black flex items-center justify-center gap-2 hover:bg-emerald-400 transition">
                <WalletCards className="w-4 h-4"/>{t('gasTank')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

