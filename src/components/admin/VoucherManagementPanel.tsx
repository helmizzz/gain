import React, { useState, useEffect } from 'react';
import {
  Ticket,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Clock,
  Check,
  X,
  Search,
  Tag,
  Percent,
  DollarSign,
} from 'lucide-react';
import {
  getAdminVouchers,
  createAdminVoucher,
  toggleAdminVoucherStatus,
  deleteAdminVoucher,
  Voucher,
  CreateVoucherPayload,
} from '../../api/voucherApi';
import { formatUsdt } from '../../utils/formatters';

export function VoucherManagementPanel() {
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Form State
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [code, setCode] = useState('');
  const [discountType, setDiscountType] = useState<'PERCENTAGE' | 'FIXED'>('PERCENTAGE');
  const [discountValue, setDiscountValue] = useState<string>('20');
  const [maxUses, setMaxUses] = useState<string>('');
  const [applicableTier, setApplicableTier] = useState<'all' | 'starter_6' | 'pro_12'>('all');
  const [expiresAt, setExpiresAt] = useState<string>('');

  const loadVouchers = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await getAdminVouchers();
      setVouchers(res.vouchers || []);
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal memuat daftar voucher.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadVouchers();
  }, []);

  const handleCreateVoucher = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsSubmitting(true);

    const val = parseFloat(discountValue);
    if (isNaN(val) || val <= 0) {
      setErrorMsg('Nilai diskon harus lebih besar dari 0.');
      setIsSubmitting(false);
      return;
    }

    if (discountType === 'PERCENTAGE' && val > 100) {
      setErrorMsg('Diskon persentase tidak boleh melebihi 100%.');
      setIsSubmitting(false);
      return;
    }

    const payload: CreateVoucherPayload = {
      code: code.trim().toUpperCase(),
      discountType,
      discountValue: val,
      maxUses: maxUses.trim() ? parseInt(maxUses.trim(), 10) : null,
      applicableTier,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };

    try {
      await createAdminVoucher(payload);
      setSuccessMsg(`Voucher "${payload.code}" berhasil dibuat!`);
      setCode('');
      setDiscountValue('20');
      setMaxUses('');
      setExpiresAt('');
      setShowCreateForm(false);
      await loadVouchers();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal membuat voucher baru.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleStatus = async (id: string, currentStatus: boolean) => {
    try {
      await toggleAdminVoucherStatus(id, !currentStatus);
      setVouchers((prev) =>
        prev.map((v) => (v.id === id ? { ...v, isActive: !currentStatus } : v))
      );
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal memperbarui status voucher.');
    }
  };

  const handleDelete = async (id: string, voucherCode: string) => {
    if (!window.confirm(`Hapus voucher "${voucherCode}" secara permanen?`)) return;
    try {
      await deleteAdminVoucher(id);
      setVouchers((prev) => prev.filter((v) => v.id !== id));
      setSuccessMsg(`Voucher "${voucherCode}" berhasil dihapus.`);
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal menghapus voucher.');
    }
  };

  const filteredVouchers = vouchers.filter((v) =>
    v.code.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );

  return (
    <div className="mt-4 rounded-2xl border border-amber-400/40 dark:border-amber-500/30 bg-white dark:bg-slate-950/70 overflow-hidden font-mono text-slate-900 dark:text-slate-100 shadow-xs">
      {/* Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 bg-slate-50 dark:bg-slate-900/60">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-600 dark:text-amber-400">
            <Ticket className="w-5 h-5" />
          </div>
          <div>
            <div className="text-sm font-extrabold text-slate-900 dark:text-white">Manajemen Voucher Diskon Biaya Aktivasi</div>
            <div className="text-[10px] text-slate-600 dark:text-slate-400 font-sans font-medium">
              Buat dan kelola kode promo / voucher pemotongan biaya aktivasi lisensi GAIN
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreateForm((v) => !v)}
            className="px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 dark:hover:bg-amber-400 text-slate-950 text-xs font-extrabold transition flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <Plus className="w-3.5 h-3.5 stroke-[3]" />
            <span>{showCreateForm ? 'Tutup Form' : 'Buat Voucher Baru'}</span>
          </button>
          <button
            onClick={() => void loadVouchers()}
            className="p-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
            title="Refresh Data"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Alert Banners */}
      {errorMsg && (
        <div className="mx-4 mt-3 p-3 rounded-xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-800 dark:text-rose-300 text-xs flex items-center gap-2 font-medium">
          <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div className="mx-4 mt-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-xs flex items-center gap-2 font-medium">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Form Buat Voucher Baru */}
      {showCreateForm && (
        <form onSubmit={handleCreateVoucher} className="m-4 p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-amber-300 dark:border-amber-500/30 space-y-3">
          <div className="text-xs font-extrabold text-amber-900 dark:text-amber-300 flex items-center gap-1.5">
            <Tag className="w-4 h-4 text-amber-600 dark:text-amber-400" /> Form Pembuatan Voucher Baru
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            {/* Kode Voucher */}
            <div>
              <label className="block text-[10px] text-slate-600 dark:text-slate-400 mb-1 font-bold">Kode Voucher *</label>
              <input
                type="text"
                required
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="Contoh: PROMO50"
                className="w-full px-3 py-2 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white font-extrabold uppercase placeholder:text-slate-400 focus:outline-hidden focus:border-amber-500"
              />
            </div>

            {/* Tipe Diskon */}
            <div>
              <label className="block text-[10px] text-slate-600 dark:text-slate-400 mb-1 font-bold">Tipe Diskon *</label>
              <select
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as any)}
                className="w-full px-3 py-2 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white font-bold focus:outline-hidden focus:border-amber-500"
              >
                <option value="PERCENTAGE">Persentase (%)</option>
                <option value="FIXED">Nominal Tetap (USDT)</option>
              </select>
            </div>

            {/* Nilai Diskon */}
            <div>
              <label className="block text-[10px] text-slate-600 dark:text-slate-400 mb-1 font-bold">
                {discountType === 'PERCENTAGE' ? 'Persentase Diskon (%) *' : 'Potongan Nominal (USDT) *'}
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="any"
                  required
                  min="0.01"
                  max={discountType === 'PERCENTAGE' ? '100' : undefined}
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  placeholder={discountType === 'PERCENTAGE' ? '20' : '50'}
                  className="w-full pl-8 pr-3 py-2 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white font-bold focus:outline-hidden focus:border-amber-500"
                />
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 font-bold">
                  {discountType === 'PERCENTAGE' ? '%' : '$'}
                </span>
              </div>
            </div>

            {/* Berlaku Untuk Paket */}
            <div>
              <label className="block text-[10px] text-slate-600 dark:text-slate-400 mb-1 font-bold">Berlaku Untuk Paket</label>
              <select
                value={applicableTier}
                onChange={(e) => setApplicableTier(e.target.value as any)}
                className="w-full px-3 py-2 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white font-bold focus:outline-hidden focus:border-amber-500"
              >
                <option value="all">Semua Paket Aktivasi</option>
                <option value="starter_6">Starter (6 Bot)</option>
                <option value="pro_12">Pro (12 Bot)</option>
              </select>
            </div>

            {/* Kuota Maksimal Penggunaan */}
            <div>
              <label className="block text-[10px] text-slate-600 dark:text-slate-400 mb-1 font-bold">Batas Kuota Penggunaan</label>
              <input
                type="number"
                min="1"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                placeholder="Kosongkan jika tanpa batas"
                className="w-full px-3 py-2 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-hidden focus:border-amber-500"
              />
            </div>

            {/* Tanggal Kedaluwarsa */}
            <div>
              <label className="block text-[10px] text-slate-600 dark:text-slate-400 mb-1 font-bold">Tanggal Kedaluwarsa</label>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-hidden focus:border-amber-500"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowCreateForm(false)}
              className="px-4 py-2 rounded-lg bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold transition cursor-pointer"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 dark:hover:bg-amber-400 text-slate-950 text-xs font-extrabold disabled:opacity-50 transition flex items-center gap-1.5 cursor-pointer shadow-xs"
            >
              {isSubmitting ? (
                <>
                  <Clock className="w-3.5 h-3.5 animate-spin" />
                  <span>Menyimpan...</span>
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5 stroke-[3]" />
                  <span>Simpan Voucher</span>
                </>
              )}
            </button>
          </div>
        </form>
      )}

      {/* Controls & Search */}
      <div className="p-4 flex items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800/80 bg-slate-50/50 dark:bg-transparent">
        <div className="text-xs font-extrabold text-slate-900 dark:text-slate-200">
          Daftar Voucher Aktif ({vouchers.length})
        </div>
        <div className="relative w-full max-w-xs">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari kode voucher..."
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-hidden focus:border-amber-500 font-mono"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto max-h-[350px] custom-scrollbar">
        <table className="w-full text-left text-[11px]">
          <thead className="bg-slate-100 dark:bg-slate-900/90 sticky top-0 border-b border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-400 font-extrabold">
            <tr>
              <th className="px-4 py-2.5">KODE VOUCHER</th>
              <th className="px-3 py-2.5">POTONGAN / DISKON</th>
              <th className="px-3 py-2.5">PAKET BERLAKU</th>
              <th className="px-3 py-2.5">PENGGUNAAN</th>
              <th className="px-3 py-2.5">KEDALUWARSA</th>
              <th className="px-3 py-2.5">STATUS</th>
              <th className="px-4 py-2.5 text-right">AKSI</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800/60 font-medium">
            {filteredVouchers.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-500 font-sans">
                  {isLoading ? 'Memuat data voucher...' : 'Belum ada voucher yang dibuat.'}
                </td>
              </tr>
            ) : (
              filteredVouchers.map((v) => {
                const isExpired = v.expiresAt && new Date(v.expiresAt).getTime() < Date.now();
                const isExhausted = v.maxUses !== null && v.usedCount >= v.maxUses;
                const activeState = v.isActive && !isExpired && !isExhausted;

                return (
                  <tr key={v.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40 transition">
                    <td className="px-4 py-3">
                      <span className="font-extrabold text-amber-800 dark:text-amber-400 text-xs bg-amber-500/15 px-2 py-1 rounded border border-amber-400/30">
                        {v.code}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="font-black text-emerald-700 dark:text-emerald-400">
                        {v.discountType === 'PERCENTAGE'
                          ? `${v.discountValue}% OFF`
                          : `-${formatUsdt(v.discountValue)} USDT`}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-slate-700 dark:text-slate-300">
                      {v.applicableTier === 'all' ? (
                        <span className="px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-800 dark:text-cyan-300 font-extrabold text-[10px]">Semua Paket</span>
                      ) : v.applicableTier === 'pro_12' ? (
                        <span className="px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 font-extrabold text-[10px]">Pro (12 Bot)</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-800 dark:text-amber-300 font-extrabold text-[10px]">Starter (6 Bot)</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-slate-700 dark:text-slate-300">
                      <strong className="text-slate-900 dark:text-white">{v.usedCount}</strong> / {v.maxUses === null ? '∞' : v.maxUses}
                    </td>
                    <td className="px-3 py-3 text-slate-500 dark:text-slate-400 text-[10px]">
                      {v.expiresAt ? new Date(v.expiresAt).toLocaleString() : 'Tidak ada'}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold border ${
                          activeState
                            ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border-emerald-500/30'
                            : isExpired
                            ? 'bg-rose-500/15 text-rose-800 dark:text-rose-400 border-rose-500/30'
                            : isExhausted
                            ? 'bg-amber-500/15 text-amber-800 dark:text-amber-400 border-amber-500/30'
                            : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-700'
                        }`}
                      >
                        {activeState
                          ? 'AKTIF'
                          : isExpired
                          ? 'KEDALUWARSA'
                          : isExhausted
                          ? 'KUOTA HABIS'
                          : 'NON-AKTIF'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => void handleToggleStatus(v.id, v.isActive)}
                          className={`px-2 py-1 rounded text-[10px] font-extrabold border transition cursor-pointer ${
                            v.isActive
                              ? 'bg-slate-100 dark:bg-slate-800 text-amber-800 dark:text-amber-400 border-slate-300 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700'
                              : 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30'
                          }`}
                        >
                          {v.isActive ? 'Nonaktifkan' : 'Aktifkan'}
                        </button>
                        <button
                          onClick={() => void handleDelete(v.id, v.code)}
                          className="p-1 rounded text-rose-500 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-500/20 transition cursor-pointer"
                          title="Hapus Voucher"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
