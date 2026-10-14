import { useState } from 'react';
import {
  X,
  Sparkles,
  ShieldCheck,
  CheckCircle2,
  Clock,
  Zap,
  Lock,
  Wallet,
  AlertCircle,
  Check,
  ArrowRight,
  TrendingUp,
  Layers,
  HelpCircle,
  Coins,
  Bot,
  Ticket,
  Tag,
} from 'lucide-react';
import { UserWallet } from '../../types';
import { formatUsdt } from '../../utils/formatters';
import { getLicenseTierConfig, getReferralActivationBonus } from '../../config/licensePromo';
import { validateVoucher } from '../../api/voucherApi';

interface ActivationFeeModalProps {
  isOpen: boolean;
  onClose: () => void;
  wallet: UserWallet;
  onProcessActivation?: (tier: 'starter_6' | 'pro_12', isUpgrade?: boolean, voucherCode?: string) => Promise<any>;
  onOpenDepositModal?: () => void;
  activeBotsCount?: number;
}

export function ActivationFeeModal({
  isOpen,
  onClose,
  wallet,
  onProcessActivation,
  onOpenDepositModal,
  activeBotsCount = 0,
}: ActivationFeeModalProps) {
  const isCurrentlyActive = wallet.licenseStatus === 'active';
  const isPro = wallet.licenseTier === 'pro_12';
  const isStarter = !isPro && (wallet.licenseTier === 'starter_6' || isCurrentlyActive);
  const currentTier: 'starter_6' | 'pro_12' | undefined = isPro ? 'pro_12' : isStarter ? 'starter_6' : undefined;

  // Default selection: if user already has starter, preselect pro_12 for upgrade
  const [selectedTier, setSelectedTier] = useState<'starter_6' | 'pro_12'>(
    isStarter ? 'pro_12' : 'starter_6'
  );
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Voucher State
  const [voucherCodeInput, setVoucherCodeInput] = useState('');
  const [appliedVoucher, setAppliedVoucher] = useState<{
    code: string;
    discountAmount: number;
    finalFee: number;
    discountType: string;
    discountValue: number;
  } | null>(null);
  const [isValidatingVoucher, setIsValidatingVoucher] = useState(false);
  const [voucherErrorMsg, setVoucherErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const isUpgrade = isCurrentlyActive && isStarter && selectedTier === 'pro_12';
  const isAlreadyMax = isCurrentlyActive && isPro;

  const starter = getLicenseTierConfig('starter_6');
  const pro = getLicenseTierConfig('pro_12');
  const selectedConfig = selectedTier === 'pro_12' ? pro : starter;
  let baseRequiredAmount = selectedConfig.promoPriceUsdt;
  let normalPrice = selectedConfig.normalPriceUsdt;
  let promoPrice = selectedConfig.promoPriceUsdt;
  let maxBots = selectedConfig.maxActiveBots;
  let tradingBonus = selectedConfig.gasBonusUsdt;

  if (isUpgrade && selectedTier === 'pro_12') {
    baseRequiredAmount = pro.promoPriceUsdt - starter.promoPriceUsdt;
    tradingBonus = pro.gasBonusUsdt - starter.gasBonusUsdt;
  }

  const finalRequiredAmount = appliedVoucher ? appliedVoucher.finalFee : baseRequiredAmount;
  const referralBonus = getReferralActivationBonus(finalRequiredAmount);
  const starterReferralBonus = getReferralActivationBonus(starter.promoPriceUsdt);
  const proReferralBonus = getReferralActivationBonus(pro.promoPriceUsdt);

  const hasSufficientBalance = wallet.liquidBalance >= finalRequiredAmount;
  const currentMaxBots = wallet.maxActiveBots || (isCurrentlyActive ? (isPro ? 12 : 6) : 0);

  const handleApplyVoucher = async () => {
    if (!voucherCodeInput.trim()) return;
    setVoucherErrorMsg(null);
    setIsValidatingVoucher(true);
    try {
      const res = await validateVoucher(voucherCodeInput.trim(), selectedTier);
      if (res.valid && res.voucher) {
        setAppliedVoucher({
          code: res.voucher.code,
          discountAmount: res.voucher.discountAmount,
          finalFee: res.voucher.finalFee,
          discountType: res.voucher.discountType,
          discountValue: res.voucher.discountValue,
        });
        setVoucherCodeInput('');
      } else {
        setVoucherErrorMsg(res.message || 'Kode voucher tidak valid.');
      }
    } catch (err: any) {
      setVoucherErrorMsg(err.message || 'Gagal memvalidasi kode voucher.');
    } finally {
      setIsValidatingVoucher(false);
    }
  };

  const handleRemoveVoucher = () => {
    setAppliedVoucher(null);
    setVoucherErrorMsg(null);
  };

  const handleActivateOrUpgrade = async () => {
    if (!onProcessActivation) return;
    setErrorMsg(null);
    setIsProcessing(true);
    try {
      await onProcessActivation(selectedTier, isUpgrade, appliedVoucher ? appliedVoucher.code : undefined);
      setSuccessMsg(
        isUpgrade
          ? '🎉 Upgrade ke Pro Lifetime (12 Bot Aktif) berhasil! Bonus Gas Tank +40 USDT ditambahkan.'
          : `🎉 Lisensi Lifetime ${selectedTier === 'pro_12' ? 'Pro (12 Bot)' : 'Starter (6 Bot)'} berhasil diaktifkan! Bonus gas fee $${tradingBonus} USDT telah masuk ke Gas Tank Anda.`
      );
      setTimeout(() => {
        onClose();
      }, 2000);
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal memproses pembayaran aktivasi lisensi.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn overflow-y-auto">
      <div className="theme-modal-shell relative w-full max-w-lg bg-white dark:bg-[#080E1B] border border-slate-200 dark:border-[#162740] rounded-2xl shadow-2xl overflow-hidden text-slate-900 dark:text-slate-100 space-y-4 p-5 sm:p-6 my-auto max-h-[92vh] flex flex-col">
        {/* Ambient Top Glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-24 bg-gradient-to-r from-[#8DC63F]/15 via-blue-500/15 to-[#8DC63F]/15 blur-2xl pointer-events-none rounded-full" />

        {/* Modal Header */}
        <div className="relative flex items-center justify-between pb-3 border-b border-slate-200 dark:border-[#14233A] shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 dark:bg-[#8DC63F]/10 border border-amber-500/30 dark:border-[#8DC63F]/30 flex items-center justify-center text-amber-600 dark:text-[#F0B90B] shadow-inner">
              <Zap className="w-5 h-5 text-amber-500 dark:text-[#8DC63F]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-extrabold text-sm sm:text-base text-slate-900 dark:text-white font-mono">
                  PROGRAM PROMO & BONUS HINGGA 90%
                </h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-500/15 text-amber-800 dark:text-[#F0B90B] border border-amber-500/40">
                  LIFETIME
                </span>
              </div>
              <p className="text-[11px] text-slate-600 dark:text-slate-400 font-mono mt-0.5">
                Diskon 50% Normal + Bonus 40% Fee Trading = Total Benefit 90%
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-[#14233A] transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div className="overflow-y-auto space-y-4 pr-1 text-xs font-mono custom-scrollbar">
          {/* Current User Status Banner */}
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#050A14] border border-slate-200 dark:border-[#142238] flex items-center justify-between flex-wrap gap-2">
            <div>
              <span className="text-[10px] text-slate-600 dark:text-slate-400 font-semibold block">Status Lisensi Saat Ini:</span>
              <div className="flex items-center gap-2 mt-0.5">
                <span
                  className={`px-2 py-0.5 rounded text-[11px] font-extrabold border flex items-center gap-1.5 ${
                    isCurrentlyActive
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/40'
                      : 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/40'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${isCurrentlyActive ? 'bg-emerald-500' : 'bg-amber-500 animate-ping'}`} />
                  <span>{isCurrentlyActive ? (wallet.licenseName || `ACTIVE (${currentMaxBots} Bot)`) : 'NON-ACTIVE'}</span>
                </span>
                {isCurrentlyActive && (
                  <span className="text-[11px] text-slate-700 dark:text-slate-400">
                    Kuota Aktif: <strong className="text-slate-900 dark:text-white">{activeBotsCount} / {currentMaxBots} Bot</strong>
                  </span>
                )}
              </div>
            </div>

            <div className="text-right">
              <span className="text-[10px] text-slate-600 dark:text-slate-400 font-semibold block">Saldo Wallet GAIN:</span>
              <span className="text-sm font-black text-emerald-600 dark:text-emerald-400">
                {formatUsdt(wallet.liquidBalance)} USDT
              </span>
            </div>
          </div>

          {/* Promo Announcement Banner */}
          <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-500/40 space-y-1.5">
            <div className="flex items-center justify-between flex-wrap gap-1">
              <span className="flex items-center gap-1.5 text-amber-900 dark:text-[#F0B90B] font-extrabold text-[11px]">
                <Sparkles className="w-3.5 h-3.5 text-amber-600 dark:text-[#F0B90B]" />
                <span>PROGRAM PROMO & BONUS HINGGA 90%</span>
              </span>
              <span className="px-1.5 py-0.5 rounded text-[9px] bg-red-500/15 text-red-700 dark:text-red-400 border border-red-500/30 font-extrabold animate-pulse">
                50% + 40% = 90%
              </span>
            </div>
            <div className="space-y-1 text-[10.5px] text-slate-800 dark:text-slate-200 leading-relaxed font-sans font-medium">
              <p>
                • <strong className="text-slate-900 dark:text-white font-extrabold">Diskon 50%</strong> dari harga lisensi normal (sekali bayar seumur hidup / Lifetime).
              </p>
              <p>
                • <strong className="text-slate-900 dark:text-white font-extrabold">Bonus 40% fee trading</strong> setelah aktivasi langsung masuk ke Gas Fee Tank Anda untuk bahan bakar bot!
              </p>
              <p className="text-amber-900/90 dark:text-amber-200/90 font-mono text-[9.5px] pt-0.5 font-bold">
                *50% + 40% = 90% (akumulasi persentase promo, bukan nilai $).
              </p>
            </div>
          </div>

          {/* Package Selection Cards */}
          <div className="space-y-2.5">
            <label className="text-[11px] font-extrabold text-slate-900 dark:text-slate-200 uppercase tracking-wider block">
              Pilih Paket Lisensi Lifetime:
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* TIER 1: Starter (6 Bot Aktif) */}
              <div
                onClick={() => {
                  if (!isPro) {
                    setSelectedTier('starter_6');
                  }
                }}
                className={`relative p-3.5 rounded-xl border transition-all cursor-pointer space-y-2.5 text-left ${
                  selectedTier === 'starter_6'
                    ? 'bg-amber-500/10 dark:bg-amber-500/10 border-amber-500 ring-2 ring-amber-400 dark:ring-[#8DC63F]/50 shadow-md'
                    : 'bg-slate-50 dark:bg-[#050B16] border-slate-200 dark:border-[#162740] hover:border-slate-400 dark:hover:border-slate-600'
                } ${isStarter ? 'border-emerald-500' : ''}`}
              >
                {isStarter && (
                  <span className="absolute -top-2 right-3 px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-emerald-500 text-slate-950">
                    PAKET ANDA SAAT INI
                  </span>
                )}

                <div className="flex items-start justify-between">
                  <div>
                    <h4 className="font-extrabold text-xs text-slate-900 dark:text-white">Starter Lifetime</h4>
                    <p className="text-[10px] text-emerald-600 dark:text-[#8DC63F] font-bold">Maks. 6 Bot Aktif</p>
                  </div>
                  <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                    selectedTier === 'starter_6'
                      ? 'border-amber-500 bg-amber-500 dark:border-[#8DC63F] dark:bg-[#8DC63F] text-slate-950'
                      : 'border-slate-400 dark:border-slate-600'
                  }`}>
                    {selectedTier === 'starter_6' && <Check className="w-3 h-3 stroke-[3]" />}
                  </div>
                </div>

                {/* Price Display */}
                <div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-base font-black text-slate-900 dark:text-white">$150</span>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 line-through font-medium">$300</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-900 dark:text-[#F0B90B] font-extrabold border border-amber-400/30">Diskon 50%</span>
                  </div>
                  <span className="text-[9.5px] text-slate-600 dark:text-slate-400 font-medium block mt-0.5">Biaya sekali bayar seumur hidup (Lifetime)</span>
                </div>

                {/* Key Benefits */}
                <ul className="space-y-1 text-[10px] text-slate-700 dark:text-slate-300 border-t border-slate-200 dark:border-slate-800/80 pt-2 font-medium">
                  <li className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3 h-3 text-amber-600 dark:text-[#F0B90B] shrink-0" />
                    <span><strong className="text-slate-900 dark:text-white">6 Bot Aktif</strong> bersamaan</span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3 h-3 text-amber-600 dark:text-[#F0B90B] shrink-0" />
                    <span>Draft setting bot <strong className="text-slate-900 dark:text-white">tanpa batas</strong></span>
                  </li>
                  <li className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-bold">
                    <Sparkles className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span><strong>Bonus 40% Fee Trading (+60 USDT Gas Tank)</strong></span>
                  </li>
                  <li className="flex items-center gap-1.5 text-emerald-800 dark:text-emerald-300 font-bold">
                    <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span>Total Promo: <strong>50% + 40% = 90% Benefit</strong></span>
                  </li>
                  <li className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                    <Coins className="w-3 h-3 text-amber-600 dark:text-[#F0B90B] shrink-0" />
                    <span>Bonus Referral: <strong>20% Cash (+${starterReferralBonus.toFixed(0)})</strong> + <strong>10% Gas</strong> + <strong>20% Fee TP</strong></span>
                  </li>
                </ul>
              </div>

              {/* TIER 2: Pro (12 Bot Aktif) */}
              <div
                onClick={() => setSelectedTier('pro_12')}
                className={`relative p-3.5 rounded-xl border transition-all cursor-pointer space-y-2.5 text-left ${
                  selectedTier === 'pro_12'
                    ? 'bg-indigo-50 dark:bg-gradient-to-br dark:from-indigo-500/15 dark:to-[#8DC63F]/10 border-indigo-500 ring-2 ring-indigo-400 shadow-md'
                    : 'bg-slate-50 dark:bg-[#050B16] border-slate-200 dark:border-[#162740] hover:border-slate-400 dark:hover:border-slate-600'
                } ${isPro ? 'border-emerald-500' : ''}`}
              >
                {/* Badge Top */}
                <div className="absolute -top-2 right-3 flex gap-1">
                  {isPro ? (
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-emerald-500 text-slate-950">
                      PAKET ANDA SAAT INI
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-indigo-600 dark:bg-indigo-500 text-white">
                      REKOMENDASI PRO
                    </span>
                  )}
                </div>

                <div className="flex items-start justify-between">
                  <div>
                    <h4 className="font-extrabold text-xs text-slate-900 dark:text-white">Pro Lifetime</h4>
                    <p className="text-[10px] text-indigo-600 dark:text-indigo-400 font-bold">Maks. 12 Bot Aktif</p>
                  </div>
                  <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                    selectedTier === 'pro_12'
                      ? 'border-indigo-500 bg-indigo-500 dark:border-indigo-400 dark:bg-indigo-400 text-white dark:text-slate-950'
                      : 'border-slate-400 dark:border-slate-600'
                  }`}>
                    {selectedTier === 'pro_12' && <Check className="w-3 h-3 stroke-[3]" />}
                  </div>
                </div>

                {/* Price Display */}
                <div>
                  <div className="flex items-baseline gap-1.5">
                    {isUpgrade ? (
                      <>
                        <span className="text-base font-black text-indigo-700 dark:text-indigo-300">+$100</span>
                        <span className="text-[10px] text-slate-400 dark:text-slate-500 line-through font-medium">+$200</span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 font-extrabold border border-indigo-300 dark:border-indigo-500/30">Hemat 50%</span>
                      </>
                    ) : (
                      <>
                        <span className="text-base font-black text-slate-900 dark:text-white">$250</span>
                        <span className="text-[10px] text-slate-400 dark:text-slate-500 line-through font-medium">$500</span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 font-extrabold border border-indigo-300 dark:border-indigo-500/30">Diskon 50%</span>
                      </>
                    )}
                  </div>
                  <span className="text-[9.5px] text-slate-600 dark:text-slate-400 font-medium block mt-0.5">
                    {isUpgrade ? 'Upgrade dari Starter ($150 → $250 Promo Diskon 50%)' : 'Biaya sekali bayar seumur hidup (Lifetime)'}
                  </span>
                </div>

                {/* Key Benefits */}
                <ul className="space-y-1 text-[10px] text-slate-700 dark:text-slate-300 border-t border-slate-200 dark:border-slate-800/80 pt-2 font-medium">
                  <li className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3 h-3 text-indigo-600 dark:text-indigo-400 shrink-0" />
                    <span><strong className="text-slate-900 dark:text-white">12 Bot Aktif</strong> bersamaan</span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3 h-3 text-indigo-600 dark:text-indigo-400 shrink-0" />
                    <span>Draft setting bot <strong className="text-slate-900 dark:text-white">tanpa batas</strong></span>
                  </li>
                  <li className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-bold">
                    <Sparkles className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span><strong>{isUpgrade ? 'Bonus 40% Fee Trading (+40 USDT Gas Tank)' : 'Bonus 40% Fee Trading (+100 USDT Gas Tank)'}</strong></span>
                  </li>
                  <li className="flex items-center gap-1.5 text-emerald-800 dark:text-emerald-300 font-bold">
                    <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span>Total Promo: <strong>50% + 40% = 90% Benefit</strong></span>
                  </li>
                  <li className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                    <Coins className="w-3 h-3 text-amber-600 dark:text-[#F0B90B] shrink-0" />
                    <span>Bonus Referral: <strong>20% Cash ({isUpgrade ? '+$20' : `+$${proReferralBonus.toFixed(0)}`})</strong> + <strong>10% Gas</strong> + <strong>20% Fee TP</strong></span>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          {/* Voucher Code Input Section */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#060D1A] border border-slate-200 dark:border-[#162740] space-y-2">
            <div className="flex items-center gap-1.5 text-slate-900 dark:text-slate-300 font-extrabold text-[11px]">
              <Ticket className="w-3.5 h-3.5 text-amber-600 dark:text-[#F0B90B]" />
              <span>Kode Voucher / Promo Aktivasi:</span>
            </div>

            {appliedVoucher ? (
              <div className="p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-300 dark:border-emerald-500/30 flex items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold text-emerald-800 dark:text-emerald-400 text-xs px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-500/20 border border-emerald-300 dark:border-emerald-500/40">
                      {appliedVoucher.code}
                    </span>
                    <span className="text-xs font-black text-emerald-700 dark:text-emerald-300">
                      Diskon -{appliedVoucher.discountAmount} USDT
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-600 dark:text-slate-400 block mt-0.5 font-medium">
                    Biaya Aktivasi Akhir: <strong className="text-slate-900 dark:text-white">${appliedVoucher.finalFee} USDT</strong>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleRemoveVoucher}
                  className="px-2 py-1 rounded bg-rose-100 hover:bg-rose-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-[10px] text-rose-700 dark:text-rose-300 font-bold transition cursor-pointer"
                >
                  Hapus
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={voucherCodeInput}
                  onChange={(e) => setVoucherCodeInput(e.target.value.toUpperCase())}
                  placeholder="Masukkan Kode Voucher..."
                  className="flex-1 px-3 py-2 rounded-lg bg-white dark:bg-[#081222] border border-slate-300 dark:border-[#182B46] text-xs text-slate-900 dark:text-white uppercase placeholder-slate-400 font-mono font-medium focus:outline-hidden focus:border-amber-500"
                />
                <button
                  type="button"
                  disabled={isValidatingVoucher || !voucherCodeInput.trim()}
                  onClick={handleApplyVoucher}
                  className="px-3 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 dark:hover:bg-amber-400 disabled:opacity-50 text-slate-950 text-xs font-extrabold transition flex items-center gap-1 cursor-pointer"
                >
                  {isValidatingVoucher ? (
                    <Clock className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Tag className="w-3.5 h-3.5" />
                  )}
                  <span>Terapkan</span>
                </button>
              </div>
            )}

            {voucherErrorMsg && (
              <p className="text-[10px] text-rose-600 dark:text-rose-400 font-mono font-bold flex items-center gap-1">
                <AlertCircle className="w-3 h-3 shrink-0" />
                <span>{voucherErrorMsg}</span>
              </p>
            )}
          </div>

          {/* Model Bisnis & Transparansi Simulasi */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#060D1A] border border-slate-200 dark:border-[#162740] space-y-2">
            <div className="flex items-center gap-1.5 text-slate-900 dark:text-slate-300 font-extrabold text-[11px]">
              <TrendingUp className="w-3.5 h-3.5 text-amber-600 dark:text-[#F0B90B]" />
              <span>Simulasi Ekosistem & Keuntungan Anda:</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
              <div className="p-2 rounded-lg bg-white dark:bg-[#081222] border border-slate-200 dark:border-[#182B46]">
                <span className="text-slate-600 dark:text-slate-400 font-semibold block">Biaya Aktivasi</span>
                <span className="text-slate-900 dark:text-white font-black block text-xs mt-0.5">
                  ${finalRequiredAmount} USDT
                </span>
                <span className="text-[9px] text-amber-700 dark:text-[#F0B90B] font-bold">Lifetime License</span>
              </div>
              <div className="p-2 rounded-lg bg-white dark:bg-[#081222] border border-slate-200 dark:border-[#182B46]">
                <span className="text-slate-600 dark:text-slate-400 font-semibold block">Bonus Gas Tank</span>
                <span className="text-emerald-700 dark:text-emerald-400 font-black block text-xs mt-0.5">
                  +${tradingBonus} USDT
                </span>
                <span className="text-[9px] text-slate-600 dark:text-slate-400 font-medium">Siap Trading</span>
              </div>
              <div className="p-2 rounded-lg bg-white dark:bg-[#081222] border border-slate-200 dark:border-[#182B46]">
                <span className="text-slate-600 dark:text-slate-400 font-semibold block">Bonus Referral</span>
                <span className="text-amber-700 dark:text-amber-400 font-black block text-xs mt-0.5">
                  ${referralBonus} USDT
                </span>
                <span className="text-[9px] text-slate-600 dark:text-slate-400 font-medium">20% ke Upline</span>
              </div>
            </div>
            <p className="text-[10.5px] text-slate-700 dark:text-slate-300 leading-normal pt-1 font-medium">
              💡 <strong className="text-slate-900 dark:text-white font-extrabold">PROGRAM PROMO & BONUS HINGGA 90%</strong>: 50% diskon harga normal + 40% bonus fee trading = 90% akumulasi persentase promo (bukan nilai $). Referral: 20% Cash aktivasi downline + 10% Non-Cash topup fee downline + 20% Cash dari 20% fee TP downline = 50% akumulasi benefit.
            </p>
          </div>

          {/* Error & Success Messages */}
          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-500/10 border border-rose-300 dark:border-rose-500/30 text-rose-800 dark:text-rose-300 text-xs flex items-start gap-2 font-medium">
              <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-300 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-xs flex items-center gap-2 font-medium">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}
        </div>

        {/* Modal Sticky Footer Action Controls */}
        <div className="pt-2 border-t border-slate-200 dark:border-[#14233A] space-y-2 shrink-0">
          {isAlreadyMax ? (
            <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-300 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-xs flex items-center justify-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span className="font-extrabold">Anda telah memiliki Paket Tertinggi: Pro Lifetime (12 Bot Aktif)!</span>
            </div>
          ) : hasSufficientBalance ? (
            <button
              disabled={isProcessing || (isCurrentlyActive && currentTier === selectedTier)}
              onClick={handleActivateOrUpgrade}
              className="w-full py-3 px-4 rounded-xl bg-[#8DC63F] hover:bg-[#7ab72f] disabled:opacity-50 text-slate-950 font-mono font-bold text-xs transition flex items-center justify-center gap-2 shadow-lg shadow-[#8DC63F]/20 cursor-pointer"
            >
              {isProcessing ? (
                <>
                  <Clock className="w-4 h-4 animate-spin text-slate-950" />
                  <span>Memproses Pembayaran ({finalRequiredAmount} USDT)...</span>
                </>
              ) : isUpgrade ? (
                <>
                  <Sparkles className="w-4 h-4 text-slate-950" />
                  <span>Upgrade ke Pro (12 Bot) • Bayar Selisih {finalRequiredAmount} USDT Diskon 50% (+Bonus $40 Gas)</span>
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 text-slate-950" />
                  <span>
                    Aktivasi {selectedTier === 'pro_12' ? 'Pro Lifetime 12 Bot' : 'Starter Lifetime 6 Bot'} (${finalRequiredAmount} USDT) (+Bonus Gas ${tradingBonus})
                  </span>
                </>
              )}
            </button>
          ) : (
            <div className="space-y-2">
              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-500/30 text-amber-900 dark:text-amber-300 text-xs font-sans font-medium flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <span>
                  Saldo wallet GAIN Anda (<strong className="font-bold">{formatUsdt(wallet.liquidBalance)} USDT</strong>) kurang dari biaya yang diperlukan (<strong className="font-bold">{formatUsdt(finalRequiredAmount)} USDT</strong>).
                </span>
              </div>
              {onOpenDepositModal && (
                <button
                  onClick={() => {
                    onClose();
                    onOpenDepositModal();
                  }}
                  className="w-full py-3 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 dark:bg-amber-500/20 dark:hover:bg-amber-500/30 border border-amber-500/50 text-slate-950 dark:text-amber-300 font-sans font-extrabold text-xs transition flex items-center justify-center gap-2 cursor-pointer shadow-sm"
                >
                  <Wallet className="w-4 h-4 text-slate-950 dark:text-amber-400" />
                  <span>Deposit Saldo GAIN (+{formatUsdt(finalRequiredAmount - wallet.liquidBalance)} USDT)</span>
                </button>
              )}
            </div>
          )}

          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-[#0E1B2E] dark:hover:bg-[#13253E] border border-slate-200 dark:border-[#1A2E4C] text-slate-700 dark:text-slate-300 font-sans font-bold text-xs transition cursor-pointer"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
