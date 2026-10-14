import { useEffect, useState } from 'react';
import { X, Fuel, ShieldCheck, CheckCircle2, AlertTriangle, Sparkles } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { formatUsdt } from '../../utils/formatters';
import { getGasTopupBonus, FINANCIAL_CONFIG } from '../../config/financialConfig';
import { addGasReserve, getGasAutoRefill, setGasAutoRefill } from '../../services/walletService';

interface GasFeeModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableBalance: number;
  currentGasReserve: number;
  userSecret?: string;
  memberId?: string;
  onTopUpSuccess: (amount: number, bonusAmount?: number, isDemoRefill?: boolean) => void;
  onOpenProfitShare?: () => void;
  isDemoOrTestnet?: boolean;
}

export function calculateMemberTopupBonus(topupUsdt: number): { pct: number; bonus: number; tierLabel: string } {
  const result = getGasTopupBonus(topupUsdt);
  const tierLabel = result.pct > 0 ? `$${result.pct === 35 ? '500+' : result.pct === 25 ? '300 - 499' : result.pct === 20 ? '150 - 299' : '50 - 149'} (+${result.pct}% Bonus)` : '< $50 (0% Bonus)';
  return { pct: result.pct, bonus: result.bonusUsdt, tierLabel };
}

export function GasFeeModal({
  isOpen,
  onClose,
  availableBalance,
  currentGasReserve,
  userSecret,
  memberId,
  onTopUpSuccess,
  onOpenProfitShare,
  isDemoOrTestnet = false,
}: GasFeeModalProps) {
  const { t } = useLanguage();
  const [amount, setAmount] = useState('50');
  const [autoRefill, setAutoRefill] = useState(false);
  const [autoRefillSaving, setAutoRefillSaving] = useState(false);
  const [otp2fa, setOtp2fa] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const numAmount = parseFloat(amount) || 0;
  const { pct: bonusPct, bonus: bonusUsdt, tierLabel } = calculateMemberTopupBonus(numAmount);
  const totalGasReceived = numAmount + bonusUsdt;
  const newGasTotal = currentGasReserve + totalGasReceived;

  // Gas Health Status Calculation (Based on FINANCIAL_CONFIG rules)
  const isCritical = currentGasReserve <= FINANCIAL_CONFIG.gasTankRules.criticalPauseUsdt;
  const isWarning = currentGasReserve > FINANCIAL_CONFIG.gasTankRules.criticalPauseUsdt && currentGasReserve <= FINANCIAL_CONFIG.gasTankRules.minUsdt;
  const gasStatusText = isCritical
    ? t('criticalZone')
    : isWarning
    ? t('warningZone')
    : t('safeZone');
  const gasStatusBadge = isCritical
    ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
    : isWarning
    ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
    : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
  const healthPercent = Math.min(100, Math.max(5, (currentGasReserve / 25) * 100));

  useEffect(() => {
    if (!isOpen || isDemoOrTestnet) return;
    void getGasAutoRefill().then((response) => setAutoRefill(Boolean(response?.config?.enabled))).catch(() => setAutoRefill(false));
  }, [isOpen, isDemoOrTestnet]);

  const handleAutoRefillToggle = async () => {
    const next = !autoRefill;
    setAutoRefillSaving(true);
    try {
      await setGasAutoRefill({
        enabled: next,
        thresholdUsdt: FINANCIAL_CONFIG.autoRefill.thresholdUsdt,
        refillUsdt: FINANCIAL_CONFIG.autoRefill.refillUsdt,
        maxDailyUsdt: FINANCIAL_CONFIG.autoRefill.maxDailyUsdt,
      });
      setAutoRefill(next);
    } catch (error: any) {
      setErrorMsg(error?.message || 'Konfigurasi Auto-Refill gagal disimpan.');
    } finally { setAutoRefillSaving(false); }
  };

  if (!isOpen) return null;

  const handleSetExactAmount = (val: number) => {
    setAmount(val.toString());
  };

  const handleAddAmount = (addVal: number) => {
    setAmount((prev) => {
      const current = parseFloat(prev) || 0;
      return (current + addVal).toString();
    });
  };

  const handleInstantDemoRefill = (refillAmount: number = 100) => {
    setIsProcessing(true);
    setTimeout(() => {
      setIsProcessing(false);
      setIsSuccess(true);
      onTopUpSuccess(refillAmount, 0, true);
      setTimeout(() => {
        setIsSuccess(false);
        onClose();
      }, 1000);
    }, 300);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (numAmount < 10) {
      setErrorMsg('Minimal alokasi gas pool adalah 10 USDT.');
      return;
    }

    if (isDemoOrTestnet) {
      // In Demo/Testnet mode, bypass balance check and 2FA requirement
      setIsProcessing(true);
      setTimeout(() => {
        setIsProcessing(false);
        setIsSuccess(true);
        onTopUpSuccess(numAmount, bonusUsdt, true);
        setTimeout(() => {
          setIsSuccess(false);
          onClose();
        }, 1200);
      }, 400);
      return;
    }

    if (numAmount > availableBalance) {
      setErrorMsg('Saldo vault tidak mencukupi untuk alokasi gas pool.');
      return;
    }

    if (otp2fa.length < 6) {
      setErrorMsg('Wajib masukkan 6 digit kode Google Authenticator 2FA.');
      return;
    }

    setIsProcessing(true);
    const idempotencyKey = `gas-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const data = await addGasReserve({
          amount: numAmount,
          bonusAmount: bonusUsdt,
          memberId,
          otp2fa: otp2fa.trim(),
          userSecret,
          idempotencyKey,
      });

      if (data.success) {
        setIsProcessing(false);
        setIsSuccess(true);
        onTopUpSuccess(numAmount, bonusUsdt, false);
        setTimeout(() => {
          setIsSuccess(false);
          onClose();
        }, 1400);
      } else {
        setIsProcessing(false);
        setErrorMsg(data.error || 'Gagal memproses top-up gas.');
      }
    } catch (err: any) {
      setIsProcessing(false);
      setErrorMsg(err?.message || 'Gagal menghubungi server GAIN.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 dark:bg-slate-950/80 backdrop-blur-md animate-fadeIn">
      <div className="theme-modal-shell relative w-full max-w-lg bg-white dark:bg-[#080E1A] border border-slate-200 dark:border-[#162740] rounded-2xl shadow-2xl overflow-hidden text-slate-900 dark:text-slate-100 max-h-[92vh] flex flex-col">
        {/* Top Hardware Notch */}
        <div className="w-full flex justify-center pt-2 pb-1 bg-slate-100 dark:bg-[#060B14]">
          <div className="w-16 h-1 rounded-full bg-slate-300 dark:bg-[#18263B]"></div>
        </div>

        {/* Modal Header */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-[#14233A] flex items-center justify-between">
          <div>
            <h3 className="font-extrabold text-base text-slate-900 dark:text-white tracking-wide flex items-center gap-2">
              <Fuel className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              <span>Top-Up Gas Fee Pool</span>
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
              20% Profit-Share Reserve & Execution Fuel
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-[#0F1A2D] border border-slate-200 dark:border-[#1A2D4A] flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto custom-scrollbar flex-1">
          {/* Instant Demo / Testnet Gas Refill Card */}
          {isDemoOrTestnet && (
            <div className="p-3.5 rounded-xl bg-gradient-to-r from-amber-50 dark:from-amber-500/20 via-yellow-50 dark:via-yellow-500/15 to-orange-50 dark:to-orange-500/20 border border-amber-300 dark:border-amber-500/40 space-y-2 animate-fadeIn">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-amber-700 dark:text-amber-400 font-mono flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  <span>MODE DEMO / TESTNET AKTIF</span>
                </span>
                <span className="text-[9px] font-mono font-bold px-2 py-0.5 rounded bg-amber-200 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-400 dark:border-amber-500/40">
                  GRATIS / TANPA 2FA
                </span>
              </div>
              <p className="text-[11px] text-slate-700 dark:text-slate-300 font-sans leading-relaxed font-medium">
                Anda menggunakan Mode Demo/Testnet. Anda dapat mengklik tombol di bawah untuk mengisi Gas Fee Tank secara <strong>instant dan gratis</strong> tanpa memotong saldo vault atau membutuhkan verifikasi 2FA.
              </p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => handleInstantDemoRefill(100)}
                  disabled={isProcessing}
                  className="flex-1 py-2 px-3 rounded-lg bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-slate-950 font-bold text-xs font-mono transition flex items-center justify-center gap-1.5 shadow-md cursor-pointer disabled:opacity-50"
                >
                  <Fuel className="w-4 h-4" />
                  <span>⚡ Isi Gas Fee Demo (+100 USDT Gratis)</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleInstantDemoRefill(500)}
                  disabled={isProcessing}
                  className="py-2 px-3 rounded-lg bg-amber-100 dark:bg-amber-500/20 hover:bg-amber-200 dark:hover:bg-amber-500/30 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-500/40 font-bold text-xs font-mono transition cursor-pointer disabled:opacity-50"
                >
                  +500 USDT
                </button>
              </div>
            </div>
          )}

          {/* Current Gas Tank & Health Bar */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0B1527] border border-slate-200 dark:border-[#162740] space-y-2.5">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-mono font-bold">Current Gas Tank</span>
                <div className="text-xl font-black font-mono text-emerald-600 dark:text-[#8DC63F]">
                  +{formatUsdt(currentGasReserve)} <span className="text-xs text-slate-500 dark:text-slate-400">USDT</span>
                </div>
              </div>
              <div className="text-right">
                <span className={`px-2 py-0.5 rounded text-[10px] font-mono border font-semibold ${
                    isCritical
                      ? 'bg-rose-100 dark:bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-300 dark:border-rose-500/30'
                      : isWarning
                      ? 'bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-500/30'
                      : 'bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-500/20'
                  }`}>
                  {gasStatusText}
                </span>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 font-mono mt-1 font-medium">
                  {isCritical ? '24h Grace Period Aktif' : isWarning ? 'Bot Berjalan Normal' : 'Semua Bot Normal'}
                </p>
              </div>
            </div>

            {/* Health Bar */}
            <div className="w-full h-2 rounded-full bg-slate-200 dark:bg-[#070D17] overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  isCritical
                    ? 'bg-rose-500'
                    : isWarning
                    ? 'bg-amber-400'
                    : 'bg-emerald-500 dark:bg-[#8DC63F]'
                }`}
                style={{ width: `${healthPercent}%` }}
              ></div>
            </div>

            {/* Critical Alert Warning */}
            {isCritical && (
              <div className="p-2 rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-[11px] font-mono flex items-start gap-1.5 font-medium">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                <span>
                  Gas ≤ 5 USDT: Bot dilarang membuka layer averaging baru. Segera top-up agar siklus averaging berjalan tanpa hambatan.
                </span>
              </div>
            )}

            {isWarning && (
              <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-300 text-[11px] font-mono flex items-start gap-1.5 font-medium">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <span>
                  Gas ≤ 10 USDT: Peringatan saldo gas menipis. Bot tetap berjalan normal, disarankan melakukan top-up.
                </span>
              </div>
            )}

            <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400 font-mono pt-1 font-medium">
              <span>Vault Tersedia: {formatUsdt(availableBalance)} USDT</span>
              {onOpenProfitShare && (
                <button
                  type="button"
                  onClick={onOpenProfitShare}
                  className="text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 font-bold hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Transparansi Bagi Hasil 80:20 (No Fixed ROI) →</span>
                </button>
              )}
            </div>
          </div>

          {/* Program Promo Member Tiered Bonus Banner */}
          <div className="p-3.5 rounded-xl bg-gradient-to-r from-emerald-50 dark:from-emerald-500/15 via-emerald-100/50 dark:via-[#8DC63F]/10 to-emerald-50 dark:to-emerald-500/15 border border-emerald-200 dark:border-emerald-500/35 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-1">
              <span className="text-xs font-black text-emerald-800 dark:text-emerald-400 font-mono flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                <span>Program Promo & Bonus hingga 90%</span>
              </span>
              <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-200 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-400 dark:border-emerald-500/40">
                MEMBER: BONUS HINGGA +35% NON-CASH
              </span>
            </div>
            <p className="text-[10px] text-slate-700 dark:text-slate-300 font-sans leading-relaxed font-medium">
              Bonus ekstra saldo Gas Tank otomatis (Non-Cash) sesuai nominal top-up fee trading Anda:
            </p>
            <div className="grid grid-cols-4 gap-1.5 text-center text-xs font-mono">
              <div
                onClick={() => handleSetExactAmount(50)}
                className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
                  numAmount >= 50 && numAmount < 150
                    ? 'bg-emerald-100 dark:bg-emerald-500/20 border-emerald-400 ring-1 ring-emerald-400/50'
                    : 'bg-white dark:bg-[#081220] border-slate-200 dark:border-[#15253C] hover:border-slate-400 dark:hover:border-slate-500'
                }`}
              >
                <span className="text-[8.5px] text-slate-500 dark:text-slate-400 block font-bold">$50 - $149</span>
                <span className="text-emerald-700 dark:text-emerald-400 font-black text-[11px] block mt-0.5">+10%</span>
              </div>
              <div
                onClick={() => handleSetExactAmount(150)}
                className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
                  numAmount >= 150 && numAmount < 300
                    ? 'bg-emerald-100 dark:bg-emerald-500/20 border-emerald-400 ring-1 ring-emerald-400/50'
                    : 'bg-white dark:bg-[#081220] border-slate-200 dark:border-[#15253C] hover:border-slate-400 dark:hover:border-slate-500'
                }`}
              >
                <span className="text-[8.5px] text-slate-500 dark:text-slate-400 block font-bold">$150 - $299</span>
                <span className="text-emerald-700 dark:text-emerald-400 font-black text-[11px] block mt-0.5">+20%</span>
              </div>
              <div
                onClick={() => handleSetExactAmount(300)}
                className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
                  numAmount >= 300 && numAmount < 500
                    ? 'bg-emerald-100 dark:bg-emerald-500/20 border-emerald-400 ring-1 ring-emerald-400/50'
                    : 'bg-white dark:bg-[#081220] border-slate-200 dark:border-[#15253C] hover:border-slate-400 dark:hover:border-slate-500'
                }`}
              >
                <span className="text-[8.5px] text-slate-500 dark:text-slate-400 block font-bold">$300 - $499</span>
                <span className="text-emerald-700 dark:text-emerald-400 font-black text-[11px] block mt-0.5">+25%</span>
              </div>
              <div
                onClick={() => handleSetExactAmount(500)}
                className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
                  numAmount >= 500
                    ? 'bg-emerald-100 dark:bg-emerald-500/20 border-emerald-400 ring-1 ring-emerald-400/50'
                    : 'bg-white dark:bg-[#081220] border-slate-200 dark:border-[#15253C] hover:border-slate-400 dark:hover:border-slate-500'
                }`}
              >
                <span className="text-[8.5px] text-slate-500 dark:text-slate-400 block font-bold">$500+</span>
                <span className="text-emerald-700 dark:text-emerald-400 font-black text-[11px] block mt-0.5">+35%</span>
              </div>
            </div>
          </div>


          {/* Auto-Refill Guard Toggle */}
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#070D17] border border-slate-200 dark:border-[#14233A] flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-black text-slate-900 dark:text-white">
                <Sparkles className="w-3.5 h-3.5 text-emerald-600 dark:text-[#8DC63F]" />
                <span>Auto-Refill Threshold Protection</span>
              </div>
              <p className="text-[11px] text-slate-600 dark:text-slate-400 font-mono mt-0.5 font-medium">
                Isi otomatis 10 USDT dari vault jika gas pool &lt; 3 USDT untuk mencegah bot terhenti
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleAutoRefillToggle()} disabled={autoRefillSaving || isDemoOrTestnet}
              className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer border ${
                autoRefill ? 'bg-emerald-500 dark:bg-[#8DC63F] border-transparent' : 'bg-slate-300 dark:bg-[#162740] border-transparent'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white dark:bg-slate-950 transition-transform ${
                  autoRefill ? 'translate-x-5' : 'translate-x-0'
                } shadow-sm`}
              ></span>
            </button>
          </div>

          {/* Referral Gas Bonus Policy Info */}
          <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-[#071322] border border-amber-300 dark:border-amber-500/25 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-black text-amber-800 dark:text-[#F0B90B] font-mono flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                <span>Bonus Referral 10% Top-Up Fee Trading</span>
              </span>
              <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-amber-200 dark:bg-amber-500/15 text-amber-800 dark:text-amber-400 border border-amber-400 dark:border-amber-500/30">
                10% NON-CASH / OTOMATIS
              </span>
            </div>
            <p className="text-[11px] text-slate-700 dark:text-slate-300 font-sans leading-relaxed font-medium">
              Setiap kali downline Anda melakukan top-up untuk mengisi Fee Trading, Anda sebagai upline/referral mendapatkan <strong>10% Non-Cash</strong> yang langsung masuk ke penambahan saldo <strong>Fee Trading (Gas Tank)</strong> Anda (tidak bisa di-withdrawal).
            </p>
            <div className="text-[10px] text-slate-600 dark:text-slate-400 font-mono border-t border-amber-200 dark:border-[#142640] pt-1.5 flex items-center justify-between font-medium">
              <span>Bagi Hasil Trading Downline: <strong className="text-amber-700 dark:text-amber-400">20% CASH</strong> (Bisa di-Withdrawal)</span>
              {onOpenProfitShare && (
                <button
                  type="button"
                  onClick={onOpenProfitShare}
                  className="text-emerald-600 dark:text-[#8DC63F] hover:underline font-bold"
                >
                  Lihat Skema Bagi Hasil →
                </button>
              )}
            </div>
          </div>

          {/* Kode Verifikasi 6 Digit */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-mono text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1.5 font-bold">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-[#8DC63F]" />
                Kode Verifikasi 6 Digit (Wajib)
              </label>
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-mono font-bold">Secured</span>
            </div>
            <input
              type="text"
              maxLength={6}
              placeholder="6 Digit Kode Verifikasi (cth: 301948)"
              value={otp2fa}
              onChange={(e) => setOtp2fa(e.target.value.replace(/\D/g, ''))}
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#09111E] border border-slate-300 dark:border-[#162740] font-mono text-center tracking-widest text-sm text-slate-900 dark:text-white focus:outline-none focus:border-emerald-500 dark:focus:border-[#8DC63F] focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          {/* Breakdown summary */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#070D17] border border-slate-200 dark:border-[#14233A] space-y-1.5 text-xs font-mono">
            <div className="flex justify-between text-slate-600 dark:text-slate-400">
              <span className="font-medium">Sumber Dana:</span>
              <span className="text-slate-900 dark:text-white font-bold">Saldo GAIN ({formatUsdt(availableBalance)} USDT)</span>
            </div>
            <div className="flex justify-between text-slate-600 dark:text-slate-400">
              <span className="font-medium">Top-Up Pokok (Dipotong):</span>
              <span className="text-rose-600 dark:text-rose-400 font-bold">-{formatUsdt(numAmount)} USDT</span>
            </div>
            {bonusPct > 0 && (
              <div className="flex justify-between text-emerald-700 dark:text-emerald-400 font-bold">
                <span>Bonus Promo Member ({bonusPct}% Non-Cash):</span>
                <span>+{formatUsdt(bonusUsdt)} USDT</span>
              </div>
            )}
            <div className="flex justify-between text-emerald-600 dark:text-emerald-300 font-bold">
              <span>Total Gas Masuk ke Tank:</span>
              <span>+{formatUsdt(totalGasReceived)} USDT</span>
            </div>
            <div className="border-t border-slate-200 dark:border-[#132034] pt-2 flex justify-between items-baseline">
              <span className="text-slate-700 dark:text-slate-300 font-sans font-bold">Estimasi Saldo Gas Baru:</span>
              <span className="text-base font-black text-emerald-600 dark:text-[#8DC63F]">
                +{formatUsdt(newGasTotal)} USDT
              </span>
            </div>
          </div>

          {errorMsg && (
            <div className="p-2.5 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-400 text-xs font-mono flex items-center gap-2 font-medium">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {isSuccess && (
            <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-500/20 border border-emerald-300 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-xs font-mono flex items-center gap-2 font-bold">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>Gas Fee Pool Berhasil Ditambahkan!</span>
            </div>
          )}

          {/* Bottom Actions */}
          <div className="pt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0F1A2D] text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:text-white text-xs font-bold transition"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={isProcessing}
              className="px-5 py-2.5 rounded-xl bg-emerald-500 dark:bg-[#8DC63F] hover:bg-emerald-600 dark:hover:bg-[#7ab72f] text-white dark:text-slate-950 text-xs font-bold shadow-lg shadow-emerald-500/20 dark:shadow-[#8DC63F]/20 transition flex items-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              <Fuel className="w-4 h-4" />
              {isProcessing ? 'Mengalokasikan...' : 'Konfirmasi & Isi Gas Fee Pool'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
