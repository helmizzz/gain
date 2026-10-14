# Indeks Master Dokumentasi GAIN NiagaKoin v4.0.0

Seluruh dokumentasi proyek GAIN NiagaKoin v4.0.0 telah direstrukturisasi dan dikonsolidasikan ke dalam dokumen-dokumen utama berikut agar mudah dibaca, efisien, dan terpelihara secara konsisten.

## 📄 Dokumen Utama (Core Master Documents)

1. **[`README.md`](../README.md)** (Root)
   - Ringkasan utama aplikasi GAIN NiagaKoin v4.0.0, persyaratan runtime (Node 22, PostgreSQL 16, Redis 7+), alur pemasangan cepat, dan perintah verifikasi rilis.

2. **[`CONTRIBUTING.md`](../CONTRIBUTING.md)** (Root)
   - Panduan pengujian lokal dan aturan kontribusi repositori.

3. **[`docs/ARCHITECTURE.md`](ARCHITECTURE.md)** (Master Arsitektur)
   - **Arsitektur 25 & Model Otorisasi** (Lapisan 1-6, Sesi Security Elevation 24 jam, TOTP).
   - **Identitas Akun & Kepemilikan Data Exchange** (Fingerprint HMAC, Proteksi Duplikasi Akun, Skenario Rebind/Rotation).
   - **Spesifikasi Kustodi Native BSC USDT** (Penurunan Alamat HD EVM BIP32/BIP44, Pemindai Deposit & Hot Wallet Withdrawal Signer).
   - **Hambatan Eksekusi & Rekonsiliasi Posisi** (Execution Barrier, Settlement Idempotensial, Repair Ledger).

4. **[`docs/OPERATIONS.md`](OPERATIONS.md)** (Master Operasional & Runbook)
   - **Pengembangan & Runbook Lokal** (Pemasangan, Setup `.env`, Docker Compose, Reset Perdagangan Lokal, Perbaikan Dependensi).
   - **Sertifikasi Multi-Exchange** (5 Tahap Sertifikasi, Status Registry Exchange Global & Indonesia).
   - **Pemulihan Startup & Keamanan Email** (Proteksi Restart Fail-Closed, Auto-Resume Opt-In, Preflight Email Resend).
   - **Tata Kelola Operasi Finansial Regulasi** (Kepatuhan POJK/OJK, Bank Rekening Dana Konsumen, Skrip Rekonsiliasi).
   - **Bukti Rilis & Kesiapan Publik** (Ringkasan hasil test 55/55 LULUS & doctor 17/17 LULUS).

5. **[`docs/roadmap/ROADMAP-v2.5-PUBLIC-CERTIFICATION.md`](roadmap/ROADMAP-v2.5-PUBLIC-CERTIFICATION.md)** (Peta Jalan Aktif Proyek)
   - Satu-satunya peta jalan rilis & sertifikasi publik aktif proyek.

6. **[`docs/Flowchart_Gain.md`](Flowchart_Gain.md)** (Master Flowchart Sistem)
   - Flowchart Arsitektur 25, Bot Engine Loop & Execution Barrier, Kustodi On-Chain Native BSC, Fail-Closed Recovery, dan Lisensi Idempoten.

7. **[`docs/Usecase_Gain.md`](Usecase_Gain.md)** (Master Usecase & Spesifikasi)
   - Diagram Usecase interaktif, profil aktor, dan spesifikasi 15 use case lengkap beserta kondisi perkecualian (*exception flows*).

8. **[`docs/ERD_Gain.md`](ERD_Gain.md)** (Master ERD & Kamus Data)
   - Entity Relationship Diagram untuk seluruh 24 tabel PostgreSQL 16, relasi kardinalitas, kamus data lengkap, dan skema mirror Cloud Firestore.

9. **[`docs/Audit_Sistem_Gain.md`](Audit_Sistem_Gain.md)** (Laporan Audit & Bedah Sistem)
   - Analisis mendalam algoritma, arsitektur, kelemahan & hambatan, kelebihan, evaluasi celah duplikasi/race condition, pemodelan ancaman (*threat modeling*), dan rekomendasi roadmap teknis.

---

## 📦 Arsip Historis (Archive)

- **[`docs/archive/README.md`](archive/README.md)** — Arsip dokumen historis rilis terdahulu.
- **[`docs/archive/legacy/GAIN_NIAGA_KOIN_GO_PUBLIC_BLUEPRINT.txt`](archive/legacy/GAIN_NIAGA_KOIN_GO_PUBLIC_BLUEPRINT.txt)** — Cetak biru legacy publik.
