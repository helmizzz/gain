import { useMemo, useState, useEffect } from 'react';
import {
  X,
  Key,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Lock,
  ExternalLink,
  RefreshCw,
  Zap,
  Check,
  Copy,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  Unlink,
  Sparkles,
  BookOpen,
  ArrowUpRight,
  Info,
  Layers,
  FlaskConical,
} from 'lucide-react';
import { ExchangeName } from '../../types';
import { SUPPORTED_COINS } from '../../data/appData';
import { getExchangeDescriptor, getExchangeNames } from '../../config/exchangeRegistry';
import { verifyExchangeConnection, certifyExchangeApi } from '../../services/exchangeService';
import { getExchangeCredentialHistory } from '../../api/botApi';
import ExchangeCertificationPanel from '../common/ExchangeCertificationPanel';

interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentExchange: ExchangeName;
  connectedExchange?: import('../../types').ConnectedExchangeConfig;
  connectedExchanges?: import('../../types').ConnectedExchangeConfig[];
  isAccountActive?: boolean;
  onOpenActivationModal?: () => void;
  onSelectActiveExchange?: (exchange: ExchangeName) => void;
  onDisconnectApi?: ((exchange?: ExchangeName) => void) | (() => void);
  onConnectSuccess?: (
    exchange: ExchangeName,
    balance: number,
    isSandbox: boolean,
    apiKey: string,
    secret?: string,
    passphrase?: string,
    portfolioAssets?: Array<{
      coin: string;
      pair: string;
      total: number;
      price: number;
      change24h: number;
      valueUsdt: number;
    }>,
    totalPortfolioUsdt?: number,
    snapshotMeta?: {
      usdtAvailable?: number;
      usdtTotalBalance?: number;
      rawAssetCount?: number;
      unvaluedDefaultAssetCount?: number;
      valuationScope?: 'DEFAULT_12_COINS';
    }
  ) => void | Promise<void>;
}

interface TestnetGuideInfo {
  exchange: ExchangeName;
  portalUrl: string;
  portalName: string;
  badge: string;
  hasOfficialTestnet: boolean;
  instructions: string[];
  faucetInfo: string;
  recommendationNote?: string;
}

