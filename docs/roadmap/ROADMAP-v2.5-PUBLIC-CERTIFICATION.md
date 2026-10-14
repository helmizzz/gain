# GAIN NiagaKoin v2.5 — Peta Jalan Sertifikasi Publik (Public Certification Roadmap)

## Tujuan

Ini adalah **satu-satunya peta jalan aktif** bagi repositori proyek setelah implementasi Arsitektur 25 pada versi v4.0.0. Dokumen ini menutup celah validasi eksternal sebelum peluncuran perdagangan langsung publik (live-trading) dilakukan.

## Fase 0 — Kebersihan Repositori & Rilis (Repository / Release Hygiene)

- [x] Implementasi Arsitektur 25 selesai dan diterapkan penuh.
- [x] Pemasangan dependensi lokal, pemeriksaan tipe/lint, unit/core/v2 test (55/55 LULUS), dan kompilasi *build* produksi terverifikasi.
- [x] Migrasi PostgreSQL 010 berhasil diterapkan dan diperiksa (`npm run db:check`).
- [x] Elevasi sesi keamanan runtime 24 jam terverifikasi melalui aksi terlindungi.
- [x] Seluruh audit statis dan rilis diselaraskan dengan Arsitektur 25 (`release:architecture25-gate` 13/13 LULUS).
- [x] README, metadata, Dockerfile, package manifest (`package.json`), dan lockfile selaras pada versi v4.0.0.
- [x] Artefak lokal dan folder kompilasi (`node_modules`, `dist`, `.env`) secara eksplisit dikecualikan dari Git dan paket rilis.

## Fase 1 — Sertifikasi Keamanan & Identitas

- [ ] Aturan Firebase Auth + Firestore Security Rules ditinjau ulang terhadap proyek produksi.
- [ ] Kredensial Firebase Admin diverifikasi di lingkungan staging.
- [ ] Perilaku kadaluwarsa / restart sesi elevasi keamanan terverifikasi secara penuh.
- [ ] Pendaftaran TOTP, pemulihan (recovery), dan gerbang aksi berisiko tinggi diverifikasi.
- [ ] Isolasi lintas akun dan lintas exchange terverifikasi penuh (`npm run test:exchange-isolation` LULUS).
- [ ] Kebijakan pembatasan laju (*rate-limit*) dan CORS ditinjau untuk domain publik.

## Fase 2 — Sertifikasi Exchange

Untuk setiap exchange yang didukung, kemampuan disertifikasi secara independen melalui 5 tahap:

1. `authenticated_readonly` — Pembacaan akun & data pasar terautentikasi;
2. `sandbox_demo_order` — Order simulasi pada Sandbox/Demo resmi exchange;
3. `reconcile` — Rekonsiliasi transaksi dengan PostgreSQL;
4. `recovery` — Pemulihan otomatis status order setelah restart;
5. `micro_live_order` — Hanya jika exchange tidak memiliki sandbox memadai dan di bawah gerbang server + 2FA + notional yang eksplisit.

Urutan Prioritas Exchange:

```text
Binance → OKX → Bybit → Bitget → retired-exchange → retired-exchange
Indodax → Tokocrypto → Bittime → Reku → Pintu Pro → Triv
```

> **Catatan:** Reku tetap dikhususkan read-only kecuali jika kontrak perdagangan native terverifikasi. Pintu Pro dan Triv tetap terblokir (*BLOCKED_PENDING_NATIVE_API*) sampai kontrak API native mereka diverifikasi.

## Fase 3 — Sertifikasi Integritas Finansial

Pengujian simulasi berulang (*replay*) dan pengujian konkurensi untuk:
- Aktivasi lisensi;
- Deposit (Native BSC USDT BEP-20);
- Penarikan (Withdrawal);
- Transfer internal / P2P;
- Top-up saldo gas;
- Penyelesaian referral;
- Pemisian ulang otomatis (*auto-refill*).

Invarian Finansial:
```text
satu event bisnis = satu mutasi finansial yang atomik
```

## Fase 4 — E2E Perdagangan & Rekonsiliasi (Trading E2E)

- [x] Pemindai dan penanda tangan penarikan Native BSC USDT terimplementasi dengan pengujian regresi deterministik.
- [ ] Pengujian E2E Binance Testnet terautentikasi melalui gateway GAIN.
- [ ] Alur BUY/create → verifikasi → pengisian parsial → status FILLED / CANCELLED / UNKNOWN.
- [ ] Idempotensi `clientOrderId` dan pemulihan pembuatan order yang ambigu.
- [ ] Rekonsiliasi posisi setelah terjadi selisih (*mismatch*).
- [ ] Rekonsiliasi penutupan parsial manual / Force TP.
- [x] Isolasi penuh antara akun dan exchange.

## Fase 5 — Kaos & Pemulihan (Chaos and Recovery)

Pengujian dengan menyuntikkan skenario gangguan:
- Timeout API exchange;
- Keterlambatan respons WebSocket;
- Terputusnya koneksi Redis;
- Restart kontainer PostgreSQL;
- Restart worker / API server;
- Permintaan ganda (*duplicate requests*);
- Pengisian parsial (*partial fill*).

Ekspektasi Hasil:
- Tidak ada order ganda;
- Tidak ada pendebitan ganda pada buku besar;
- Tidak ada posisi yang hilang;
- Tidak ada klaim sukses palsu;
- Rekonsiliasi berhasil memulihkan status.

## Fase 6 — Pengujian Daya Tahan (Soak Test)

Jalankan sistem selama 24–72 jam di Testnet dengan pemantauan terhadap:
- Order & pengisian (*fills*);
- Pergeseran saldo / posisi (*drift*);
- Pergeseran buku besar (*ledger drift*);
- Restart worker;
- Penggunaan Memori & CPU;
- Koneksi PostgreSQL;
- Penggunaan Redis;
- Status koneksi WebSocket;
- Tingkat error HTTP (4xx / 5xx) dan latensi respons.

## Fase 7 — Beta Tertutup (Closed Beta)

Target 5–20 pengguna teruji yang dikontrol. Perdagangan live tetap non-aktif secara bawaan, mengutamakan Testnet, penarikan di bawah kontrol prosesor, dan pencatatan audit rinci.

## Fase 8 — Beta Publik (Public Beta)

Pendaftaran bertahap, pembatasan laju (*rate limit*), prosedur dukungan pengguna, respons insiden, alur *rollback*, pencadangan data, pemantauan, dan alur pengaktifan live yang terkontrol.

## Fase 9 — Gerbang Go-Live Produksi

Tidak ada pernyataan kesiapan produksi *live* sampai:
- Nol masalah P0 yang belum terselesaikan;
- Nol masalah P1 yang mempengaruhi integritas finansial/perdagangan;
- Sertifikasi exchange yang dipersyaratkan LULUS;
- Pengujian finansial *replay* LULUS;
- Pengujian *chaos / recovery* LULUS;
- Pengujian *soak* 24–72 jam LULUS;
- Pengujian *backup / restore* LULUS;
- Kredensial produksi dan kontrol akses terverifikasi;
- Runbook operator dan prosedur respons insiden tersedia;
- Fitur perdagangan live tetap dibatasi secara eksplisit dan dapat diaudit.
