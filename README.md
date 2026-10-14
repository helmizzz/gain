# GAIN NiagaKoin v4.0.0

GAIN adalah platform perdagangan kuantitatif (*quantitative trading*) dan eksekusi algoritmik yang dilengkapi dengan proteksi peluncuran bot, pengujian historis (*backtesting*), sertifikasi multi-exchange, kontrol buku besar finansial (*financial ledger*), pemulihan otomatis (*recovery*), dan otorisasi Arsitektur 25.

> **Status Rilis:** Kandidat Rekayasa / Testnet (*Engineering Candidate*). Peluncuran publik perdagangan langsung (*live-trading*) membutuhkan sertifikasi eksternal.

## Arsitektur 25

Model otorisasi aplikasi dipisahkan secara ketat ke dalam beberapa lapisan independen:

```text
Otentikasi Google / Firebase
        ↓
Siklus Hidup Anggota GAIN (Member Lifecycle)
        ↓
Hak Akses Lisensi (License Entitlement)
        ↓
Dashboard / Fitur Non-Lisensi
        ↓
Elevasi Keamanan (OTP Email 6-Digit, Sesuai Kebutuhan Sesi 24 Jam)
        ↓
TOTP / 2FA (Untuk Tindakan Berisiko Tinggi)
        ↓
Gerbang Kredensial Exchange + Risiko + Runtime
        ↓
Eksekusi Live / Testnet
```

Pengguna tanpa lisensi aktif dapat berotentikasi dan membuka dashboard. OTP Email **bukan** gerbang login/dashboard utama, melainkan sesi keamanan elevated 24 jam yang diminta hanya saat melakukan tindakan terlindungi.

Lihat dokumentasi arsitektur lengkap di [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Struktur Dokumen Repositori

Dokumentasi proyek telah dikonsolidasikan secara ringkas dan efisien:

```text
docs/
├── ARCHITECTURE.md  # Master Arsitektur 25, Identitas Exchange, Kustodi Native BSC, & Rekonsiliasi
├── OPERATIONS.md    # Master Runbook Lokal, Sertifikasi Exchange, Pemulihan Startup, & Keuangan Regulasi
├── INDEX.md         # Indeks Dokumentasi Terstruktur
├── roadmap/         # Peta Jalan Aktif (ROADMAP-v2.5-PUBLIC-CERTIFICATION.md)
└── archive/         # Arsip Historis (Legacy Blueprint & Dokumen Terdahulu)
```

Satu-satunya peta jalan aktif adalah [`docs/roadmap/ROADMAP-v2.5-PUBLIC-CERTIFICATION.md`](docs/roadmap/ROADMAP-v2.5-PUBLIC-CERTIFICATION.md).

## Persyaratan Runtime

- Node.js **22 LTS** (gambar Docker proyek menggunakan Node 22)
- npm **10.x** (repositori ini mengunci `npm@10.9.2` via `packageManager`)
- Git
- PostgreSQL 16
- Redis 7+ (Docker atau Redis lokal yang kompatibel)
- Proyek Firebase dengan Otentikasi Google + Firestore
- Kredensial Firebase Admin melalui Application Default Credentials atau `GOOGLE_APPLICATION_CREDENTIALS`

## Alur Pemasangan Bersih (Clean Clone)

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

Jika struktur dependensi lokal mengalami kendala, gunakan perintah perbaikan lintas platform repositori:

```bash
npm run repair:dependencies
```

## Verifikasi Kode & Gerbang Rilis (Release Gates)

```bash
npm run doctor
npm run lint
npm test
npm run test:core
npm run test:v2
npm run release:roadmap-gate
npm run release:architecture25-gate
npm run test:exchange-certification-stages
npm run release:public-audit
node scripts/security-audit.mjs
npm run build
```

Untuk panduan operasional lengkap, lihat [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