const TESTNET_GUIDES: Record<string, TestnetGuideInfo> = {
  Binance: {
    exchange: 'Binance',
    portalUrl: 'https://demo.binance.com',
    portalName: 'Binance Spot Demo Trading & Testnet Vision',
    badge: 'Spot Demo Mode (demo-api) & Testnet Vision',
    hasOfficialTestnet: true,
    instructions: [
      'PENTING: GAIN adalah bot SPOT TRADING (Averaging + Grid Spot). Pastikan API Key dibuat dari menu SPOT, BUKAN Derivatives / Futures Mock Trading.',
      'Opsi 1 (Spot Demo Mode - Rekomendasi): Login ke akun Binance -> buka menu "Demo Trading" (demo.binance.com) -> API Management -> Buat API Key Spot (endpoint: demo-api.binance.com).',
      'Opsi 2 (Spot Testnet Vision): Buka testnet.binance.vision -> "Log In with GitHub" -> "Generate HMAC_SHA256 Key" (endpoint: testnet.binance.vision).',
      'Centang izin hak akses "Enable Reading" dan "Enable Spot & Margin Trading".',
      'PENTING: Pilih opsi IP "Unrestricted" pada pengaturan API bursa jika server berjalan di komputer lokal (jangan whitelist IP node cloud).',
      'GAIN memprioritaskan Spot Demo Mode secara otomatis dengan fallback cerdas ke Testnet Vision.',
    ],
    faucetInfo: 'Saldo virtual demo USDT otomatis tersedia dan dapat direset kapan saja di dashboard Spot Demo Trading Binance.',
  },
  'Bybit Indonesia': {
    exchange: 'Bybit Indonesia',
    portalUrl: 'https://testnet.bybit.com',
    portalName: 'Bybit Testnet Unified Trading Portal',
    badge: 'API V5 Modern & Faucet Mandiri',
    hasOfficialTestnet: true,
    instructions: [
      'Akses portal khusus Bybit Testnet di testnet.bybit.com dan buat akun baru (terpisah dari mainnet).',
      'Masuk ke menu Profil -> "API Management" -> Klik tombol "Create New Key".',
      'Pilih tipe "System-generated API Keys", centang izin "Read-Write" dan "Spot Trading".',
      'Pastikan opsi "Withdrawal" TIDAK dicentang demi keamanan.',
      'Salin API Key dan API Secret ke form GAIN, lalu klaim saldo simulasi gratis pada menu Assets Bybit Testnet.',
    ],
    faucetInfo: 'Dapat mengklaim saldo dummy USDT berkala di menu Assets -> Claim Test Coins.',
  },
  Bybit: {
    exchange: 'Bybit Indonesia',
    portalUrl: 'https://testnet.bybit.com',
    portalName: 'Bybit Testnet Unified Trading Portal',
    badge: 'API V5 Modern & Faucet Mandiri',
    hasOfficialTestnet: true,
    instructions: [
      'Akses portal khusus Bybit Testnet di testnet.bybit.com dan buat akun baru (terpisah dari mainnet).',
      'Masuk ke menu Profil -> "API Management" -> Klik tombol "Create New Key".',
      'Pilih tipe "System-generated API Keys", centang izin "Read-Write" dan "Spot Trading".',
      'Pastikan opsi "Withdrawal" TIDAK dicentang demi keamanan.',
      'Salin API Key dan API Secret ke form GAIN, lalu klaim saldo simulasi gratis pada menu Assets Bybit Testnet.',
    ],
    faucetInfo: 'Dapat mengklaim saldo dummy USDT berkala di menu Assets -> Claim Test Coins.',
  },
  Bitget: {
    exchange: 'Bitget',
    portalUrl: 'https://www.bitget.com',
    portalName: 'Bitget Testnet / Sandbox Trading',
    badge: 'Testnet / Sandbox dengan Passphrase',
    hasOfficialTestnet: true,
    instructions: [
      'Login ke akun Bitget Anda di bitget.com.',
      'Arahkan ke ikon Profil -> pilih menu "API Management" -> "Create API Key".',
      'Wajib membuat "Passphrase API" (ingat kata sandi ini karena dibutuhkan untuk verifikasi di GAIN).',
      'Centang izin "Read-Write" dan "Spot Trading".',
      'Pilih Testnet di GAIN agar request diarahkan ke endpoint Testnet/Sandbox exchange.',
    ],
    faucetInfo: 'Gunakan lingkungan Testnet/Sandbox resmi exchange; GAIN hanya meneruskan order dan membaca hasilnya.',
  },
  OKX: {
    exchange: 'OKX',
    portalUrl: 'https://www.okx.com',
    portalName: 'OKX Testnet / Sandbox Trading',
    badge: 'Sandbox Header V5',
    hasOfficialTestnet: true,
    instructions: [
      'Login ke portal OKX di okx.com, klik avatar profil dan aktifkan "Demo Trading" (Simulated Trading).',
      'Buka menu API Keys -> pilih "Create V5 API Key".',
      'Tentukan Passphrase API khusus untuk koneksi bot.',
      'Beri izin hak akses "Read" dan "Trade" (Spot).',
      'GAIN secara otomatis menyematkan header "x-simulated-trading: 1" untuk mengeksekusi order demo tanpa risiko.',
    ],
    faucetInfo: 'OKX menyediakan saldo demo ratusan ribu USDT di dashboard Simulated Trading.',
  },
  Tokocrypto: {
    exchange: 'Tokocrypto',
    portalUrl: 'https://www.tokocrypto.com',
    portalName: 'Tokocrypto API Portal',
    badge: 'Lokal Indonesia • Spot Trading Native API',
    hasOfficialTestnet: false,
    instructions: [
      'Login ke akun Tokocrypto Anda di tokocrypto.com dan akses menu API Management.',
      'Buat API Key baru untuk GAIN dengan izin akses "Read" dan "Trade" (Spot).',
      'Pastikan permission Withdrawal tetap TIDAK aktif demi keamanan.',
      'Salin API Key dan Secret Key yang diterbitkan ke dalam form GAIN.',
    ],
    faucetInfo: 'Gunakan saldo riil atau lingkungan pengujian Spot Tokocrypto.',
    recommendationNote: 'Adapter Tokocrypto menggunakan API Native resmi Tokocrypto untuk market data dan eksekusi order.',
  },
  Indodax: {
    exchange: 'Indodax',
    portalUrl: 'https://indodax.com',
    portalName: 'Indodax API Portal',
    badge: 'Lokal Indonesia • Spot Trading Native API',
    hasOfficialTestnet: false,
    instructions: [
      'Login ke akun Indodax Anda di indodax.com dan buka menu Pengaturan API.',
      'Buat API Key baru untuk GAIN dengan izin Info Akun dan Trading Spot.',
      'Pastikan izin Penarikan (Withdrawal) TIDAK dicentang.',
      'Salin Key & Secret Key Indodax Anda ke form GAIN.',
    ],
    faucetInfo: 'Indodax tidak menyediakan public testnet; order dieksekusi langsung pada API Spot Indodax.',
    recommendationNote: 'Adapter Indodax mendukung saldo IDR/USDT dan eksekusi order spot native.',
  },
  Reku: {
    exchange: 'Reku',
    portalUrl: 'https://reku.id',
    portalName: 'Reku Market Data Portal',
    badge: 'Bursa Lokal Indonesia • Data Pasar Publik (Read-Only)',
    hasOfficialTestnet: false,
    instructions: [
      'Reku terdaftar di GAIN sebagai bursa data pasar publik resmi.',
      'Tidak memerlukan pembuatan atau input API Key privat.',
      'Klik tombol "Jalankan Certification" di bawah untuk memverifikasi kestabilan harga dan ticker publik Reku.',
    ],
    faucetInfo: 'Fitur eksekusi order otomatis untuk Reku saat ini dibatasi (read-only) menunggu ketersediaan adapter trading native resmi.',
    recommendationNote: 'Dapat digunakan untuk membaca tren harga pasar lokal dan perbandingan ticker IDR.',
  },
  Bittime: {
    exchange: 'Bittime',
    portalUrl: 'https://bittime.com',
    portalName: 'Bittime Official Portal',
    badge: 'Bursa Terdaftar Bappebti • Menunggu Native API',
    hasOfficialTestnet: false,
    instructions: [
      'Bittime terdaftar dalam registry bursa kripto resmi Indonesia di GAIN.',
      'Saat ini akses trading dibatasi (BLOCKED_PENDING_NATIVE_API) menunggu dokumentasi kontrak API resmi.',
      'Tidak memerlukan input API Key privat.',
    ],
    faucetInfo: 'Gunakan Binance, Bybit, Indodax, Tokocrypto, OKX, atau Bitget untuk eksekusi trading bot aktif.',
    recommendationNote: 'Akses trading otomatis akan dibuka setelah audit adapter API native selesai.',
  },
  'Pintu Pro': {
    exchange: 'Pintu Pro',
    portalUrl: 'https://pintu.co.id',
    portalName: 'Pintu Pro Official Portal',
    badge: 'Bursa Terdaftar Bappebti • Menunggu Native API',
    hasOfficialTestnet: false,
    instructions: [
      'Pintu Pro terdaftar dalam registry bursa kripto resmi Indonesia di GAIN.',
      'Saat ini akses trading dibatasi (BLOCKED_PENDING_NATIVE_API) menunggu dokumentasi kontrak API resmi.',
      'Tidak memerlukan input API Key privat.',
    ],
    faucetInfo: 'Gunakan Binance, Bybit, Indodax, Tokocrypto, OKX, atau Bitget untuk eksekusi trading bot aktif.',
    recommendationNote: 'Akses trading otomatis akan dibuka setelah audit adapter API native selesai.',
  },
  Triv: {
    exchange: 'Triv',
    portalUrl: 'https://triv.co.id',
    portalName: 'Triv Official Portal',
    badge: 'Bursa Terdaftar Bappebti • Menunggu Native API',
    hasOfficialTestnet: false,
    instructions: [
      'Triv terdaftar dalam registry bursa kripto resmi Indonesia di GAIN.',
      'Saat ini akses trading dibatasi (BLOCKED_PENDING_NATIVE_API) menunggu dokumentasi kontrak API resmi.',
      'Tidak memerlukan input API Key privat.',
    ],
    faucetInfo: 'Gunakan Binance, Bybit, Indodax, Tokocrypto, OKX, atau Bitget untuk eksekusi trading bot aktif.',
    recommendationNote: 'Akses trading otomatis akan dibuka setelah audit adapter API native selesai.',
  },
};

const ALL_EXCHANGES: ExchangeName[] = getExchangeNames();

