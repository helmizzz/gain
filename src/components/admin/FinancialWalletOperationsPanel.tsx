import { useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, ShieldCheck, WalletCards, ArrowDownToLine, ArrowUpFromLine,
  AlertTriangle, Activity, LockKeyhole, Eye, EyeOff, Search, CheckCircle2,
} from 'lucide-react';
import {
  getFinancialWalletAdminOverview,
  getNativeBscWalletStatus,
  getNativeBscUsers,
  getNativeBscTransactions,
  configureNativeBscHotWallet,
} from '../../api/adminFinancialWalletApi';
import { formatUsdt } from '../../utils/formatters';

function shortAddress(value: unknown) {
  const s = String(value || '');
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s || '-';
}

function shortTx(value: unknown) {
  const s = String(value || '');
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s || '-';
}

export function FinancialWalletOperationsPanel() {
  const [data, setData] = useState<any>(null);
  const [native, setNative] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showHotKey, setShowHotKey] = useState(false);
  const [hotKey, setHotKey] = useState('');
  const [hotAddress, setHotAddress] = useState('');
  const [autoWdLimit, setAutoWdLimit] = useState<number>(50);
  const [savingHot, setSavingHot] = useState(false);
  const [hotMessage, setHotMessage] = useState('');

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const [overview, status, userData, txData] = await Promise.all([
        getFinancialWalletAdminOverview(),
        getNativeBscWalletStatus(),
        getNativeBscUsers(),
        getNativeBscTransactions(),
      ]);
      setData(overview);
      setNative(status.wallet);
      setUsers(Array.isArray(userData.users) ? userData.users : []);
      setTransactions(Array.isArray(txData.transactions) ? txData.transactions : []);
      if (status.wallet?.hotWalletAddress) setHotAddress(status.wallet.hotWalletAddress);
      if (status.wallet?.autoWithdrawalMaxAmount) setAutoWdLimit(Number(status.wallet.autoWithdrawalMaxAmount));
    } catch (e: any) {
      setError(e?.message || 'Financial wallet overview gagal dimuat.');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const saveHotWallet = async () => {
    setSavingHot(true);
    setHotMessage('');
    try {
      const result = await configureNativeBscHotWallet(hotKey.trim(), hotAddress.trim(), true, Number(autoWdLimit) || 50);
      setHotKey('');
      setShowHotKey(false);
      setHotMessage(`Hot wallet ${shortAddress(result.address)} aktif. Limit auto-WD: ${result.autoWithdrawalMaxAmount || 50} USDT (WD > ${result.autoWithdrawalMaxAmount || 50} USDT butuh 2-Admin approval).`);
      await load(true);
    } catch (e: any) {
      setHotMessage(e?.message || 'Hot wallet gagal disimpan.');
    } finally {
      setSavingHot(false);
    }
  };

  const totals = data?.overview?.totals || {};
  const overview = data?.overview || {};
  const normalized = search.trim().toLowerCase();
  const filteredUsers = useMemo(() => users.filter((u) => {
    if (!normalized) return true;
    return [u.member_id, u.email, u.deposit_address]
      .some((v) => String(v || '').toLowerCase().includes(normalized));
  }), [users, normalized]);

  return (
    <div className="mt-4 rounded-2xl border border-cyan-400/40 dark:border-cyan-500/20 bg-white dark:bg-slate-950/60 overflow-hidden font-mono shadow-xs text-slate-900 dark:text-slate-100">
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 bg-slate-50 dark:bg-slate-900/60">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-600 dark:text-cyan-300">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <div>
            <div className="text-sm font-extrabold text-slate-900 dark:text-white">Native BSC Financial Control Center</div>
            <div className="text-[10px] text-slate-600 dark:text-slate-400 font-mono font-medium">USDT BEP-20 • User Balance • On-chain Activity • Auto WD • Audit</div>
          </div>
        </div>
        <button onClick={() => void load()} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-[10px] font-mono font-bold flex items-center gap-1.5 cursor-pointer">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Live refresh
        </button>
      </div>

      {error && <div className="p-4 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2 font-bold"><AlertTriangle className="w-4 h-4" />{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-2 p-4">
        {[
          ['User', overview.users || users.length, 'text-slate-900 dark:text-slate-200'],
          ['Deposit Address', overview.activeDepositAddresses || 0, 'text-cyan-700 dark:text-cyan-300'],
          ['Ledger Available', formatUsdt(Number(totals.available || 0)), 'text-emerald-700 dark:text-emerald-300'],
          ['Pending Deposit', overview.pendingDeposits || 0, 'text-amber-800 dark:text-amber-300'],
          ['Pending WD', overview.pendingWithdrawals || 0, 'text-rose-700 dark:text-rose-300'],
          ['Auto WD', native?.autoWithdrawalEnabled ? 'ON' : 'OFF', native?.autoWithdrawalEnabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'],
        ].map(([label, value, cls]) => (
          <div key={String(label)} className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 shadow-xs">
            <div className="text-[9px] uppercase tracking-wider text-slate-600 dark:text-slate-400 font-mono font-bold">{label}</div>
            <div className={`mt-1 text-sm font-black ${cls}`}>{String(value)}</div>
          </div>
        ))}
      </div>

      <div className="px-4 pb-4 grid grid-cols-1 md:grid-cols-4 gap-2 text-[10px] font-mono">
        <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 flex items-center gap-2"><WalletCards className="w-4 h-4 text-cyan-600 dark:text-cyan-300" /><span className="text-slate-600 dark:text-slate-400 font-semibold">Customer liability:</span><strong className="text-slate-900 dark:text-white font-extrabold">{formatUsdt(Number(overview.customerLiability || 0))}</strong></div>
        <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 flex items-center gap-2"><ArrowDownToLine className="w-4 h-4 text-emerald-600 dark:text-emerald-300" /><span className="text-slate-600 dark:text-slate-400 font-semibold">Inflow:</span><strong className="text-slate-900 dark:text-white font-extrabold">{formatUsdt(Number(totals.inflow || 0))}</strong></div>
        <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 flex items-center gap-2"><ArrowUpFromLine className="w-4 h-4 text-rose-600 dark:text-rose-300" /><span className="text-slate-600 dark:text-slate-400 font-semibold">Outflow:</span><strong className="text-slate-900 dark:text-white font-extrabold">{formatUsdt(Number(totals.outflow || 0))}</strong></div>
        <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 flex items-center gap-2"><Activity className="w-4 h-4 text-violet-600 dark:text-violet-300" /><span className="text-slate-600 dark:text-slate-400 font-semibold">Hot USDT:</span><strong className="text-slate-900 dark:text-white font-extrabold">{formatUsdt(Number(native?.hotWalletUsdt || 0))}</strong></div>
      </div>

      <div className="mx-4 mb-4 rounded-xl border border-amber-300 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/5 p-4 space-y-2">
        <div className="flex items-center gap-2 text-xs font-extrabold text-amber-900 dark:text-amber-300"><LockKeyhole className="w-4 h-4 text-amber-600 dark:text-amber-400" /> Hot Wallet WD Otomatis — BSC</div>
        <div className="text-[10px] text-slate-600 dark:text-slate-400 font-mono font-medium">
          Private key dienkripsi server-side dan tidak pernah ditampilkan kembali. Alamat harus sama dengan private key.
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mt-3">
          <input value={hotAddress} onChange={(e) => setHotAddress(e.target.value)} placeholder="Hot wallet address" className="px-3 py-2 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-white font-mono font-medium" />
          <div className="relative">
            <input type={showHotKey ? 'text' : 'password'} value={hotKey} onChange={(e) => setHotKey(e.target.value)} placeholder="Private key hot wallet" className="w-full px-3 py-2 pr-10 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-white font-mono font-medium" autoComplete="off" />
            <button type="button" onClick={() => setShowHotKey((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500"><Eye className="w-4 h-4" /></button>
          </div>
          <div className="flex items-center gap-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-2">
            <span className="text-[10px] text-slate-600 dark:text-slate-400 font-mono whitespace-nowrap font-semibold">Max Auto:</span>
            <input type="number" min="1" value={autoWdLimit} onChange={(e) => setAutoWdLimit(Number(e.target.value))} placeholder="50" className="w-full bg-transparent py-2 text-xs text-emerald-700 dark:text-emerald-300 font-black font-mono focus:outline-none" />
            <span className="text-[10px] text-slate-600 dark:text-slate-400 font-mono font-bold">USDT</span>
          </div>
          <button disabled={savingHot || !hotKey.trim()} onClick={() => void saveHotWallet()} className="px-3 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 dark:hover:bg-emerald-400 text-slate-950 text-xs font-extrabold disabled:opacity-50 cursor-pointer transition shadow-xs">
            {savingHot ? 'Menyimpan…' : 'Simpan & Aktifkan WD Otomatis'}
          </button>
        </div>
        {hotMessage && <div className="mt-2 text-[10px] font-mono font-bold text-cyan-800 dark:text-cyan-300">{hotMessage}</div>}
        <div className="mt-3 text-[10px] font-mono text-slate-600 dark:text-slate-400 font-medium">
          Status: <span className={native?.autoWithdrawalEnabled ? 'text-emerald-700 dark:text-emerald-300 font-extrabold' : 'text-amber-800 dark:text-amber-300 font-extrabold'}>{native?.autoWithdrawalEnabled ? 'ACTIVE' : 'NOT ACTIVE'}</span>
          {' • '}Limit Auto-WD: <span className="text-emerald-700 dark:text-emerald-300 font-black">{native?.autoWithdrawalMaxAmount || 50} USDT</span>
          {' • '}Address: <span className="text-cyan-700 dark:text-cyan-300 font-bold">{shortAddress(native?.hotWalletAddress)}</span>
          {' • '}BNB gas: <span className="text-slate-900 dark:text-white font-extrabold">{native?.hotWalletBnb || '0'}</span>
        </div>
      </div>

      <div className="px-4 pb-3 flex items-center justify-between gap-2">
        <div className="text-xs font-extrabold text-slate-900 dark:text-white">Saldo Semua User</div>
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cari member / email / address…" className="w-full pl-8 pr-3 py-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 text-[10px] text-slate-900 dark:text-white placeholder:text-slate-400 font-mono" />
        </div>
      </div>

      <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800 max-h-[420px]">
        <table className="w-full text-left text-[10px] font-mono">
          <thead className="bg-slate-100 dark:bg-slate-900 sticky top-0"><tr className="text-slate-700 dark:text-slate-400 font-extrabold">
            <th className="px-3 py-2">USER</th><th>DEPOSIT ADDRESS</th><th>AVAILABLE</th><th>LOCKED</th><th>FLOW</th><th>LAST ACTIVITY</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-900">
            {filteredUsers.map((u:any) => (
              <tr key={String(u.user_id)} className="hover:bg-slate-50 dark:hover:bg-slate-900/60 font-medium">
                <td className="px-3 py-2"><div className="text-slate-900 dark:text-white font-bold">{u.member_id || '-'}</div><div className="text-slate-600 dark:text-slate-500">{u.email || '-'}</div></td>
                <td className="px-3 py-2"><span className="text-cyan-700 dark:text-cyan-300 font-bold">{shortAddress(u.deposit_address)}</span><div className="text-[9px] text-slate-500">index {u.derivation_index ?? '-'}</div></td>
                <td className="px-3 py-2 text-emerald-700 dark:text-emerald-300 font-black">{formatUsdt(Number(u.available_balance || 0))}</td>
                <td className="px-3 py-2 text-amber-800 dark:text-amber-300 font-bold">{formatUsdt(Number(u.locked_balance || 0))}</td>
                <td className="px-3 py-2 text-slate-600 dark:text-slate-400">D {u.deposit_count || 0} · W {u.withdrawal_count || 0}</td>
                <td className="px-3 py-2 text-slate-500">{u.last_financial_activity ? new Date(u.last_financial_activity).toLocaleString() : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="p-4 border-t border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-extrabold text-slate-900 dark:text-white">Realtime Transaction Audit</div>
          <div className="text-[9px] text-emerald-700 dark:text-emerald-300 font-mono font-bold flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> polling 5s</div>
        </div>
        <div className="overflow-x-auto max-h-[360px]">
          <table className="w-full text-left text-[10px] font-mono">
            <thead className="bg-slate-100 dark:bg-slate-900 sticky top-0"><tr className="text-slate-700 dark:text-slate-400 font-extrabold"><th className="px-3 py-2">TIME</th><th>TYPE</th><th>USER</th><th>AMOUNT</th><th>STATUS</th><th>TX HASH</th><th>DESTINATION</th></tr></thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-900">
              {transactions.map((tx:any) => (
                <tr key={`${tx.type}:${tx.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-900/60 font-medium">
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{tx.occurred_at ? new Date(tx.occurred_at).toLocaleString() : '-'}</td>
                  <td className={String(tx.type).includes('DEPOSIT') ? 'text-emerald-700 dark:text-emerald-300 font-bold' : String(tx.type).includes('WITHDRAWAL') ? 'text-rose-700 dark:text-rose-300 font-bold' : 'text-cyan-700 dark:text-cyan-300 font-bold'}>{tx.type}</td>
                  <td><div className="text-slate-900 dark:text-white font-bold">{tx.member_id || '-'}</div><div className="text-slate-500">{tx.email || '-'}</div></td>
                  <td className={String(tx.amount || '').startsWith('-') ? 'text-rose-700 dark:text-rose-300 font-black' : 'text-emerald-700 dark:text-emerald-300 font-black'}>{formatUsdt(Number(tx.amount || 0))}</td>
                  <td className="text-slate-600 dark:text-slate-400 font-medium">{tx.status}</td>
                  <td className="text-cyan-700 dark:text-cyan-300 font-bold">{shortTx(tx.tx_hash)}</td>
                  <td className="text-slate-500">{shortAddress(tx.destination || tx.destination_address)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
