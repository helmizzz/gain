import React, { useState, useEffect } from 'react';
import { FinancialWalletOperationsPanel } from './FinancialWalletOperationsPanel';
import { VoucherManagementPanel } from './VoucherManagementPanel';
import {
  X,
  ShieldCheck,
  Users,
  Search,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  DollarSign,
  Fuel,
  TrendingUp,
  Ticket,
} from 'lucide-react';
import { subscribeToMemberDirectory } from '../../services/memberService';
import type { DirectoryMember } from '../../services/memberService';
import { formatUsdt } from '../../utils/formatters';
import { promoteUserRole } from '../../api/authApi';

interface AdminUserManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AdminUserManagementModal({ isOpen, onClose }: AdminUserManagementModalProps) {
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'non-active'>('all');
  const [activeTab, setActiveTab] = useState<'members' | 'vouchers' | 'financial'>('members');
  const [promoteEmail, setPromoteEmail] = useState('');
  const [promoteLoading, setPromoteLoading] = useState(false);

  const handlePromote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!promoteEmail) return;
    if (!window.confirm(`Angkat ${promoteEmail} menjadi Admin?`)) return;
    setPromoteLoading(true);
    try {
      await promoteUserRole({ targetEmail: promoteEmail }, 'admin');
      alert(`Berhasil! ${promoteEmail} sekarang menjadi Admin.`);
      setPromoteEmail('');
    } catch (err: any) {
      alert(`Gagal: ${err.message}`);
    } finally {
      setPromoteLoading(false);
    }
  };

  const handleDemote = async (memberId: string, userId: string, username: string) => {
    if (!window.confirm(`Hapus akses admin untuk ${username} (${memberId})?`)) return;
    try {
      await promoteUserRole({ targetUserId: userId }, 'user');
      alert(`Berhasil! Akses admin untuk ${username} telah dicabut.`);
    } catch (err: any) {
      alert(`Gagal: ${err.message}`);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setLoadError(false);
    return subscribeToMemberDirectory(setMembers, () => {
      setMembers([]);
      setLoadError(true);
    });
  }, [isOpen]);

  if (!isOpen) return null;

  const normalizedSearch = searchTerm.trim().toLowerCase();
  const filteredMembers = members.filter((m) => {
    const username = String(m.username ?? '');
    const memberId = String(m.memberId ?? '');
    const emailMasked = String(m.emailMasked ?? '');
    const matchesSearch =
      username.toLowerCase().includes(normalizedSearch) ||
      memberId.toLowerCase().includes(normalizedSearch) ||
      emailMasked.toLowerCase().includes(normalizedSearch);
    const matchesStatus = filterStatus === 'all' || m.accountStatus === filterStatus;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
      <div className="theme-modal-shell w-full max-w-4xl bg-white dark:bg-[#0F172A] border border-amber-400/50 dark:border-amber-500/40 rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh] text-slate-900 dark:text-slate-100">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-900/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-500/10 dark:bg-amber-500/20 border border-amber-500/30 dark:border-amber-500/40 text-amber-600 dark:text-amber-400 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-extrabold text-slate-900 dark:text-white font-mono">Super Admin Control Center</h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-amber-500/15 text-amber-800 dark:text-amber-400 border border-amber-500/30 font-mono">
                  MASTER AUDIT
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 font-sans mt-0.5">
                Monitoring Member, Pembuatan Voucher Diskon Aktivasi & Kontrol Finansial GAIN
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center justify-center transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation - Redesigned to Pill Style */}
        <div className="p-4 bg-slate-100/70 dark:bg-slate-950/80 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            <button
              onClick={() => setActiveTab('members')}
              className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl font-bold transition flex items-center gap-2 border cursor-pointer ${
                activeTab === 'members'
                  ? 'bg-amber-500 text-slate-950 border-amber-600 shadow-sm'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Users className="w-4 h-4" />
              <span>Direktori Member ({members.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('vouchers')}
              className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl font-bold transition flex items-center gap-2 border cursor-pointer ${
                activeTab === 'vouchers'
                  ? 'bg-amber-500 text-slate-950 border-amber-600 shadow-sm'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Ticket className="w-4 h-4" />
              <span>Voucher Diskon Aktivasi</span>
            </button>

            <button
              onClick={() => setActiveTab('financial')}
              className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl font-bold transition flex items-center gap-2 border cursor-pointer ${
                activeTab === 'financial'
                  ? 'bg-cyan-500 text-slate-950 border-cyan-600 shadow-sm'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
              <span>Native BSC Control</span>
            </button>
          </div>
        </div>

        {/* Tab 1: Member Directory */}
        {activeTab === 'members' && (
          <>
            <form onSubmit={handlePromote} className="p-4 border-b border-slate-200 dark:border-slate-800 bg-amber-50/70 dark:bg-slate-900/40 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <span className="text-xs font-extrabold text-amber-900 dark:text-amber-400 whitespace-nowrap text-center sm:text-left">Angkat Admin Baru:</span>
              <input 
                type="email" 
                placeholder="Email calon admin..." 
                value={promoteEmail} 
                onChange={(e) => setPromoteEmail(e.target.value)} 
                className="flex-1 w-full px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-hidden focus:border-amber-500"
                required
              />
              <button 
                type="submit" 
                disabled={promoteLoading}
                className="w-full sm:w-auto px-4 py-1.5 bg-amber-500 hover:bg-amber-600 dark:hover:bg-amber-400 text-slate-950 font-extrabold text-xs rounded-lg disabled:opacity-50 cursor-pointer transition shadow-xs"
              >
                {promoteLoading ? 'Memproses...' : 'Jadikan Admin'}
              </button>
            </form>

            <div className="p-4 bg-slate-50 dark:bg-slate-950/50 border-b border-slate-200 dark:border-slate-800/80 flex flex-col sm:flex-row items-center justify-between gap-3">
              <div className="relative w-full sm:w-72">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Cari nama, ID, atau email..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:outline-hidden focus:border-amber-500 font-mono"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto font-mono text-xs">
                <button
                  onClick={() => setFilterStatus('all')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-extrabold transition cursor-pointer ${
                    filterStatus === 'all'
                      ? 'bg-amber-500 text-slate-950 shadow-xs'
                      : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border border-slate-300 dark:border-slate-800'
                  }`}
                >
                  Semua ({members.length})
                </button>
                <button
                  onClick={() => setFilterStatus('active')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-extrabold transition cursor-pointer ${
                    filterStatus === 'active'
                      ? 'bg-emerald-500 text-slate-950 shadow-xs'
                      : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border border-slate-300 dark:border-slate-800'
                  }`}
                >
                  Aktif ({members.filter((m) => m.accountStatus === 'active').length})
                </button>
                <button
                  onClick={() => setFilterStatus('non-active')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-extrabold transition cursor-pointer ${
                    filterStatus === 'non-active'
                      ? 'bg-rose-500 text-white shadow-xs'
                      : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border border-slate-300 dark:border-slate-800'
                  }`}
                >
                  Non-Aktif ({members.filter((m) => m.accountStatus === 'non-active').length})
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
              <div className="space-y-2">
                {loadError && (
                  <p className="py-5 text-center text-xs text-rose-500 dark:text-rose-300 font-bold">Direktori tidak dapat dimuat. Periksa koneksi server atau hak akses admin.</p>
                )}
                {!loadError && filteredMembers.length === 0 && (
                  <p className="py-5 text-center text-xs text-slate-500 dark:text-slate-400 font-medium">Belum ada data member di direktori.</p>
                )}
                {filteredMembers.map((member) => {
                  const isActive = member.accountStatus === 'active';
                  return (
                    <div
                      key={String(member.memberId ?? '-')}
                      className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 shadow-xs transition flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs font-mono"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-slate-200 dark:bg-slate-800 flex items-center justify-center font-bold text-amber-700 dark:text-amber-400 font-mono shrink-0">
                          {String(member.memberId ?? '---').slice(-3)}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-extrabold text-slate-900 dark:text-white text-sm">{String(member.username ?? 'Member')}</span>
                            <span className="text-[10px] text-amber-800 dark:text-amber-400 font-extrabold bg-amber-500/15 px-2 py-0.5 rounded-full border border-amber-400/30">
                              {String(member.memberId ?? '-')}
                            </span>
                            {member.role === 'admin' && (
                              <span className="text-[9px] text-cyan-800 dark:text-cyan-300 font-extrabold bg-cyan-500/20 px-1.5 py-0.5 rounded">
                                ADMIN
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-600 dark:text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5 font-medium">
                            <span>{String(member.emailMasked ?? '-')}</span>
                            <span>•</span>
                            <span>Sponsor: {member.sponsorId || 'GAIN Foundation'}</span>
                            <span>•</span>
                            <span>Bergabung: {String(member.joinedAt ?? '-')}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end">
                        {member.role === 'admin' && (
                          <button
                            onClick={() => handleDemote(member.memberId, member.userId, member.username)}
                            className="px-2 py-1 rounded-lg text-[10px] font-extrabold bg-rose-100 hover:bg-rose-200 text-rose-700 dark:bg-rose-900/30 dark:hover:bg-rose-900/50 dark:text-rose-400 transition"
                          >
                            Hapus Admin
                          </button>
                        )}
                        <span
                          className={`px-2.5 py-1 rounded-full text-[10px] font-extrabold border ${
                            isActive
                              ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border-emerald-500/40'
                              : 'bg-rose-500/15 text-rose-800 dark:text-rose-400 border-rose-500/40'
                          }`}
                        >
                          {isActive ? 'Aktif (Berbayar)' : 'Non-Aktif (Unpaid)'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Tab 2: Voucher Diskon Biaya Aktivasi */}
        {activeTab === 'vouchers' && (
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            <VoucherManagementPanel />
          </div>
        )}

        {/* Tab 3: Native BSC Control */}
        {activeTab === 'financial' && (
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            <FinancialWalletOperationsPanel />
          </div>
        )}

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs font-mono text-slate-600 dark:text-slate-400 font-semibold text-center sm:text-left">
          <span>Total Database: {members.length} Member Terdaftar</span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-extrabold bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 transition cursor-pointer"
          >
            Tutup Panel Admin
          </button>
        </div>
      </div>
    </div>
  );
}