export function ApiKeyModal({
  isOpen,
  onClose,
  currentExchange: initialExchange,
  connectedExchange,
  onDisconnectApi,
  onConnectSuccess,
}: ApiKeyModalProps) {
  const [exchange, setExchange] = useState<ExchangeName>(initialExchange || 'Binance');
  // Mode switcher: 'live' or 'testnet'
  const [connectionMode, setConnectionMode] = useState<'live' | 'testnet'>(
    connectedExchange?.isSandbox ? 'testnet' : 'testnet'
  );
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [binanceEnvChoice, setBinanceEnvChoice] = useState<'demo' | 'vision'>('demo');

  // Guide accordion state
  const [isGuideOpen, setIsGuideOpen] = useState(true);
  const [selectedGuideEx, setSelectedGuideEx] = useState<ExchangeName>(initialExchange || 'Binance');

  const [isLoading, setIsLoading] = useState(false);
  const [isApplyingConnection, setIsApplyingConnection] = useState(false);
  const [credentialHistory, setCredentialHistory] = useState<Array<{ action: string; new_version?: number; previous_version?: number; created_at?: string; sandbox?: boolean }>>([]);
  const [connectionPopup, setConnectionPopup] = useState<{
    success: boolean;
    title: string;
    message: string;
  } | null>(null);
  const [loadingStep, setLoadingStep] = useState('Memverifikasi Signature...');
  const [showSpeedTip, setShowSpeedTip] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    binanceSandboxEnv?: 'demo' | 'vision';
    latencyMs?: number;
    usdtAvailable?: number;
    totalPortfolioUsdt?: number;
    usdtTotalBalance?: number;
    portfolioAssets?: Array<{
      coin: string;
      pair: string;
      total: number;
      price: number;
      change24h: number;
      valueUsdt: number;
    }>;
    error?: string;
  } | null>(null);

  const [copiedIp, setCopiedIp] = useState(false);

  const defaultConnectionAssets = useMemo(() => {
    const rawAssets = Array.isArray(testResult?.portfolioAssets) ? testResult.portfolioAssets : [];
    const byCoin = new Map(rawAssets.map((asset) => [String(asset.coin || '').toUpperCase(), asset] as const));
    return SUPPORTED_COINS
      .map((coin) => byCoin.get(coin.coin.toUpperCase()))
      .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset && Number(asset.total) > 0));
  }, [testResult?.portfolioAssets]);

  if (!isOpen) return null;

  const isSandbox = connectionMode === 'testnet';
  const exchangeDescriptor = getExchangeDescriptor(exchange);
  const isPublicOnly = Boolean(exchangeDescriptor?.publicOnly);
  const certificationBlocked = exchangeDescriptor?.certificationMode === 'BLOCKED_PENDING_NATIVE_API';
  const requiresPassphrase = exchangeDescriptor?.requiresPassphrase ?? (exchange === 'Bitget' || exchange === 'OKX');
  const currentGuide = TESTNET_GUIDES[selectedGuideEx] || TESTNET_GUIDES.Binance;

  useEffect(() => {
    if (exchangeDescriptor && !exchangeDescriptor.hasOfficialSandbox && connectionMode === 'testnet') {
      setConnectionMode('live');
    }
  }, [exchange, exchangeDescriptor, connectionMode]);

  const handleCopyIp = () => {
    navigator.clipboard.writeText('142.250.180.14, 172.217.16.206');
    setCopiedIp(true);
    setTimeout(() => setCopiedIp(false), 2000);
  };



  const handleDisconnect = () => {
    if (onDisconnectApi) {
      onDisconnectApi();
      setDisconnectConfirm(false);
      setApiKey('');
      setApiSecret('');
      setPassphrase('');
      setTestResult({
        success: true,
        message: 'Koneksi API berhasil diputuskan. Kredensial telah dihapus dari sistem.',
      });
    }
  };

  const handleTestConnection = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    const cleanApiKey = apiKey.trim().replace(/[\u200B-\u200D\uFEFF\r\n\t]/g, '');
    const cleanSecret = apiSecret.trim().replace(/[\u200B-\u200D\uFEFF\r\n\t]/g, '');
    const cleanPassphrase = passphrase.trim().replace(/[\u200B-\u200D\uFEFF\r\n\t]/g, '');

    if (isPublicOnly) {
      setIsLoading(true);
      setLoadingStep(`Menjalankan certification API publik ${exchange}...`);
      setTestResult(null);
      setConnectionPopup(null);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      try {
        const data = await certifyExchangeApi(exchange.toLowerCase(), controller.signal);
        setTestResult({
          success: Boolean(data.success),
          message: data.success ? `${exchange} public API certification PASS` : `${exchange} certification BLOCKED`,
          latencyMs: data.latencyMs,
          usdtAvailable: data.sample && data.sample.quoteCurrency === 'USDT' ? undefined : undefined,
          totalPortfolioUsdt: undefined,
          error: data.success ? data.note : data.note || 'Native API belum terverifikasi.',
        });
        setConnectionPopup({
          success: Boolean(data.success),
          title: data.success ? `Certification ${exchange} PASS` : `Certification ${exchange} BLOCKED`,
          message: data.note || (data.success ? 'Read-only certification berhasil.' : 'Native API belum terverifikasi.'),
        });
      } catch (err: any) {
        const message = err?.name === 'AbortError' ? 'Certification timeout.' : String(err?.message || 'Gagal menjalankan certification.');
        setTestResult({ success: false, message: 'Certification gagal', error: message });
      } finally {
        clearTimeout(timeoutId);
        setIsLoading(false);
      }
      return;
    }

    if (!cleanApiKey || !cleanSecret) {
      const message = 'Lengkapi API Key dan Secret Key terlebih dahulu.';
      setTestResult({
        success: false,
        message,
        error: 'API Key dan Secret Key tidak boleh kosong.',
      });
      setConnectionPopup({ success: false, title: 'Koneksi API gagal', message });
      return;
    }

    if (requiresPassphrase && !cleanPassphrase) {
      const message = `Exchange ${exchange} memerlukan Passphrase API.`;
      setTestResult({
        success: false,
        message,
        error: 'Passphrase wajib diisi untuk Bitget dan OKX.',
      });
      setConnectionPopup({ success: false, title: 'Koneksi API gagal', message });
      return;
    }

    setIsLoading(true);
    setLoadingStep(
      isSandbox
        ? 'Menghubungkan ke Testnet/Sandbox Environment...'
        : 'Mengirim Signature HMAC-SHA256 ke Mainnet...'
    );
    setTestResult(null);
    setConnectionPopup(null);

    const stepTimer1 = setTimeout(() => {
      setLoadingStep('Bursa Memvalidasi Signature & Hak Akses Spot...');
    }, 1200);

    const stepTimer2 = setTimeout(() => {
      setLoadingStep('Membaca Saldo & Valuasi Portofolio Multi-Aset...');
    }, 2800);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 18000);

    try {
      const data = await verifyExchangeConnection({
          exchange: exchange.toLowerCase(),
          apiKey: cleanApiKey,
          secret: cleanSecret,
          password: cleanPassphrase || undefined,
          isSandbox,
          binanceSandboxEnv: exchange === 'Binance' && isSandbox ? binanceEnvChoice : undefined,
        }, controller.signal);

      clearTimeout(timeoutId);

      if (data.success) {
        if (data.binanceSandboxEnv === 'demo' || data.binanceSandboxEnv === 'vision') {
          setBinanceEnvChoice(data.binanceSandboxEnv);
        }
        setTestResult({
          success: true,
          message: data.message,
          binanceSandboxEnv: data.binanceSandboxEnv || (exchange === 'Binance' && isSandbox ? binanceEnvChoice : undefined),
          latencyMs: data.latencyMs,
          usdtAvailable: data.usdtAvailable,
          totalPortfolioUsdt: data.totalPortfolioUsdt,
          usdtTotalBalance: data.usdtTotalBalance ?? data.usdtBalance,
          portfolioAssets: data.portfolioAssets,
        });
      } else {
        const message = data.error || 'Gagal terhubung ke exchange.';
        setTestResult({
          success: false,
          message: 'Koneksi API Gagal Terverifikasi',
          error: message,
          latencyMs: data.latencyMs,
        });
        setConnectionPopup({
          success: false,
          title: `Koneksi ${isSandbox ? 'Demo' : 'Live'} gagal`,
          message,
        });
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        const message = 'Bursa tidak merespons dalam 18 detik. Periksa mode Demo/Live dan koneksi internet.';
        setTestResult({
          success: false,
          message: 'Waktu Verifikasi Timeout (18 detik)',
          error: message,
        });
        setConnectionPopup({
          success: false,
          title: `Koneksi ${isSandbox ? 'Demo' : 'Live'} gagal`,
          message,
        });
      } else {
        const message = err.message || 'Gagal memverifikasi koneksi exchange.';
        const failureTitle = message.includes('Passphrase')
          ? 'Verifikasi Passphrase Gagal'
          : /econnreset|network|jaringan/i.test(message)
          ? 'Koneksi Terputus (ECONNRESET)'
          : message.includes('API Key')
          ? 'Kredensial API Tidak Valid'
          : 'Gagal Menghubungkan Exchange';

        setTestResult({
          success: false,
          message: failureTitle,
          error: message,
        });
        setConnectionPopup({
          success: false,
          title: `Koneksi ${isSandbox ? 'Demo' : 'Live'} gagal`,
          message,
        });
      }
    } finally {
      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);
      clearTimeout(timeoutId);
      setIsLoading(false);
    }
  };

  const loadCredentialHistory = async () => {
    try {
      const result = await getExchangeCredentialHistory(exchange.toLowerCase());
      if (Array.isArray(result.history)) setCredentialHistory(result.history);
    } catch {
      setCredentialHistory([]);
    }
  };

  const handleApplyConnection = async () => {
    if (!testResult?.success) return;
    if (!onConnectSuccess) {
      setConnectionPopup({
        success: false,
        title: 'Koneksi belum tersimpan',
        message: 'Aksi simpan koneksi belum tersedia. Silakan coba lagi.',
      });
      return;
    }

    setIsApplyingConnection(true);
    try {
      await onConnectSuccess(
        exchange,
        testResult.usdtTotalBalance ?? testResult.totalPortfolioUsdt ?? testResult.usdtAvailable ?? 0,
        isSandbox,
        apiKey,
        apiSecret,
        passphrase,
        testResult.portfolioAssets,
        testResult.totalPortfolioUsdt,
        {
          usdtAvailable: testResult.usdtAvailable,
          usdtTotalBalance: testResult.usdtTotalBalance ?? testResult.totalPortfolioUsdt,
          rawAssetCount: testResult.portfolioAssets?.length,
          unvaluedDefaultAssetCount: 0,
          valuationScope: 'DEFAULT_12_COINS',
        }
      );
      await loadCredentialHistory();
      setConnectionPopup({
        success: true,
        title: 'Exchange berhasil dihubungkan',
        message: `${exchange} berhasil diverifikasi dan disinkronkan dalam mode ${isSandbox ? 'Demo' : 'Live'}.`,
      });
    } catch (error: any) {
      setConnectionPopup({
        success: false,
        title: 'Gagal menyimpan koneksi',
        message: error?.message || `Kredensial terverifikasi, tetapi sinkronisasi mode ${isSandbox ? 'Demo' : 'Live'} gagal.`,
      });
    } finally {
      setIsApplyingConnection(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 dark:bg-slate-950/85 backdrop-blur-md animate-fadeIn">
      <div className="theme-modal-shell relative w-full max-w-xl bg-white dark:bg-[#080E1A] border border-slate-200 dark:border-[#162740] rounded-2xl shadow-2xl overflow-hidden text-slate-900 dark:text-slate-100 max-h-[94vh] flex flex-col">
        {/* Top Hardware Notch */}
        <div className="w-full flex justify-center pt-2 pb-1 bg-slate-100 dark:bg-[#060B14]">
          <div className="w-16 h-1 rounded-full bg-slate-300 dark:bg-[#18263B]"></div>
        </div>

        {/* Modal Header */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-[#14233A] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-[#8DC63F]/10 text-emerald-700 dark:text-[#8DC63F] flex items-center justify-center border border-emerald-300 dark:border-[#8DC63F]/20">
              <Key className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-extrabold text-base text-slate-900 dark:text-white tracking-wide flex items-center gap-2">
                <span>Koneksi API Exchanger</span>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider border ${
                    connectionMode === 'testnet'
                      ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-500/30'
                      : 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30'
                  }`}
                >
                  {isPublicOnly ? (certificationBlocked ? 'Certification Blocked' : 'Read-only API') : (connectionMode === 'testnet' ? 'Testnet / Demo' : 'Live Real Spot')}
                </span>
              </h3>
              <p className="text-[11px] text-slate-600 dark:text-slate-400 font-mono font-medium">
                Trading Bot Non-Kustodian • Dana Tersimpan Aman di Bursa Anda
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-[#0F1A2D] border border-slate-200 dark:border-[#1A2D4A] flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleTestConnection} className="p-5 space-y-4 overflow-y-auto custom-scrollbar flex-1">
          {/* MODE SWITCHER: Live vs Testnet/Demo */}
          {!isPublicOnly && <div>
            <label className="block text-[11px] font-mono text-slate-700 dark:text-slate-400 mb-1.5 uppercase tracking-wider font-bold">
              Pilih Lingkungan Akun (Mode Operasi)
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!exchangeDescriptor?.hasOfficialSandbox}
                onClick={() => {
                  if (!exchangeDescriptor?.hasOfficialSandbox) return;
                  setConnectionMode('testnet');
                  setTestResult(null);
                  setConnectionPopup(null);
                }}
                className={`p-3 rounded-xl border transition text-left flex items-start gap-2.5 ${
                  !exchangeDescriptor?.hasOfficialSandbox
                    ? 'opacity-40 cursor-not-allowed bg-slate-100 dark:bg-[#070d18] border-slate-200 dark:border-slate-800 text-slate-400'
                    : connectionMode === 'testnet'
                    ? 'bg-gradient-to-br from-amber-50 dark:from-amber-500/15 to-amber-100 dark:to-amber-950/20 border-amber-300 dark:border-amber-400/50 shadow-sm shadow-amber-500/10 cursor-pointer'
                    : 'bg-white dark:bg-[#09111E] border-slate-300 dark:border-[#162740] hover:border-slate-400 dark:hover:border-slate-700 text-slate-600 dark:text-slate-400 cursor-pointer'
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                    !exchangeDescriptor?.hasOfficialSandbox
                      ? 'bg-slate-200 dark:bg-slate-800 text-slate-400'
                      : connectionMode === 'testnet'
                      ? 'bg-amber-100 dark:bg-amber-400/20 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-400/30'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                  }`}
                >
                  <FlaskConical className="w-3.5 h-3.5" />
                </div>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`font-bold text-xs ${
                        !exchangeDescriptor?.hasOfficialSandbox
                          ? 'text-slate-400'
                          : connectionMode === 'testnet' ? 'text-amber-800 dark:text-amber-200' : 'text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      Testnet / Sandbox
                    </span>
                    {!exchangeDescriptor?.hasOfficialSandbox ? (
                      <span className="px-1.5 py-0.2 rounded text-[9px] font-mono bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-bold">
                        Tidak Didukung
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.2 rounded text-[9px] font-mono bg-amber-200 dark:bg-amber-400/20 text-amber-800 dark:text-amber-300 font-bold">
                        Bebas Risiko
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-600 dark:text-slate-400 mt-0.5 leading-snug font-medium">
                    {!exchangeDescriptor?.hasOfficialSandbox
                      ? `${exchangeDescriptor?.name || exchange} tidak memiliki environment Sandbox resmi. Hubungkan akun Live API.`
                      : 'Order nyata dikirim ke endpoint Testnet/Sandbox exchange yang terhubung; tidak ada simulator internal GAIN.'}
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setConnectionMode('live');
                  setTestResult(null);
                  setConnectionPopup(null);
                }}
                className={`p-3 rounded-xl border transition text-left cursor-pointer flex items-start gap-2.5 ${
                  connectionMode === 'live'
                    ? 'bg-gradient-to-br from-emerald-50 dark:from-[#8DC63F]/15 to-emerald-100 dark:to-emerald-950/20 border-emerald-300 dark:border-[#8DC63F]/60 shadow-sm shadow-emerald-500/10'
                    : 'bg-white dark:bg-[#09111E] border-slate-300 dark:border-[#162740] hover:border-slate-400 dark:hover:border-slate-700 text-slate-600 dark:text-slate-400'
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                    connectionMode === 'live'
                      ? 'bg-emerald-100 dark:bg-[#8DC63F]/20 text-emerald-700 dark:text-[#8DC63F] border border-emerald-300 dark:border-[#8DC63F]/40'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                  }`}
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                </div>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`font-bold text-xs ${
                        connectionMode === 'live' ? 'text-emerald-800 dark:text-[#8DC63F]' : 'text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      Akun Riil (Live Spot)
                    </span>
                    <span className="px-1.5 py-0.2 rounded text-[9px] font-mono bg-emerald-200 dark:bg-emerald-400/20 text-emerald-800 dark:text-emerald-300 font-bold">
                      Live Real
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-600 dark:text-slate-400 mt-0.5 leading-snug font-medium">
                    Koneksi bursa live untuk eksekusi order spot nyata dengan saldo aset asli Anda.
                  </p>
                </div>
              </button>
            </div>
          </div>}

          {/* Active Connected API Status Banner */}
          {connectedExchange?.isConnected && (
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#091626] border border-slate-200 dark:border-[#163352] space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-500/10 border border-emerald-300 dark:border-emerald-500/30 flex items-center justify-center text-emerald-700 dark:text-emerald-400 shrink-0">
                    <CheckCircle2 className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-bold text-xs text-slate-900 dark:text-white">
                        API {connectedExchange.exchange} Terhubung
                      </span>
                      <span
                        className={`px-1.5 py-0.2 rounded text-[9px] font-mono border ${
                          connectedExchange.isSandbox
                            ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-500/30'
                            : 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30'
                        }`}
                      >
                        {connectedExchange.isSandbox ? 'Testnet / Demo' : 'Live Spot'}
                      </span>
                    </div>
                    <p className="text-[10.5px] text-slate-600 dark:text-slate-400 font-mono mt-0.5 font-medium">
                      Key: {connectedExchange.apiKeyMasked} • Saldo: {connectedExchange.usdtBalance.toFixed(2)} USDT
                    </p>
                    {connectedExchange.identityHint && (
                      <p className="text-[9.5px] text-slate-500 font-mono mt-0.5 font-medium">
                        Exchange Account: {connectedExchange.identityHint} · Credential v{connectedExchange.credentialVersion || 1} · {connectedExchange.credentialStatus || 'ACTIVE'}
                      </p>
                    )}
                  </div>
                </div>

                {!disconnectConfirm ? (
                  <button
                    type="button"
                    onClick={() => setDisconnectConfirm(true)}
                    className="px-2.5 py-1.5 rounded-lg bg-red-100 dark:bg-red-500/10 hover:bg-red-200 dark:hover:bg-red-500/20 text-red-700 dark:text-red-400 border border-red-300 dark:border-red-500/30 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer shrink-0"
                  >
                    <Unlink className="w-3.5 h-3.5" />
                    <span>Putuskan API</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={handleDisconnect}
                      className="px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition cursor-pointer shadow-sm animate-pulse"
                    >
                      Ya, Putuskan
                    </button>
                    <button
                      type="button"
                      onClick={() => setDisconnectConfirm(false)}
                      className="px-2 py-1.5 rounded-lg bg-slate-200 dark:bg-[#0F1A2D] text-slate-700 dark:text-slate-300 text-xs hover:bg-slate-300 dark:hover:text-white font-bold cursor-pointer"
                    >
                      Batal
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {connectedExchange?.isConnected && (
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-[#132A43] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-600 dark:text-slate-400 font-bold">Riwayat Credential API</span>
                <button type="button" onClick={() => void loadCredentialHistory()} className="text-[10px] text-emerald-700 dark:text-[#8DC63F] hover:underline font-mono font-bold">Refresh</button>
              </div>
              {credentialHistory.length === 0 ? (
                <p className="text-[10px] text-slate-500 font-mono">Belum ada riwayat rotasi credential pada sesi ini.</p>
              ) : (
                <div className="space-y-1.5 max-h-28 overflow-auto">
                  {credentialHistory.slice(0, 5).map((item, index) => (
                    <div key={`${item.created_at || index}-${item.new_version || index}`} className="flex items-center justify-between gap-2 text-[10px] font-mono">
                      <span className="text-slate-700 dark:text-slate-300 font-medium">{item.action === 'ROTATED' ? 'API diganti' : item.action === 'RECONNECTED' ? 'API tersambung kembali' : 'API terhubung'} · v{item.new_version || 1}</span>
                      <span className="text-slate-500">{item.created_at ? new Date(item.created_at).toLocaleString() : '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Exchange Switcher (All 6 Top Exchanges) */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-mono text-slate-700 dark:text-slate-400 uppercase tracking-wider font-bold">
                Pilih Target Bursa Kripto
              </label>
              <span className="text-[10px] text-emerald-700 dark:text-[#8DC63F] font-mono font-bold">
                {exchange === 'Binance' || (exchange as string).includes('Bybit')
                  ? '⭐ Bursa Rekomendasi Testnet'
                  : 'Multi-Exchange Ready'}
              </span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {ALL_EXCHANGES.map((ex) => (
                <button
                  type="button"
                  key={ex}
                  onClick={() => {
                    setExchange(ex);
                    setSelectedGuideEx(ex);
                    setTestResult(null);
                    setConnectionPopup(null);
                  }}
                  className={`py-2 px-2 rounded-xl border text-center transition cursor-pointer flex flex-col items-center justify-center gap-0.5 ${
                    exchange === ex
                      ? 'bg-emerald-50 dark:bg-[#8DC63F]/15 border-emerald-500 dark:border-[#8DC63F] text-emerald-700 dark:text-[#8DC63F] font-bold shadow-sm'
                      : 'bg-white dark:bg-[#09111E] border-slate-300 dark:border-[#162740] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:border-slate-400'
                  }`}
                >
                  <div className="flex items-center gap-1">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${exchange === ex ? 'bg-emerald-500 dark:bg-[#8DC63F]' : 'bg-slate-400 dark:bg-slate-600'}`}
                    ></span>
                    <span className="text-xs font-mono">{ex}</span>
                  </div>
                  <span className="text-[8.5px] text-slate-500 font-mono font-medium">
                    {ex === 'Binance' || (ex as string).includes('Bybit')
                      ? 'Testnet'
                      : ex === 'Bitget' || ex === 'OKX'
                      ? 'Demo'
                      : 'Cloud'}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* PANDUAN & LINK PENDAFTARAN API TESTNET INTERAKTIF */}
          <div className="rounded-xl border border-amber-300 dark:border-amber-500/25 bg-amber-50 dark:bg-[#091322] overflow-hidden">
            <button
              type="button"
              onClick={() => setIsGuideOpen(!isGuideOpen)}
              className="w-full px-3.5 py-2.5 bg-gradient-to-r from-amber-100 dark:from-amber-500/10 via-amber-50 dark:via-[#0A172A] to-emerald-100 dark:to-emerald-500/10 flex items-center justify-between text-left transition hover:opacity-95 cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <span className="font-black text-xs text-amber-800 dark:text-amber-300">
                  Panduan & Link Pendaftaran API Testnet {selectedGuideEx}
                </span>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-200 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-400 dark:border-amber-500/30 font-bold">
                  {currentGuide.hasOfficialTestnet ? 'Tersedia' : 'Rekomendasi'}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-400 font-bold">
                <span className="text-[10px] hidden sm:inline">
                  {isGuideOpen ? 'Tutup Panduan' : 'Buka Panduan'}
                </span>
                {isGuideOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </div>
            </button>

            {isGuideOpen && (
              <div className="p-3.5 space-y-3 text-xs border-t border-amber-300 dark:border-amber-500/20">
                {/* Selector for guide tab if user wants to browse other exchange guides */}
                <div className="flex items-center gap-1 overflow-x-auto pb-1 custom-scrollbar">
                  <span className="text-[10px] text-slate-600 dark:text-slate-400 font-mono mr-1 shrink-0 font-bold">Bursa:</span>
                  {ALL_EXCHANGES.map((ex) => (
                    <button
                      type="button"
                      key={`guide-${ex}`}
                      onClick={() => setSelectedGuideEx(ex)}
                      className={`px-2 py-0.5 rounded-lg text-[10px] font-mono whitespace-nowrap transition cursor-pointer ${
                        selectedGuideEx === ex
                          ? 'bg-amber-200 dark:bg-amber-400/20 text-amber-800 dark:text-amber-300 border border-amber-400 dark:border-amber-400/40 font-bold'
                          : 'bg-white dark:bg-[#0B1527] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 border border-slate-300 dark:border-[#162740]'
                      }`}
                    >
                      {ex}
                    </button>
                  ))}
                </div>

                {/* Guide Card Header with Direct Official Link */}
                <div className="p-3 rounded-lg bg-white dark:bg-[#070D18] border border-slate-300 dark:border-[#162740] flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs text-slate-900 dark:text-white">{currentGuide.portalName}</span>
                    </div>
                    <p className="text-[10px] text-slate-600 dark:text-slate-400 font-mono mt-0.5">{currentGuide.badge}</p>
                  </div>

                  <a
                    href={currentGuide.portalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-100 dark:bg-amber-400/15 hover:bg-amber-200 dark:hover:bg-amber-400/25 border border-amber-300 dark:border-amber-400/40 text-amber-700 dark:text-amber-300 hover:text-amber-800 dark:hover:text-amber-200 text-xs font-bold transition cursor-pointer shrink-0"
                  >
                    <span>Buka Portal Resmi {selectedGuideEx}</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </a>
                </div>

                {/* Step-by-step instructions */}
                <div className="space-y-1.5">
                  <span className="text-[10.5px] font-mono font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider block">
                    Langkah Mendapatkan API Key & Saldo Faucet Demo:
                  </span>
                  <div className="space-y-1.5 bg-slate-50 dark:bg-[#060C17] p-2.5 rounded-lg border border-slate-200 dark:border-[#14233A]">
                    {currentGuide.instructions.map((step, idx) => (
                      <div key={idx} className="flex items-start gap-2 text-[11px] text-slate-700 dark:text-slate-300 leading-relaxed font-medium">
                        <span className="w-4 h-4 rounded-full bg-amber-200 dark:bg-amber-400/20 text-amber-800 dark:text-amber-300 font-mono text-[10px] flex items-center justify-center shrink-0 mt-0.5 font-bold">
                          {idx + 1}
                        </span>
                        <span>{step}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Faucet & Recommendation Notes */}
                <div className="p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-300 dark:border-emerald-500/20 text-[11px] text-emerald-800 dark:text-emerald-300 space-y-1">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <Sparkles className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span>Informasi Saldo Testnet:</span>
                  </div>
                  <p className="text-[10.5px] text-slate-700 dark:text-slate-300 leading-relaxed font-sans font-medium">
                    {currentGuide.faucetInfo}
                  </p>
                  {currentGuide.recommendationNote && (
                    <p className="text-[10px] text-amber-700 dark:text-amber-300/90 pt-1 font-sans font-bold">
                      💡 {currentGuide.recommendationNote}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Security Guarantee Box */}
          <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-300 dark:border-emerald-500/20 text-emerald-800 dark:text-emerald-300 text-xs space-y-1">
            <div className="flex items-center gap-1.5 font-bold">
              <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>Proteksi 100% Non-Kustodian (Hanya Izin Spot Trading)</span>
            </div>
            <p className="text-[11px] text-slate-700 dark:text-slate-300 leading-relaxed font-sans font-medium">
              Bot hanya membutuhkan izin <strong>Read Info</strong> dan <strong>Spot Trading</strong>.{' '}
              <span className="text-emerald-600 dark:text-emerald-400 font-black">JANGAN AKTIFKAN IZIN PENARIKAN (WITHDRAWAL)</span>. Dana
              pokok Anda 100% berada di dompet bursa {exchange}.
            </p>
          </div>

          {/* Form fields */}
          {!isPublicOnly ? (
            <>
              {exchange === 'Binance' && connectionMode === 'testnet' && (
                <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-300 dark:border-amber-500/30 space-y-2">
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className="font-bold text-amber-900 dark:text-amber-300">Pilih Lingkungan Demo Binance Spot:</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] bg-amber-200 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 font-bold">Dual Auto-Fallback</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setBinanceEnvChoice('demo');
                        setTestResult(null);
                        setConnectionPopup(null);
                      }}
                      className={`p-2.5 rounded-lg border text-left transition cursor-pointer ${
                        binanceEnvChoice === 'demo'
                          ? 'bg-amber-100 dark:bg-amber-500/20 border-amber-400 dark:border-amber-400 text-amber-900 dark:text-amber-200 shadow-sm'
                          : 'bg-white dark:bg-[#09111E] border-slate-300 dark:border-[#162740] text-slate-600 dark:text-slate-400 hover:border-slate-400'
                      }`}
                    >
                      <div className="font-bold text-[11px] flex items-center justify-between">
                        <span>Spot Demo Mode</span>
                        <span className="text-[9px] font-mono bg-amber-200 dark:bg-amber-400/20 px-1 py-0.2 rounded font-bold">Rekomendasi</span>
                      </div>
                      <div className="text-[9.5px] font-mono opacity-80 mt-0.5">demo-api.binance.com</div>
                      <div className="text-[9px] text-slate-500 dark:text-slate-400 mt-1">Akun Binance &gt; Demo Trading Spot</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBinanceEnvChoice('vision');
                        setTestResult(null);
                        setConnectionPopup(null);
                      }}
                      className={`p-2.5 rounded-lg border text-left transition cursor-pointer ${
                        binanceEnvChoice === 'vision'
                          ? 'bg-amber-100 dark:bg-amber-500/20 border-amber-400 dark:border-amber-400 text-amber-900 dark:text-amber-200 shadow-sm'
                          : 'bg-white dark:bg-[#09111E] border-slate-300 dark:border-[#162740] text-slate-600 dark:text-slate-400 hover:border-slate-400'
                      }`}
                    >
                      <div className="font-bold text-[11px]">Spot Testnet Vision</div>
                      <div className="text-[9.5px] font-mono opacity-80 mt-0.5">testnet.binance.vision</div>
                      <div className="text-[9px] text-slate-500 dark:text-slate-400 mt-1">Portal Login GitHub</div>
                    </button>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-mono text-slate-700 dark:text-slate-400 mb-1.5 uppercase tracking-wider font-bold">
                  API Key ({exchange} • {connectionMode === 'testnet' ? (exchange === 'Binance' && binanceEnvChoice === 'demo' ? 'Spot Demo' : 'Testnet') : 'Live Real'})
                </label>
                <input
                  type="text"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setTestResult(null);
                    setConnectionPopup(null);
                  }}
                  placeholder={
                    connectionMode === 'testnet'
                      ? `Masukkan API Key ${exchange} Testnet atau Demo...`
                      : `Masukkan API Key ${exchange} Akun Riil...`
                  }
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#09111E] border border-slate-300 dark:border-[#162740] font-mono text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-500 dark:focus:border-[#8DC63F]"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-mono text-slate-700 dark:text-slate-400 mb-1.5 uppercase tracking-wider font-bold">
                  API Secret Key
                </label>
                <input
                  type="password"
                  value={apiSecret}
                  onChange={(e) => {
                    setApiSecret(e.target.value);
                    setTestResult(null);
                    setConnectionPopup(null);
                  }}
                  placeholder={`Masukkan Secret Key ${exchange}...`}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#09111E] border border-slate-300 dark:border-[#162740] font-mono text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-500 dark:focus:border-[#8DC63F]"
                  required
                />
              </div>

              {requiresPassphrase && (
                <div>
                  <label className="block text-[11px] font-mono text-slate-700 dark:text-slate-400 mb-1.5 uppercase tracking-wider font-bold">
                    Passphrase (Wajib untuk {exchange})
                  </label>
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => {
                      setPassphrase(e.target.value);
                      setTestResult(null);
                      setConnectionPopup(null);
                    }}
                    placeholder={`Masukkan Passphrase yang Anda tentukan saat membuat API di ${exchange}...`}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#09111E] border border-slate-300 dark:border-[#162740] font-mono text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-500 dark:focus:border-[#8DC63F]"
                    required
                  />
                </div>
              )}
            </>
          ) : (
            <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-300 dark:border-emerald-500/20 text-emerald-800 dark:text-emerald-200 text-xs space-y-1.5">
              <div className="flex items-center gap-2 font-bold"><ShieldCheck className="w-4 h-4" /> Read-only API Certification</div>
              <p className="text-[11px] text-slate-700 dark:text-slate-300 leading-relaxed font-medium">
                {exchangeDescriptor?.notes || 'Tidak ada API authenticated trading yang diaktifkan pada exchange ini.'}
              </p>
              <p className="text-[10px] text-slate-600 dark:text-slate-400 font-mono font-medium">
                Tidak ada credential yang diminta atau disimpan. Tidak ada order yang dikirim.
              </p>
            </div>
          )}

          <ExchangeCertificationPanel exchange={exchange} isSandbox={isSandbox} />

          {/* IP Whitelist & Speed Info */}
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#070D17] border border-slate-200 dark:border-[#14233A] space-y-2 text-xs font-mono">
            <div className="flex items-center justify-between text-slate-600 dark:text-slate-400 font-bold">
              <span className="flex items-center gap-1.5 text-[11px]">
                <Lock className="w-3.5 h-3.5 text-emerald-600 dark:text-[#8DC63F]" />
                Dedicated Node IP Whitelist (Opsional):
              </span>
              <button
                type="button"
                onClick={handleCopyIp}
                className="text-emerald-700 dark:text-[#8DC63F] hover:underline flex items-center gap-1 text-[11px] cursor-pointer"
              >
                {copiedIp ? <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copiedIp ? 'Tersalin!' : 'Salin IP'}</span>
              </button>
            </div>
            <p className="text-[10px] text-slate-600 dark:text-slate-500 font-mono font-medium">
              142.250.180.14, 172.217.16.206 (Cross-connect low latency)
            </p>

            {/* Quick Speed / Signature Explainer Toggle */}
            <div className="pt-1.5 border-t border-slate-200 dark:border-[#14233A]/60">
              <button
                type="button"
                onClick={() => setShowSpeedTip(!showSpeedTip)}
                className="w-full flex items-center justify-between text-[11px] text-slate-700 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition font-bold"
              >
                <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400/90 font-black">
                  <HelpCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  Kenapa verifikasi signature membutuhkan waktu?
                </span>
                {showSpeedTip ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>

              {showSpeedTip && (
                <div className="mt-2 p-2.5 rounded-lg bg-slate-100 dark:bg-[#0B1424] border border-slate-300 dark:border-[#182B46] text-[11px] font-sans text-slate-700 dark:text-slate-300 space-y-1.5 animate-fadeIn">
                  <p className="leading-relaxed">
                    Saat memverifikasi, sistem mengeksekusi 3 tahap keamanan tingkat institusional:
                  </p>
                  <ol className="list-decimal list-inside space-y-1 text-slate-700 dark:text-slate-400 text-[10.5px]">
                    <li>
                      <strong className="text-slate-900 dark:text-slate-200">Enkripsi HMAC-SHA256:</strong> Server bursa ({exchange})
                      memvalidasi keaslian signature dan timestamp.
                    </li>
                    <li>
                      <strong className="text-slate-900 dark:text-slate-200">Verifikasi Izin & Sandbox:</strong> Bursa mencocokkan hak
                      akses Spot Trading dan target environment ({connectionMode}).
                    </li>
                    <li>
                      <strong className="text-slate-900 dark:text-slate-200">Kalkulasi Valuasi Multi-Aset:</strong> Sistem otomatis
                      memindai saldo dompet dan menaksir nilai portofolio dalam USDT secara real-time.
                    </li>
                  </ol>
                </div>
              )}
            </div>
          </div>

          {/* Test Result Box */}
          {testResult && (
            <div
              className={`p-3.5 rounded-xl border text-xs font-mono space-y-1.5 animate-fadeIn ${
                testResult.success
                  ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-300 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300'
                  : 'bg-red-50 dark:bg-red-500/10 border-red-300 dark:border-red-500/30 text-red-800 dark:text-red-300'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold">
                  {testResult.success ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
                  )}
                  <span>{testResult.message}</span>
                </div>
                {testResult.latencyMs !== undefined && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-black/40 font-mono text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-transparent">
                    {testResult.latencyMs} ms
                  </span>
                )}
              </div>

              {testResult.success && (
                <div className="space-y-2 pt-1 border-t border-emerald-200 dark:border-emerald-500/20">
                  {isPublicOnly ? (
                    <div className="p-2.5 rounded-lg bg-emerald-100 dark:bg-[#8DC63F]/10 border border-emerald-300 dark:border-[#8DC63F]/20 text-emerald-800 dark:text-[#8DC63F]">
                      <div className="font-bold text-[11px]">Read-only certification selesai.</div>
                      <div className="text-[10px] text-emerald-700 dark:text-slate-300 mt-1 font-medium">Tidak ada saldo akun, credential private, atau order yang diproses.</div>
                    </div>
                  ) : (
                    <>
                      <div className="text-[11px] text-slate-800 dark:text-slate-200 grid grid-cols-2 gap-2">
                        <div>
                          <span className="text-slate-600 dark:text-slate-400 block text-[10px] font-bold">Saldo Spot USDT ({connectionMode === 'testnet' ? 'Demo' : 'Live'}):</span>
                          <span className="font-black text-emerald-700 dark:text-[#8DC63F] text-sm">{testResult.usdtAvailable?.toFixed(2)} USDT</span>
                        </div>
                        <div>
                          <span className="text-slate-600 dark:text-slate-400 block text-[10px] font-bold">Total Estimasi Nilai:</span>
                          <span className="text-emerald-700 dark:text-emerald-400 font-black text-sm">
                            ${testResult.totalPortfolioUsdt?.toFixed(2) ?? testResult.usdtAvailable?.toFixed(2)}
                          </span>
                        </div>
                      </div>

                      <div className="p-2 rounded-lg bg-slate-50 dark:bg-black/30 border border-emerald-200 dark:border-emerald-500/20 space-y-1">
                        <span className="text-[10px] text-emerald-700 dark:text-emerald-300 font-black block uppercase tracking-wider">
                          Koin Default Terdeteksi ({defaultConnectionAssets.length}/{SUPPORTED_COINS.length}):
                        </span>
                        {defaultConnectionAssets.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5 pt-0.5">
                            {defaultConnectionAssets.map((asset) => (
                              <span
                                key={asset.coin}
                                className="px-2 py-0.5 rounded text-[10px] bg-emerald-100 dark:bg-emerald-500/15 border border-emerald-300 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-200 font-medium"
                              >
                                <strong className="text-slate-900 dark:text-white">{asset.coin}:</strong> {asset.total} {Number(asset.valueUsdt) > 0 ? `(~$${Number(asset.valueUsdt).toFixed(2)})` : '(harga belum tersedia)'}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <div className="text-[10px] text-slate-500 dark:text-slate-400 pt-0.5 font-medium">Tidak ada saldo non-zero pada {SUPPORTED_COINS.length} koin default.</div>
                        )}
                        <div className="text-[9px] text-slate-500 dark:text-slate-400 pt-1 font-medium">Aset exchange lain tetap tersedia di data API, tetapi tidak ditampilkan di ringkasan ini.</div>
                      </div>

                      <button
                        type="button"
                        onClick={handleApplyConnection}
                        disabled={isApplyingConnection}
                        className="w-full py-2.5 px-3 rounded-xl bg-emerald-500 dark:bg-[#8DC63F] hover:bg-emerald-600 dark:hover:bg-[#7ab72f] text-white dark:text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/20 dark:shadow-[#8DC63F]/20 transition cursor-pointer disabled:opacity-60"
                      >
                        {isApplyingConnection ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                        <span>{isApplyingConnection ? 'Menyimpan koneksi...' : `Terapkan ke Dashboard (${isSandbox ? 'Demo' : 'Live'})`}</span>
                      </button>
                    </>
                  )}
                </div>
              )}

              {testResult.error && (
                <p className="text-[11px] text-red-700 dark:text-red-300 leading-relaxed pt-1 border-t border-red-200 dark:border-red-500/20 font-medium">
                  {testResult.error}
                </p>
              )}
            </div>
          )}

          {/* Bottom Actions */}
          <div className="pt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl bg-slate-200 dark:bg-[#0F1A2D] text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:text-white text-xs font-bold transition cursor-pointer"
            >
              Tutup
            </button>

            <button
              type="submit"
              disabled={isLoading}
              className={`px-5 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer disabled:opacity-50 ${
                connectionMode === 'testnet'
                  ? 'bg-amber-400 hover:bg-amber-500 text-slate-950 shadow-lg shadow-amber-400/20'
                  : 'bg-emerald-500 dark:bg-[#8DC63F] hover:bg-emerald-600 dark:hover:bg-[#7ab72f] text-white dark:text-slate-950 shadow-lg shadow-emerald-500/20 dark:shadow-[#8DC63F]/20'
              }`}
            >
              {isLoading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                  <span>{loadingStep}</span>
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 fill-current" />
                  <span>{isPublicOnly ? `Audit API Publik ${exchange}` : `Tes & Hubungkan ${exchange} (${connectionMode === 'testnet' ? 'Testnet' : 'Live'})`}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {connectionPopup && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/60 dark:bg-black/75 backdrop-blur-sm" role="presentation">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="exchange-connection-result-title"
            className="w-full max-w-sm rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B1320] p-5 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              {connectionPopup.success
                ? <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-600 dark:text-emerald-400" />
                : <AlertCircle className="mt-0.5 h-6 w-6 shrink-0 text-red-600 dark:text-red-400" />}
              <div>
                <h3 id="exchange-connection-result-title" className="text-sm font-bold text-slate-900 dark:text-white">
                  {connectionPopup.title}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300 font-medium">{connectionPopup.message}</p>
                <p className="mt-2 text-[10px] font-mono text-slate-500 dark:text-slate-400 font-bold">
                  {exchange} · {isSandbox ? 'Demo' : 'Live'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                const connected = connectionPopup.success;
                setConnectionPopup(null);
                if (connected) onClose();
              }}
              className={`mt-5 w-full rounded-xl px-4 py-2.5 text-xs font-bold transition ${
                connectionPopup.success
                  ? 'bg-emerald-500 dark:bg-emerald-400 text-white dark:text-slate-950 hover:bg-emerald-600 dark:hover:bg-emerald-300'
                  : 'bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-100 hover:bg-slate-300 dark:hover:bg-slate-700'
              }`}
            >
              {connectionPopup.success ? 'Selesai' : 'Tutup'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
