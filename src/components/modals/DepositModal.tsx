import { useLanguage } from '../../context/LanguageContext';
import { useEffect, useState } from 'react';
import { X, Copy, Check, AlertTriangle, Cpu, ShieldCheck, CheckCircle2, ArrowRight } from 'lucide-react';
import { verifyWalletDeposit } from '../../services/walletService';
import { getDepositPolicy, getDepositAddress } from '../../api/walletApi';
import QRCode from 'qrcode';

interface DepositModalProps {
  isOpen: boolean;
  onClose: () => void;
  onViewLedger?: () => void;
  onDepositSuccess?: (amount: number, target: 'gas' | 'vault', txHash: string) => Promise<void> | void;
  memberId?: string;
  userEmail?: string;
  customDepositAddress?: string;
}

export function DepositModal({
  isOpen,
  onClose,
  onViewLedger,
  onDepositSuccess,
  memberId,
  userEmail,
  customDepositAddress,
}: DepositModalProps) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);
  const [depositAmount, setDepositAmount] = useState('50.00');
  const [txHash, setTxHash] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifySuccess, setVerifySuccess] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [qrPayload, setQrPayload] = useState<string>('');
  const [depositPolicy, setDepositPolicy] = useState<{minimumAmount:number;maximumAmount:number;minimumConfirmations:number}|null>(null);
  const [resolvedDepositAddress, setResolvedDepositAddress] = useState('');

  const depositAddress = String(resolvedDepositAddress || customDepositAddress || '').trim();

  useEffect(() => {
    if (!isOpen || !depositAddress) { setQrDataUrl(''); setQrPayload(''); return; }
    const payload = String(qrPayload || depositAddress).trim();
    void QRCode.toDataURL(payload, { margin: 2, width: 480, errorCorrectionLevel: 'M' }).then(setQrDataUrl).catch(() => setQrDataUrl(''));
  }, [isOpen, depositAddress, qrPayload]);

  useEffect(() => {
    if (!isOpen) { setResolvedDepositAddress(''); setQrPayload(''); return; }
    const existing = String(customDepositAddress || '').trim();
    if (existing) { setResolvedDepositAddress(existing); setQrPayload(existing); return; }
    let active = true;
    void getDepositAddress().then((result:any) => {
      if (active && result?.address) {
        setResolvedDepositAddress(String(result.address));
        setQrPayload(String(result.qrPayload || result.address));
      }
    }).catch(() => { if (active) setResolvedDepositAddress(''); });
    return () => { active = false; };
  }, [isOpen, customDepositAddress]);

  useEffect(() => {
    if (!isOpen) return;
    let active=true;
    void getDepositPolicy().then((result:any)=>{
      if(active) setDepositPolicy({minimumAmount:Number(result.minimumAmount),maximumAmount:Number(result.maximumAmount),minimumConfirmations:Number(result.minimumConfirmations)});
    }).catch(()=>{
      if(active) setDepositPolicy(null);
    });
    return ()=>{active=false;};
  },[isOpen]);

  if (!isOpen) return null;

  const handleCopy = () => {
    if (!depositAddress) return;
    navigator.clipboard.writeText(depositAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePasteHash = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setTxHash(text.trim());
    } catch {
      setVerifyError(t('pasteTxHashHelp'));
    }
  };

  const handleVerifyOnChain = async () => {
    setVerifyError(null);
    setVerifySuccess(null);

    if (!depositAddress) { setVerifyError(t('dataUnavailable')); return; }
    if (!depositPolicy) { setVerifyError('Kebijakan deposit belum siap. Coba lagi setelah konfigurasi finansial aktif.'); return; }

    const numAmount = parseFloat(depositAmount);
    if (isNaN(numAmount) || numAmount < depositPolicy.minimumAmount || numAmount > depositPolicy.maximumAmount) {
      setVerifyError(`${t('minimum')} deposit: ${depositPolicy.minimumAmount}–${depositPolicy.maximumAmount} USDT.`);
      return;
    }

    if (!txHash || txHash.trim().length < 10) {
      setVerifyError(`${t('transactionHash')}: BSC / BEP-20`);
      return;
    }

    setIsVerifying(true);

    try {
      const data = await verifyWalletDeposit({
          txHash: txHash.trim(),
          network: 'BEP-20',
          amount: numAmount,
      });

      if (data.success) {
        setIsVerifying(false);
        if (data.status === 'CREDITED') {
          setVerifySuccess(`Terverifikasi di Blok #${data.blockNumber}. Saldo USDT utama telah dikreditkan.`);
        } else if (data.status === 'REJECTED') {
          setVerifySuccess('Transaksi dicatat tetapi tidak dikreditkan karena screening sumber memerlukan tindak lanjut. Hubungi dukungan.');
        } else {
          setVerifySuccess('Transaksi terverifikasi on-chain dan menunggu screening sumber. Saldo belum dikreditkan.');
        }

        if (data.status === 'CREDITED' && onDepositSuccess) {
          onDepositSuccess(numAmount, 'vault', data.txHash || txHash);
        }

        if (data.status === 'CREDITED') setTimeout(() => {
          if (onViewLedger) onViewLedger();
          onClose();
        }, 1800);
      } else {
        setIsVerifying(false);
        setVerifyError(data.error || 'Verifikasi transaksi on-chain gagal.');
      }
    } catch (error: any) {
      setIsVerifying(false);
      setVerifyError(error.message || 'Tidak dapat memverifikasi deposit. Saldo belum dikreditkan.');
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
              Deposit USDT (BEP-20)
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono font-medium">
              Algorithmic Settlement Vault Deposit
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-[#0F1A2D] border border-slate-200 dark:border-[#1A2D4A] flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto custom-scrollbar flex-1">
          {/* Network Selection Card */}
          <div>
            <label className="block text-[11px] font-mono text-slate-700 dark:text-slate-400 mb-1.5 uppercase tracking-wider font-bold">
              Pilihan Jaringan (Wajib Sama)
            </label>
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#0B1527] border border-emerald-300 dark:border-[#00F0C8]/40 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-amber-100 dark:bg-[#F0B90B]/10 border border-amber-300 dark:border-[#F0B90B]/30 flex items-center justify-center text-amber-700 dark:text-[#F0B90B] font-black text-xs">
                  BNB
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold text-sm text-slate-900 dark:text-white">BNB Smart Chain</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-100 dark:bg-[#8DC63F]/10 text-emerald-800 dark:text-[#8DC63F] border border-emerald-300 dark:border-[#8DC63F]/30 font-bold">
                      BEP-20
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-400 font-mono mt-0.5 font-medium">
                    Bridge: <span className="text-amber-700 dark:text-amber-400 font-bold">Status ditentukan server</span>
                  </p>
                </div>
              </div>
              <span className="px-2 py-1 rounded-md text-[10px] bg-emerald-100 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-500/20 font-bold">
                Server Config
              </span>
            </div>
          </div>

          {/* QR Code with Cyber Scanner Animation */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#070D17] border border-slate-200 dark:border-[#14233A] flex flex-col items-center justify-center">
            <div className="relative p-3 bg-white rounded-xl shadow-lg border-2 border-emerald-200 dark:border-[#8DC63F]/40 overflow-hidden">
              {/* Animated Scanner Laser */}
              <div className="scanner-line"></div>

              {qrDataUrl ? (
                <img src={qrDataUrl} alt="QR alamat deposit USDT" className="w-40 h-40 object-contain" />
              ) : (
                <div className="w-40 h-40 flex items-center justify-center text-center text-xs text-slate-500 font-medium px-4">{t('depositAddress')} {t('dataUnavailable')}</div>
              )}
            </div>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-2 font-mono font-medium">{depositAddress ? 'QR unik untuk address deposit BSC user ini' : 'QR tidak tersedia sebelum alamat deposit dikonfigurasi'}</p>
            {depositAddress && <div className="mt-1 text-[9px] text-emerald-700 dark:text-emerald-400/80 font-mono font-bold">USDT • BSC / BEP-20 • Chain ID 56</div>}
            {qrDataUrl && <a href={qrDataUrl} download="niagakoin-bsc-usdt-deposit-qr.png" className="mt-2 px-3 py-1.5 rounded-lg bg-emerald-100 dark:bg-emerald-500/10 border border-emerald-300 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-[10px] font-bold hover:bg-emerald-200 dark:hover:bg-emerald-500/20 transition cursor-pointer">Simpan QR</a>}
          </div>

          {/* Deposit Address Box */}
          <div>
            <label className="block text-[11px] font-mono text-slate-700 dark:text-slate-400 mb-1.5 uppercase tracking-wider font-bold">
              Alamat Deposit
            </label>
            <div className="p-2.5 rounded-xl bg-white dark:bg-[#09111E] border border-slate-300 dark:border-[#162740] flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-emerald-700 dark:text-[#8DC63F] break-all select-all font-medium">
                {depositAddress}
              </span>
              <button
                onClick={handleCopy}
                className="px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-[#8DC63F]/10 border border-emerald-300 dark:border-[#8DC63F]/30 text-emerald-700 dark:text-[#8DC63F] text-xs font-bold hover:bg-emerald-100 dark:hover:bg-[#8DC63F]/20 transition flex items-center gap-1.5 shrink-0 cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Tersalin' : 'Salin'}</span>
              </button>
            </div>
          </div>

          {/* Deposits always credit the authoritative main USDT wallet. */}
          <div className="space-y-3 pt-1 border-t border-slate-200 dark:border-[#14233A]">
            <div>
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-700 dark:text-slate-400 mb-1 font-bold">
                <span>{t('amount')} USDT</span>
                <span className="text-slate-500 dark:text-slate-500">{depositPolicy ? 'Min. ' + depositPolicy.minimumAmount + ' · Maks. ' + depositPolicy.maximumAmount + ' USDT' : 'Batas belum tersedia'}</span>
              </div>
              <div className="relative">
                <input
                  type="number"
                  step="any"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="50.00"
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#09111E] border border-slate-300 dark:border-[#162740] text-sm font-mono text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 dark:focus:border-[#8DC63F]"
                />
                <span className="absolute right-3 top-2.5 text-xs font-mono font-black text-emerald-700 dark:text-[#8DC63F]">USDT</span>
              </div>
            </div>

            {/* On-Chain TxID / Hash input */}
            <div>
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-700 dark:text-slate-400 mb-1 font-bold">
                <span>{t('transactionHash')}</span>
                <button
                  type="button"
                  onClick={handlePasteHash}
                  className="text-[10px] text-emerald-700 dark:text-[#8DC63F] hover:underline cursor-pointer font-bold"
                >
                  Tempel TxHash
                </button>
              </div>
              <input
                type="text"
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
                placeholder="Contoh: 0x4a8f9c2d1b... atau hash transfer dompet Anda"
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#09111E] border border-slate-300 dark:border-[#162740] text-xs font-mono text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 dark:focus:border-[#8DC63F]"
              />
            </div>

            {/* Verify Status Alerts */}
            {verifySuccess && (
              <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-300 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-xs font-mono flex items-start gap-2 font-medium">
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5" />
                <span className="leading-tight">{verifySuccess}</span>
              </div>
            )}

            {verifyError && (
              <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-500/15 border border-rose-300 dark:border-rose-500/30 text-rose-800 dark:text-rose-300 text-xs font-mono flex items-start gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400 mt-0.5" />
                <span>{verifyError}</span>
              </div>
            )}
          </div>

          {/* Security Notice */}
          <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-300 dark:border-amber-500/20 text-amber-800 dark:text-amber-300 text-xs space-y-1">
            <div className="flex items-center gap-1.5 font-bold">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span>{t('securityWarning')}</span>
            </div>
            <ul className="text-[11px] space-y-1 text-slate-700 dark:text-slate-300 pl-5 list-disc font-sans font-medium">
              <li>Setoran menunggu pemeriksaan sumber setelah dikonfirmasi on-chain; saldo belum langsung dikreditkan.</li>
              <li>{depositPolicy ? 'Memerlukan minimal ' + depositPolicy.minimumConfirmations + ' konfirmasi dan blok final jaringan.' : 'Kebijakan konfirmasi belum tersedia.'}</li>
              <li>Setiap deposit diproses oleh backend dan screening yang terkonfigurasi.</li>
            </ul>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 bg-slate-100 dark:bg-[#060B14] border-t border-slate-200 dark:border-[#142236] flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-400 font-mono font-bold">
            <Cpu className="w-3.5 h-3.5 text-emerald-700 dark:text-[#8DC63F]" />
            <span>On-Chain Settlement</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={isVerifying || !depositPolicy}
              className="px-3.5 py-2 rounded-xl bg-slate-200 dark:bg-[#0F1A2D] text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:text-white text-xs font-bold transition cursor-pointer"
            >
              Tutup
            </button>
            <button
              onClick={handleVerifyOnChain}
              disabled={isVerifying}
              className="px-4 py-2 rounded-xl bg-emerald-500 dark:bg-[#8DC63F] hover:bg-emerald-600 dark:hover:bg-[#7ab72f] text-white dark:text-slate-950 text-xs font-bold shadow-lg shadow-emerald-500/20 dark:shadow-[#8DC63F]/20 transition flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>{isVerifying ? 'Memverifikasi Blok...' : 'Verifikasi On-Chain'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
