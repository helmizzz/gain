import { useEffect, useRef, useState } from 'react';
import { X, Shield, AlertTriangle, ArrowUpRight, CheckCircle2, Lock, ExternalLink, Zap } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { formatUsdt } from '../../utils/formatters';
import { requestWalletWithdrawal } from '../../services/walletService';
import { enrollWithdrawalAddress, getWithdrawalAddresses, getWithdrawalPolicy } from '../../api/walletApi';

interface WithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableBalance: number;
  userSecret?: string;
  userEmail?: string;
  memberId?: string;
  onWithdrawSuccess: (amount: number, address: string, queueDetails?: any) => void;
}

export function WithdrawModal({
  isOpen,
  onClose,
  availableBalance,
  userSecret,
  userEmail,
  memberId,
  onWithdrawSuccess,
}: WithdrawModalProps) {
  const { t } = useLanguage();
  const idempotencyKeyRef = useRef<string | null>(null);
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('100');
  const [otp2fa, setOtp2fa] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [queueInfo, setQueueInfo] = useState<{ queueId: string; queuePosition?: number; estimatedMinutes?: number } | null>(null);
  const [autoDisburseData, setAutoDisburseData] = useState<{ txHash: string; bscScanUrl: string } | null>(null);
  const [withdrawalAddresses, setWithdrawalAddresses] = useState<Array<{id:string;address:string;label:string;status:string;cooldown_until:string}>>([]);
  const [isEnrollingAddress, setIsEnrollingAddress] = useState(false);
  const [addressNotice, setAddressNotice] = useState('');
  const [withdrawalPolicy, setWithdrawalPolicy] = useState<{minimumAmount:number;maximumAmount:number;fee:number;addressCooldownHours:number}|null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    void getWithdrawalAddresses().then((result:any) => {
      if (active) setWithdrawalAddresses(Array.isArray(result.addresses) ? result.addresses : []);
    }).catch((error:any) => {
      if (active) setAddressNotice(error?.message || 'Daftar alamat whitelist tidak dapat dimuat.');
    });
    void getWithdrawalPolicy().then((result:any) => {
      if (active) setWithdrawalPolicy({minimumAmount:Number(result.minimumAmount),maximumAmount:Number(result.maximumAmount),fee:Number(result.fee),addressCooldownHours:Number(result.addressCooldownHours)});
    }).catch((error:any) => {
      if (active) setAddressNotice(error?.message || 'Kebijakan withdrawal belum siap.');
      if (active) setWithdrawalPolicy(null);
    });
    return () => { active = false; };
  }, [isOpen]);
  const flatFee = withdrawalPolicy?.fee ?? Number.NaN;
  const numAmount = parseFloat(amount) || 0;
  const receivedAmount = Number.isFinite(flatFee) ? Math.max(0, numAmount - flatFee) : 0;

  if (!isOpen) return null;

  const handleQuickPercent = (pct: number) => {
    const val = (availableBalance * pct) / 100;
    idempotencyKeyRef.current = null;
    setAmount(val.toFixed(2));
  };

  const handlePasteAddress = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        idempotencyKeyRef.current = null;
        setAddress(text.trim());
      } else {
        setErrorMsg('Clipboard kosong. Silakan tempel alamat dompet secara manual.');
      }
    } catch {
      setErrorMsg('Akses clipboard diblokir browser. Silakan tempel (Ctrl+V) alamat dompet secara manual.');
    }
  };

  const selectedWhitelistAddress = withdrawalAddresses.find((entry) =>
    entry.status === 'ACTIVE' && entry.address.toLowerCase() === address.trim().toLowerCase(),
  );
  const cooldownElapsed = Boolean(selectedWhitelistAddress && new Date(selectedWhitelistAddress.cooldown_until).getTime() <= Date.now());

  const handleEnrollAddress = async () => {
    setAddressNotice('');
    if (!/^0x[a-fA-F0-9]{40}$/.test(address.trim())) {
      setAddressNotice('Masukkan alamat BEP-20 yang valid sebelum mendaftarkan whitelist.');
      return;
    }
    if (!/^\d{6}$/.test(otp2fa.trim())) {
      setAddressNotice('Masukkan kode Google Authenticator 6 digit untuk mendaftarkan alamat.');
      return;
    }
    setIsEnrollingAddress(true);
    try {
      const result:any = await enrollWithdrawalAddress({ address:address.trim(), otp2fa:otp2fa.trim() });
      const refreshed:any = await getWithdrawalAddresses();
      setWithdrawalAddresses(Array.isArray(refreshed.addresses) ? refreshed.addresses : []);
      setOtp2fa('');
      setAddressNotice(result.replayed
        ? 'Alamat ini sudah ada di whitelist.'
        : 'Alamat terdaftar. Cooldown berlaku sampai ' + new Date(result.cooldownUntil).toLocaleString('id-ID') + '.');
    } catch (error:any) {
      setAddressNotice(error?.message || 'Alamat tidak dapat didaftarkan.');
    } finally {
      setIsEnrollingAddress(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (!address || address.length < 10) {
      setErrorMsg('Masukkan alamat dompet BEP-20 yang valid.');
      return;
    }

    if (!withdrawalPolicy || numAmount < withdrawalPolicy.minimumAmount || numAmount > withdrawalPolicy.maximumAmount) {
      setErrorMsg('Nominal withdrawal di luar batas yang dikonfigurasi atau kebijakan belum tersedia.');
      return;
    }

    if (numAmount > availableBalance) {
      setErrorMsg('Saldo vault tidak mencukupi untuk penarikan ini.');
      return;
    }

    const cleanOtp = otp2fa.trim();
    if (cleanOtp.length !== 6 || !/^\d{6}$/.test(cleanOtp)) {
      setErrorMsg('Masukkan kode 6 digit Google Authenticator untuk penarikan USDT.');
      return;
    }

    setIsProcessing(true);

    try {
      const idempotencyKey = idempotencyKeyRef.current || (idempotencyKeyRef.current = crypto.randomUUID());
      const data = await requestWalletWithdrawal({
          address: address.trim(),
          amount: numAmount,
          network: 'BEP-20',
          otp2fa: cleanOtp,
          userSecret,
          memberId,
          userEmail,
          idempotencyKey,
      });

      if (data.success) {
        idempotencyKeyRef.current = null;
        setIsProcessing(false);
        setIsSuccess(true);

        if (data.autoDisbursed && data.txHash) {
          setAutoDisburseData({
            txHash: data.txHash,
            bscScanUrl: data.bscScanUrl || `https://bscscan.com/tx/${data.txHash}`,
          });
        }

        setQueueInfo({
          queueId: data.queueId,
          queuePosition: data.queuePosition || 1,
          estimatedMinutes: data.estimatedMinutes || (data.autoDisbursed ? 1 : 10),
        });

        onWithdrawSuccess(numAmount, address, data);
        setTimeout(() => {
          setIsSuccess(false);
          setQueueInfo(null);
          setAutoDisburseData(null);
          onClose();
        }, data.autoDisbursed ? 3500 : 2500);
      } else {
        setIsProcessing(false);
        setErrorMsg(data.error || 'Gagal mengajukan penarikan.');
      }
    } catch (err: any) {
      setIsProcessing(false);
      setErrorMsg(err?.message || 'Koneksi jaringan terputus saat menghubungi server. Silakan periksa koneksi dan coba lagi.');
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
            <h3 className="font-extrabold text-base text-slate-900 dark:text-white tracking-wide">
              Withdraw USDT (BEP-20)
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
              Algorithmic Settlement Vault
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
          {/* Balance card */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#0B1527] border border-slate-200 dark:border-[#162740] flex items-center justify-between">
            <div>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-mono font-medium">
                Saldo Bebas Ditarik (Liquid Cash & Bagi Hasil)
              </span>
              <div className="text-lg font-black font-mono text-slate-900 dark:text-white mt-0.5">
                {formatUsdt(availableBalance)} <span className="text-xs text-emerald-600 dark:text-[#8DC63F]">USDT</span>
              </div>
            </div>
            <div className="text-right">
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20 font-medium">
                BEP-20 • Settlement Server
              </span>
              <p className="text-[10px] text-emerald-700 dark:text-emerald-400/80 mt-1 font-mono font-medium">Permintaan akan melalui Review</p>
            </div>
          </div>

          <div className="px-3 py-2 rounded-lg bg-amber-50 dark:bg-[#070D17] border border-amber-200 dark:border-[#14233A] text-[10.5px] text-slate-700 dark:text-slate-300 font-sans leading-relaxed">
            💡 <strong>Program Promo & Bonus hingga 90% (Komisi Cash):</strong> Bonus Aktivasi Downline (<strong>20% CASH</strong>) dan Bagi Hasil Trading (<strong>20% CASH dari 20% Fee TP</strong>) otomatis masuk ke saldo ini dan 100% bebas di-withdraw ke dompet BEP-20 Anda kapan saja. Sedangkan <strong>Bonus Top-Up Fee Downline (10% Non-Cash)</strong> tersimpan khusus di Gas Fee Tank.
          </div>

          {/* Destination Address */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-mono text-slate-700 dark:text-slate-300 uppercase tracking-wider font-bold">
                Alamat Dompet Tujuan (BEP-20)
              </label>
              <button
                type="button"
                onClick={handlePasteAddress}
                className="text-[11px] text-emerald-600 dark:text-[#8DC63F] hover:underline font-mono font-bold"
              >
                Tempel
              </button>
            </div>
            <input
              type="text"
              placeholder="0x..."
              value={address}
              onChange={(e) => { idempotencyKeyRef.current = null; setAddress(e.target.value); setAddressNotice(''); }}
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#09111E] border border-slate-300 dark:border-[#162740] font-mono text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 dark:focus:border-[#8DC63F] focus:ring-1 focus:ring-emerald-500"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" onClick={handleEnrollAddress} disabled={isEnrollingAddress}
                className="rounded-lg border border-amber-300 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/10 px-3 py-1.5 text-[10px] font-mono text-amber-700 dark:text-amber-200 disabled:opacity-50 font-medium">
                {isEnrollingAddress ? 'Mendaftarkan…' : 'Daftarkan alamat & mulai cooldown'}
              </button>
              {selectedWhitelistAddress && (
                <span className={'text-[10px] font-mono font-medium ' + (cooldownElapsed ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-600 dark:text-amber-300')}>
                  {cooldownElapsed ? 'Whitelist aktif; cooldown selesai' : 'Cooldown sampai ' + new Date(selectedWhitelistAddress.cooldown_until).toLocaleString('id-ID')}
                </span>
              )}
            </div>
            {addressNotice && <p role="status" className="mt-1 text-[10px] text-amber-600 dark:text-amber-200 font-medium">{addressNotice}</p>}
          </div>

          {/* Amount to Withdraw */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-mono text-slate-700 dark:text-slate-300 uppercase tracking-wider font-bold">
                Jumlah Penarikan
              </label>
              <span className="text-[11px] text-slate-600 dark:text-slate-400 font-mono font-medium">{withdrawalPolicy ? 'Min: ' + withdrawalPolicy.minimumAmount + ' USDT' : 'Batas belum tersedia'}</span>
            </div>
            <div className="relative">
              <input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => { idempotencyKeyRef.current = null; setAmount(e.target.value); }}
                className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#09111E] border border-slate-300 dark:border-[#162740] font-mono text-sm text-slate-900 dark:text-white focus:outline-none focus:border-emerald-500 dark:focus:border-[#8DC63F] focus:ring-1 focus:ring-emerald-500"
              />
              <span className="absolute right-3.5 top-2.5 text-xs font-mono font-bold text-slate-600 dark:text-slate-400">
                USDT
              </span>
            </div>

            {/* Quick chips */}
            <div className="grid grid-cols-5 gap-1.5 mt-2">
              {[25, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => handleQuickPercent(pct)}
                  className="py-1 rounded-lg bg-slate-100 dark:bg-[#0C1628] border border-slate-300 dark:border-[#172A46] text-[11px] font-mono text-slate-600 dark:text-slate-300 hover:text-emerald-600 dark:hover:text-[#8DC63F] hover:border-emerald-500 dark:hover:border-[#8DC63F]/40 transition font-medium"
                >
                  {pct}%
                </button>
              ))}
              <button
                type="button"
                onClick={() => handleQuickPercent(100)}
                className="py-1 rounded-lg bg-emerald-100 dark:bg-[#8DC63F]/10 border border-emerald-300 dark:border-[#8DC63F]/30 text-[11px] font-mono text-emerald-700 dark:text-[#8DC63F] font-bold hover:bg-emerald-200 dark:hover:bg-[#8DC63F]/20 transition"
              >
                MAX
              </button>
            </div>
          </div>

          {/* Google Authenticator / high-risk transaction verification */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-mono text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1.5 font-bold">
                <Shield className="w-3.5 h-3.5 text-emerald-600 dark:text-[#8DC63F]" />
                Google Authenticator (6 Digit)
              </label>
            </div>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="Kode Google Authenticator (6 digit)"
              value={otp2fa}
              onChange={(e) => setOtp2fa(e.target.value.replace(/\D/g, ''))}
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#09111E] border border-slate-300 dark:border-[#162740] font-mono text-center tracking-widest text-sm text-slate-900 dark:text-white focus:outline-none focus:border-emerald-500 dark:focus:border-[#8DC63F] focus:ring-1 focus:ring-emerald-500"
            />
            <p className="text-[10px] text-slate-500 dark:text-slate-500 font-mono mt-1 font-medium">
              TOTP Google Authenticator diperlukan untuk otorisasi transaksi berisiko tinggi. Kode tidak dikirim lewat email.
            </p>
          </div>

          {/* Fee & Breakdown Box */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#070D17] border border-slate-200 dark:border-[#14233A] space-y-2 text-xs font-mono">
            <div className="flex justify-between text-slate-600 dark:text-slate-400">
              <span className="font-medium">Biaya Jaringan (Flat Fee):</span>
              <span className="text-slate-900 dark:text-white font-bold">{Number.isFinite(flatFee) ? flatFee.toFixed(2) : '—'} USDT</span>
            </div>
            <div className="flex justify-between text-slate-600 dark:text-slate-400">
              <span className="font-medium">Estimasi Durasi:</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-bold">~1 - 3 Menit</span>
            </div>
            <div className="border-t border-slate-200 dark:border-[#132034] pt-2 flex justify-between items-baseline">
              <span className="text-slate-700 dark:text-slate-300 font-sans font-bold">Estimasi Diterima:</span>
              <span className="text-base font-black text-emerald-600 dark:text-[#8DC63F]">
                {formatUsdt(receivedAmount)} USDT
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
            <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-xs font-mono space-y-2">
              <div className="flex items-center gap-2 font-bold">
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span>
                  {autoDisburseData
                    ? 'Penarikan Terkirim Instan On-Chain!'
                    : 'Penarikan Masuk Antrean Settlement!'}
                </span>
                {autoDisburseData && (
                  <span className="px-1.5 py-0.2 rounded text-[9.5px] font-mono bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-[#8DC63F] border border-emerald-300 dark:border-emerald-500/30 font-bold ml-auto flex items-center gap-1">
                    <Zap className="w-3 h-3 text-emerald-600 dark:text-[#8DC63F]" />
                    AUTO-DISBURSED
                  </span>
                )}
              </div>

              {autoDisburseData ? (
                <div className="text-[11px] text-slate-700 dark:text-slate-300 space-y-1.5 pt-1 border-t border-emerald-200 dark:border-emerald-500/20 font-medium">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600 dark:text-slate-400">Bukti TxID BSC:</span>
                    <a
                      href={autoDisburseData.bscScanUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-700 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-300 flex items-center gap-1 font-bold underline"
                    >
                      <span>Lihat di BscScan</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <div className="p-1.5 bg-white dark:bg-[#050A12] rounded border border-emerald-200 dark:border-[#14233A] text-[10px] text-emerald-700 dark:text-[#8DC63F] break-all select-all font-mono font-semibold">
                    {autoDisburseData.txHash}
                  </div>
                </div>
              ) : queueInfo ? (
                <div className="text-[11px] text-slate-700 dark:text-slate-300 space-y-0.5 pt-1 pl-6 font-medium">
                  <div>ID Antrean: <strong className="text-emerald-700 dark:text-[#8DC63F]">{queueInfo.queueId}</strong></div>
                  <div>Posisi Antrean: #{queueInfo.queuePosition} • Estimasi: ~{queueInfo.estimatedMinutes} menit</div>
                </div>
              ) : null}
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
            disabled={isProcessing || !cooldownElapsed || !withdrawalPolicy}
              className="px-5 py-2.5 rounded-xl bg-emerald-500 dark:bg-[#8DC63F] hover:bg-emerald-600 dark:hover:bg-[#7ab72f] text-white dark:text-slate-950 text-xs font-bold shadow-lg shadow-emerald-500/20 dark:shadow-[#8DC63F]/20 transition flex items-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              <ArrowUpRight className="w-4 h-4" />
              {isProcessing ? 'Memproses...' : 'Konfirmasi & Tarik Dana'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
