# Master Operations & Runbook GAIN NiagaKoin v4.0.0

Dokumen ini menggabungkan seluruh panduan operasional, tata kelola operasi finansial regulasi, sertifikasi multi-exchange, proteksi pemulihan startup, dan alur pengembangan lokal ke dalam satu sumber terpadu.

---

## 1. Pengembangan & Eksekusi Lokal

### 1.1 Pemasangan Bersih (Clean Clone)

```bash
git clone <URL_REPOSITORI_GITHUB> gain-niagakoin-v4
cd gain-niagakoin-v4

npm ci
npm run setup:local
npm run env:check
npm run doctor
npm run lint
npm test
npm run test:core
npm run build
```

### 1.2 Mengelola Infrastruktur Lokal (PostgreSQL & Redis)

```bash
POSTGRES_HOST_PORT=5432 REDIS_HOST_PORT=6379 docker compose up -d postgres redis
```

Jika Redis native sudah berjalan pada port 6379, gunakan Redis native dan biarkan Redis Docker tetap mati:

```env
REDIS_URL=redis://127.0.0.1:6379
REDIS_REQUIRED=true
```

### 1.3 Perbaikan Dependensi & Reset Perdagangan Lokal

- **Perbaikan Dependensi Corrupt:**
  ```bash
  npm run repair:dependencies
  ```
  *Gunakan perintah ini daripada `rm -rf node_modules` manual.*

- **Reset Perdagangan Lokal (Clean Trading Start):**
  ```bash
  ALLOW_LOCAL_CLEAN_START=true npm run clean-start:local
  npm run dev
  ```
  *Perintah ini menghapus runtime bot/order tanpa merusak data akun, kredensial terenkripsi, atau buku besar dompet.*

---

## 2. Sertifikasi Multi-Exchange

### 2.1 Lima Tahapan Sertifikasi Exchange

Sertifikasi exchange dilakukan secara bertahap melalui lima tahapan:

1. `authenticated_readonly` — Pembacaan pasar, saldo, dan order terautentikasi tanpa pengiriman order.
2. `sandbox_demo_order` — Eksekusi limit order simulasi skala kecil pada environment Sandbox/Demo resmi.
3. `micro_live_order` — Order live skala mikro (secara bawaan non-aktif, membutuhkan konfirmasi 2FA & server gate).
4. `reconcile` — Pencocokan data order eksekusi dengan buku besar PostgreSQL.
5. `recovery` — Pengujian batas pemulihan otomatis setelah server di-restart.

### 2.2 Status Registry Exchange Terdaftar

| Exchange | Mode Sertifikasi | Keterangan Tambahan |
|---|---|---|
| **Binance** | `FULL` | Mendukung Spot Testnet resmi (`testnet.binance.vision`) |
| **Bitget** | `FULL` | Mendukung Demo Trading (`paptrading: 1`) dengan header khusus |
| **OKX** | `FULL` | Mendukung Demo Trading (`x-simulated-trading: 1`) |
| **Bybit** | `FULL` | Mendukung Bybit Testnet resmi (`testnet.bybit.com`) |
| **Indodax** | `FULL` | Spot market data, saldo akun, dan manajemen order |
| **Tokocrypto** | `FULL` | Spot market data, saldo akun, dan manajemen order |
| **Reku** | `READ_ONLY` | Pembacaan data pasar publik; tanpa adapter trading buatan |
| **Triv / Pintu Pro** | `BLOCKED_PENDING_NATIVE_API` | Terblokir sampai kontrak API native terverifikasi |

---

## 3. Pemulihan Startup & Pengiriman Email

### 3.1 Proteksi Pemulihan Startup (Fail-Closed)

Secara bawaan, jika server Node di-restart, runner bot yang sebelumnya aktif akan dipulihkan dalam status **`paused`** (`STARTUP_RESUME_REQUIRED`). Bot **tidak akan mengirimkan order baru** sampai dilanjutkan secara manual oleh pengguna.

Fitur *Auto-Resume* hanya aktif jika dua variabel dikonfigurasi secara sengaja di `.env`:

```env
BOT_STARTUP_AUTO_RESUME=true
BOT_STARTUP_AUTO_RESUME_CONFIRM=I_UNDERSTAND_STARTUP_AUTO_RESUME
```

### 3.2 Pengiriman Email OTP & Idempotensi

- Menggunakan helper terpusat `src/server/emailDelivery.ts`.
- Menggunakan `Idempotency-Key` Resend untuk mencegah pengiriman email ganda.
- Preflight domain pengirim dapat diuji dengan perintah: `npm run test:email`.

---

## 4. Tata Kelola Operasi Finansial & Regulasi

### 4.1 Persyaratan Kebijakan Regulasi (POJK / OJK)

Sebelum mengaktifkan `FINANCIAL_OPERATIONS_ENABLED=true`:
- Badan hukum, izin, dan ruang lingkup aktivitas harus disahkan oleh tim kepatuhan & penasihat hukum.
- Rekening dana konsumen wajib dibuka pada bank umum berizin OJK sesuai POJK 23/2025 Pasal 87 dan terpisah dari rekening operasional perusahaan.
- Prosedur KYC, screening sanksi/PEP, blockchain analytics/KYT, dan Travel Rule wajib aktif per transaksi.

### 4.2 Perintah Rekonsiliasi Keuangan Finansial

```bash
FINANCIAL_RECONCILIATION_OPERATOR="nama.operator" \
FINANCIAL_CUSTODY_SNAPSHOT_FILE="/path/to/custody.json" \
FINANCIAL_BANK_SNAPSHOT_FILE="/path/to/bank.json" \
npm run financial:reconcile -- --date 2026-10-08
```

---

## 5. Ringkasan Bukti Kesiapan & Rilis

| Pengujian / Gerbang | Status | Keterangan |
|---|---|---|
| `npm run doctor` | **LULUS (17/17)** | Konsistensi repositori & metadata versi v4.0.0 |
| `npm run lint` | **LULUS** | TypeScript `--noEmit` bersih tanpa error |
| `npm test` | **LULUS (55/55)** | Unit & integration test penuh |
| `release:architecture25-gate` | **LULUS (13/13)** | Gerbang otorisasi Arsitektur 25 |
| `release:roadmap-gate` | **LULUS (25/25)** | Gerbang kode sumber peta jalan |
| `npm run build` | **LULUS** | Kompilasi bundel produksi Vite bersih |
