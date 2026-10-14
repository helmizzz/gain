import { useRef, useState } from 'react';
import { X, Send, ShieldCheck, CheckCircle2, AlertTriangle} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { lookupMemberInDirectory } from '../../services/memberService';
import { formatUsdt } from '../../utils/formatters';
import { transferWalletFunds } from '../../services/walletService';

interface TransferMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableBalance: number;
  userSecret?: string;
  senderMemberId?: string;
  userEmail?: string;
  onTransferSuccess: (recipientId: string, recipientName: string, amount: number) => void;
}

export function TransferMemberModal({
  isOpen,
  onClose,
  availableBalance,
  userSecret,
  senderMemberId,
  userEmail,
  onTransferSuccess,
}: TransferMemberModalProps) {
  const { t } = useLanguage();
  const idempotencyKeyRef = useRef<string | null>(null);
  const [recipientId, setRecipientId] = useState('');
  const [verifiedName, setVerifiedName] = useState('');
  const [verifiedStatus, setVerifiedStatus] = useState<'ACTIVE' | 'NON-ACTIVE'>('NON-ACTIVE');
  const [isChecking, setIsChecking] = useState(false);
  const [checkStatus, setCheckStatus] = useState<'verified' | 'not_found' | 'idle'>('idle');
  const [amount, setAmount] = useState('15.00');
  const [note, setNote] = useState('');
  const [otp2fa, setOtp2fa] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  if (!isOpen) return null;

  const handleCheckMember = async () => {
    const query = recipientId.trim().toUpperCase();
    if (!query) {
      setErrorMsg('Masukkan ID Member (contoh: GN-00001).');
      return;
    }

    setIsChecking(true);
    setErrorMsg('');

    try {
      const found = await lookupMemberInDirectory(query);
      if (found) {
        setRecipientId(found.memberId);
        idempotencyKeyRef.current = null;
        setVerifiedName(found.username || '');
        setVerifiedStatus(found.accountStatus === 'active' ? 'ACTIVE' : 'NON-ACTIVE');
        setCheckStatus('verified');
      } else {
        setCheckStatus('not_found');
        setErrorMsg(`ID Member "${query}" tidak terdaftar di direktori GAIN.`);
      }
    } catch {
      setCheckStatus('not_found');
      setErrorMsg('Gagal memverifikasi ID member. Cek koneksi.');
    } finally {
      setIsChecking(false);
    }
  };

  const handleQuickPercent = (pct: number) => {
    const val = (availableBalance * pct) / 100;
    idempotencyKeyRef.current = null;
    setAmount(val.toFixed(2));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    const numAmount = parseFloat(amount) || 0;
    if (!recipientId) {
      setErrorMsg('Masukkan ID Member penerima.');
      return;
    }

    if (numAmount <= 0) {
      setErrorMsg('Masukkan jumlah transfer yang valid.');
      return;
    }

    if (numAmount > availableBalance) {
      setErrorMsg('Saldo vault tidak mencukupi untuk transfer ini.');
      return;
    }

    const cleanOtp = otp2fa.trim();
    if (cleanOtp.length !== 6 || !/^\d{6}$/.test(cleanOtp)) {
      setErrorMsg('Masukkan kode 6 digit Google Authenticator untuk transfer saldo P2P.');
      return;
    }

    setIsProcessing(true);

    try {
      const idempotencyKey = idempotencyKeyRef.current || (idempotencyKeyRef.current = crypto.randomUUID());
      // Call backend transfer API
      const data = await transferWalletFunds({
          recipientMemberId: recipientId,
          amount: numAmount,
          note: note.trim(),
          otp2fa: cleanOtp,
          userSecret,
          senderMemberId,
          idempotencyKey,
      });

      if (data.success) {
        idempotencyKeyRef.current = null;
        setIsProcessing(false);
        setIsSuccess(true);
        onTransferSuccess(
          data.recipientMemberId || recipientId,
          data.recipientName || verifiedName,
          numAmount
        );
        setTimeout(() => {
          setIsSuccess(false);
          onClose();
        }, 1400);
      } else {
        setIsProcessing(false);
        setErrorMsg(data.error || 'Gagal memproses transfer antar member.');
      }
    } catch (err: any) {
      setIsProcessing(false);
      setErrorMsg(err?.message || 'Koneksi jaringan terputus saat menghubungi server. Silakan periksa jaringan Anda dan coba lagi.');
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
              Transfer Antar Member
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
              0% Fee · Instant P2P Internal Ledger
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
          {/* Recipient Member ID with Check */}
          <div>
            <label className="block text-[11px] font-mono text-slate-700 dark:text-slate-400 mb-1.5 uppercase tracking-wider font-bold">
              ID Member Penerima
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Masukkan ID Member..."
                value={recipientId}
                onChange={(e) => { idempotencyKeyRef.current = null; setCheckStatus('idle'); setVerifiedName(''); setVerifiedStatus('NON-ACTIVE'); setRecipientId(e.target.value); }}
                className="flex-1 px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#09111E] border border-slate-300 dark:border-[#162740] font-mono text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 dark:focus:border-[#8DC63F] focus:ring-1 focus:ring-emerald-500"
              />
              <button
                type="button"
                onClick={handleCheckMember}
                className="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-[#0F1A2D] border border-slate-300 dark:border-[#1B3052] text-xs font-mono font-bold text-emerald-700 dark:text-[#8DC63F] hover:bg-slate-200 dark:hover:bg-[#14233A] transition"
              >
                {isChecking ? '...' : 'Cek'}
              </button>
            </div>

            {/* Recipient Verified Card */}
            {verifiedName && (
              <div className="mt-2 p-2.5 rounded-xl bg-slate-50 dark:bg-[#0B1527] border border-emerald-300 dark:border-[#8DC63F]/30 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-emerald-100 dark:bg-[#8DC63F]/10 text-emerald-700 dark:text-[#8DC63F] flex items-center justify-center font-bold text-xs">
                    {verifiedName[0].toUpperCase()}
                  </div>
                  <div>
                    <span className="font-black text-xs text-slate-900 dark:text-white">{verifiedName}</span>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono ml-1.5 font-semibold">({recipientId})</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border ${
                    verifiedStatus === 'ACTIVE'
                      ? 'bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-500/20'
                      : 'bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-500/20'
                  }`}>
                    {verifiedStatus}
                  </span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 dark:bg-[#8DC63F]/10 text-emerald-800 dark:text-[#8DC63F] border border-emerald-300 dark:border-[#8DC63F]/20 font-bold">
                    Terverifikasi
                  </span>
                </div>
              </div>
            )}

          </div>

          {/* Amount Transfer */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-mono text-slate-700 dark:text-slate-300 uppercase tracking-wider font-bold">
                Jumlah Transfer
              </label>
              <span className="text-[11px] text-slate-600 dark:text-slate-400 font-mono font-semibold">
                Saldo: {formatUsdt(availableBalance)} USDT
              </span>
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

            {/* Quick Chips */}
            <div className="grid grid-cols-5 gap-1.5 mt-2">
              {[25, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => handleQuickPercent(pct)}
                  className="py-1 rounded-lg bg-slate-100 dark:bg-[#0C1628] border border-slate-300 dark:border-[#172A46] text-[11px] font-mono font-medium text-slate-600 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-[#8DC63F] hover:border-emerald-500 dark:hover:border-[#8DC63F]/40 transition"
                >
                  {pct}%
                </button>
              ))}
              <button
                type="button"
                onClick={() => handleQuickPercent(100)}
                className="py-1 rounded-lg bg-emerald-100 dark:bg-[#8DC63F]/10 border border-emerald-300 dark:border-[#8DC63F]/30 text-[11px] font-mono text-emerald-800 dark:text-[#8DC63F] font-black hover:bg-emerald-200 dark:hover:bg-[#8DC63F]/20 transition"
              >
                MAX
              </button>
            </div>
          </div>

          {/* Transfer Note (Optional) */}
          <div>
            <label className="block text-[11px] font-mono text-slate-700 dark:text-slate-400 mb-1.5 uppercase tracking-wider font-bold">
              Catatan / Berita Transfer (Opsional)
            </label>
            <input
              type="text"
              placeholder="Contoh: Gas Pool Share / Settle"
              value={note}
              onChange={(e) => { idempotencyKeyRef.current = null; setNote(e.target.value); }}
              className="w-full px-3.5 py-2 rounded-xl bg-white dark:bg-[#09111E] border border-slate-300 dark:border-[#162740] text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 dark:focus:border-[#8DC63F] focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          {/* Google Authenticator / high-risk transaction verification */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-mono text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1.5 font-bold">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-[#8DC63F]" />
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
            <p className="text-[10px] text-slate-600 dark:text-slate-500 font-mono mt-1 font-medium">
              TOTP Google Authenticator diperlukan untuk otorisasi transaksi berisiko tinggi. Kode tidak dikirim lewat email.
            </p>
          </div>

          {/* Breakdown summary */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#070D17] border border-slate-200 dark:border-[#14233A] space-y-1.5 text-xs font-mono">
            <div className="flex justify-between text-slate-600 dark:text-slate-400">
              <span className="font-medium">Biaya Transfer Internal:</span>
              <span className="text-emerald-700 dark:text-emerald-400 font-bold">0.00 USDT (0% Gratis)</span>
            </div>
            <div className="flex justify-between text-slate-600 dark:text-slate-400">
              <span className="font-medium">Durasi:</span>
              <span className="text-emerald-700 dark:text-emerald-400 font-bold">Instan (Real-time Ledger)</span>
            </div>
            <div className="border-t border-slate-200 dark:border-[#132034] pt-2 flex justify-between items-baseline">
              <span className="text-slate-700 dark:text-slate-300 font-sans font-bold">Estimasi Diterima:</span>
              <span className="text-base font-black text-emerald-600 dark:text-[#8DC63F]">
                {formatUsdt(parseFloat(amount || '0'))} USDT
              </span>
            </div>
          </div>

          {errorMsg && (
            <div className="p-2.5 rounded-xl bg-red-100 dark:bg-red-500/10 border border-red-300 dark:border-red-500/20 text-red-700 dark:text-red-400 text-xs font-mono flex items-center gap-2 font-medium">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {isSuccess && (
            <div className="p-2.5 rounded-xl bg-emerald-100 dark:bg-emerald-500/20 border border-emerald-300 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-xs font-mono flex items-center gap-2 font-bold">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>Transfer Internal Berhasil Dikirimkan!</span>
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
              <Send className="w-4 h-4" />
              {isProcessing ? 'Mengirim...' : 'Konfirmasi & Kirim Saldo'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
