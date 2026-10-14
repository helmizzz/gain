# Laporan Audit & Bedah Sistem Mendalam - GAIN NiagaKoin v4.0.0

Dokumen ini menyajikan hasil audit teknis, analisis mendalam terhadap kode sumber (*whitebox code audit*), pemodelan ancaman (*threat modeling*), dan evaluasi arsitektural platform **GAIN NiagaKoin v4.0.0**.

---

## 1. Ringkasan Eksekutif & Metodologi Audit

### 1.1. Profil Sistem
- **Nama Repositori**: `gain-niagakoin-v4`
- **Versi Rilis**: `4.0.0`
- **Klasifikasi Platform**: Platform Perdagangan Kuantitatif Kripto Multi-Exchange & Kustodi Aset Digital
- **Prinsip Utama**: Zero-Trust Security, Fail-Closed Recovery, ACID Financial Source of Truth, Arsitektur 25 Layered Authorization.

### 1.2. Metodologi Audit
Audit dilakukan dengan menganalisis komponen utama:
1. **Analisis Algoritma**: Evaluasi matematis formula strategi trading, normalisasi deret waktu (OHLCV), dan fungsi kriptografi.
2. **Analisis Arsitektur & Logika**: Penilaian integritas state machine, pola konkurensi database, dan pemisahan lapisan otorisasi.
3. **Analisis Celah Duplikasi & Race Condition**: Pengujian logika terhadap vektor serangan double-spend, credit replay, dan parallel execution race.
4. **Pemodelan Ancaman (Threat Modeling)**: Identifikasi risiko eksploitasi, batas kegagalan dependensi eksternal, dan ketahanan terhadap crash.

---

## 2. Bedah Algoritma Inti Sistem

### 2.1. Algoritma Normalisasi & Agregasi Candle (`src/v2/engines/strategy/candleDriven.ts`)
Mesin strategi perdagangan digerakkan oleh data candle historis (*candle-driven*). Seringkali exchange kripto tidak menyediakan timeframe yang diinginkan (misalnya interval ganjil) atau mengembalikan data candle yang belum tertutup penuh (*unclosed bar*).

```typescript
// Implementasi bucket aggregation di candleDriven.ts
export function aggregateOhlcv(rows: OhlcvRow[], timeframe: StrategyTimeframe): OhlcvRow[] {
  const targetMs = STRATEGY_TIMEFRAME_MS[timeframe];
  const nativeMs = STRATEGY_TIMEFRAME_MS[nativeStrategyTimeframe(timeframe)];
  // Filter bucket: hanya bucket yang memuat jumlah bar penuh yang dipancarkan
  const expectedBars = targetMs / nativeMs;
  // Validasi kontinuitas waktu dan agregasi OHLCV
}
```

#### Keunggulan Algoritma:
- **Pencegahan Sinyal Palsu (*False Signal Guard*)**: Algoritma membuang candle yang belum selesai terbentuk (*partial candle*). Hal ini mencegah kalkulasi indikator mengeksekusi order prematur akibat lonjakan harga sesaat sebelum penutupan candle.
- **Deteksi Lubang Waktu (*Gap Detection*)**: Sistem memvalidasi bahwa selisih waktu antar bar asli persis sama dengan `nativeMs`. Jika terjadi gap data akibat exchange downtime, candle bucket dibatalkan dan tidak dievaluasi.

---

### 2.2. Algoritma DCA Martingale & Grid Trading Matrix
Logika penempatan layer averaging dan grid diatur dalam parameter konfigurasi yang ketat:
- **Deviasi Langkah (*Step Deviation*)**: Menghitung jarak persentase penurunan harga dari harga rata-rata masuk (*Average Entry Price*).
- **Pengganda Volume (*Volume Multiplier*)**: Menggunakan faktor geometri untuk melipatgandakan ukuran pesanan beli pada layer yang lebih rendah guna menarik harga rata-rata turun lebih cepat.
- **Trailing Take-Profit**: Saat harga menyentuh target profit, order jual tidak langsung dieksekusi secara instan, melainkan dipasang callback deviasi (*trailing callback pct*) untuk memaksimalkan potensi profit saat reli berlanjut.

---

### 2.3. Algoritma Kriptografi Kustodi On-Chain Native BSC (`src/server/nativeBscWallet.ts`)
Sistem mengelola dompet setoran dan hot wallet secara mandiri tanpa pihak ketiga kustodial:
- **Derivasi Deterministik BIP32 / BIP44 EVM**:
  - Menggunakan kurva eliptik `secp256k1` dari `@noble/curves` dan fungsi hash `keccak_256` dari `@noble/hashes`.
  - Path derivasi: `m/44'/60'/0'/0/${index}`.
  - Setiap pengguna diberikan alamat deposit unik secara on-the-fly dari seed master.
- **Enkripsi Kunci Privat (Authenticated AES-256-GCM)**:
  - Seed master dan kunci privat hot wallet tidak pernah disimpan dalam bentuk plaintext.
  - Menggunakan cipher mode Galois/Counter Mode (GCM) dengan initialization vector (IV 12-byte acak) dan Authentication Tag (16-byte). Hal ini mencegah serangan ciphertext tampering.

---

### 2.4. Algoritma Sidik Jari Kredensial Exchange (Anti-Duplication HMAC)
Untuk mencegah satu kunci API exchange digunakan oleh banyak akun GAIN yang berbeda:
$$\text{Fingerprint} = \text{HMAC-SHA256}(\text{MASTER\_PEPPER}, \text{apiKey})$$
Sidik jari ini diindeks dengan konstrain `UNIQUE` pada kolom `exchange_credentials.api_key_hash`. Upaya mengaitkan akun yang sama dari akun lain akan langsung diblokir di level database.

---

### 2.5. Algoritma Aritmetika Finansial Presisi Tinggi (BigInt Fixed-Point 10 Desimal)
Kesalahan fatal umum pada platform trading berbasis JavaScript/Node.js adalah pembulatan floating point IEEE 754 (contoh: `0.1 + 0.2 = 0.30000000000000004`).
GAIN mengeliminasi masalah ini secara mutlak pada seluruh perhitungan finansial saldo, deposit, dan withdrawal melalui fungsi:
- `parseAmountUnits(val, 10)`: Mengonversi string numerik menjadi `bigint` dengan pengali $10^{10}$.
- `formatAmountUnits(bigint, 10)`: Mengonversi kembali integer presisi tinggi ke representasi string desimal.

---

## 3. Bedah Arsitektur & Alur Logika

### 3.1. Arsitektur 25 & Model Otorisasi Berlapis
Arsitektur otorisasi dipisahkan menjadi hierarki modular:
1. **Identitas**: Validasi token JWT Firebase via Firebase Admin.
2. **Lifecycle Anggota**: Pemeriksaan status di PostgreSQL (`ACTIVE`, `SUSPENDED`, `CLOSED`).
3. **Hak Akses Lisensi**: Lisensi pengguna menentukan jumlah maksimum bot aktif (`max_active_bots`). Pengguna tanpa lisensi tetap dapat melihat dashboard namun tidak dapat menjalankan bot.
4. **Sesi Keamanan Elevasi (24 Jam)**: Aksi berisiko (menghubungkan API key, live order, withdrawal) mewajibkan verifikasi OTP email 6-digit. Sesi elevasi disimpan secara persisten di tabel `auth_session_elevations` di PostgreSQL sehingga sesi pengguna tidak hilang jika Redis di-restart.
5. **Otentikasi Dua Faktor (TOTP)**: Penarikan saldo dan rotasi API Key mewajibkan faktor kedua berbasis waktu (RFC 6238).

---

### 3.2. Pola Dual-Database: ACID Master vs Reactive Read-Model
- **PostgreSQL 16**: Berperan sebagai **Single Source of Truth (SSOT)**. Seluruh transaksi finansial, pesanan, posisi, dan reservasi eksekusi menggunakan transaksi ACID dengan tingkat isolasi kuat (*Row-Level Locking via `SELECT ... FOR UPDATE`*).
- **Cloud Firestore**: Berperan sebagai **Reactive Read-Model**. Perubahan saldo dan posisi di-mirror ke Firestore secara asinkron agar UI web React dapat menerima pembaruan secara real-time via listener WebSocket Firestore tanpa membebani pool koneksi PostgreSQL.

---

### 3.3. Execution Barrier & State Machine Pesanan
Sistem menerapkan finite state machine (FSM) yang kaku pada siklus hidup pesanan (`orderLifecycle.ts`):
```text
CREATED → SUBMITTING → SUBMITTED → FILLED → RECONCILED
                ↓           ↓
            CANCELLED    CANCELLED
```
Setiap transisi diverifikasi melalui `assertOrderTransition`. Transisi ilegal (misal dari `CREATED` langsung meloncat ke `FILLED`) akan memicu exception dan membatalkan transaksi.

---

## 4. Kelebihan Sistem (Architectural & Engineering Strengths)

| Aspek | Kelebihan Teknis |
| :--- | :--- |
| **Presisi Finansial Mutlak** | Penggunaan `bigint` fixed-point 10 desimal meniadakan akumulasi galat pembulatan desimal pada saldo dan komisi. |
| **Proteksi Crash Fail-Closed** | Default flag `BOT_STARTUP_AUTO_RESUME = false` menjamin bot tidak bertransaksi liar tanpa pengawasan setelah server crash. |
| **Pencegahan Double-Selling** | Tabel `order_execution_reservations` dengan kolom `reserved_quantity` mengunci unit koin sebelum order dikirim ke exchange. |
| **Zero-Secret Client Persistence** | Kredensial rahasia exchange dan seed dompet tidak pernah disimpan di `localStorage` atau cookie browser pengguna. |
| **Pemisahan Dana Regulasi** | Arsitektur segregasi rekening bank konsumen dan operasional perusahaan memenuhi prinsip kepatuhan POJK/OJK. |
| **Pemberian Persetujuan Ganda** | Penarikan dana bernilai besar mewajibkan *Dual-Officer Approval* (`WITHDRAWAL_APPROVAL_COUNT = 2`). |
| **Idempotensi Transaksi Menyeluruh** | Penggunaan `idempotency_key`, `client_order_id`, dan `tx_hash` unik menjamin pengiriman ulang HTTP tidak menimbulkan mutasi ganda. |
| **Quality Gate Terstandarisasi** | Repositori dilengkapi skrip gate terpadu (`doctor` 17/17 lolos, 5-stage exchange certification lab). |

---

## 5. Kelemahan Sistem & Potensi Hambatan (Weaknesses & Bottlenecks)

### 5.1. Monolithic Node.js Runner Loop
- **Deskripsi**: Loop eksekusi bot (`botRunnerLoop.ts`) berjalan di dalam thread event-loop proses Node.js yang sama dengan server Express HTTP.
- **Dampak Potensial**: Jika jumlah bot aktif bertambah hingga ribuan, kalkulasi candle dan pemanggilan jaringan exchange dapat menyebabkan *event-loop lag*, memperlambat latensi respon endpoint HTTP API.
- **Rekomendasi**: Pisahkan bot runner menjadi kluster worker independen menggunakan antrean terdistribusi (misalnya BullMQ / Redis Streams).

### 5.2. Ketergantungan BSC RPC Tunggal
- **Deskripsi**: File `nativeBscWallet.ts` mengandalkan satu nilai konfigurasi `BSC_RPC_URL`.
- **Dampak Potensial**: Jika endpoint RPC publik/node mengalami rate-limiting atau latensi tinggi, pemindaian deposit (`scanNativeBscDeposits`) dan pengiriman penarikan on-chain akan mengalami penundaan.
- **Rekomendasi**: Implementasikan RPC Load Balancer dengan mekanisme failover otomatis ke beberapa penyedia (Alchemy, QuickNode, Ankr).

### 5.3. Pemindaian On-Chain Berbasis Polling
- **Deskripsi**: Pendeteksian deposit dilakukan via polling berkala `eth_getLogs` dengan interval detik tertentu.
- **Dampak Potensial**: Pemindaian polling menambah beban request RPC dan memiliki jeda waktu (*propagation delay*) dibanding arsitektur berbasis WebSocket Event Subscription.

### 5.4. Firestore Mirror Eventual Consistency Drift
- **Deskripsi**: PostgreSQL adalah sumber kebenaran, sedangkan Firestore adalah cermin baca.
- **Dampak Potensial**: Jika koneksi Firebase mengalami *transient network drop* sesaat setelah transaksi PostgreSQL sukses di-commit, tampilan frontend mungkin terlambat beberapa saat hingga terjadi sinkronisasi berikutnya atau refresh manual.

---

## 6. Analisis Celah Duplikasi (Race Conditions) & Evaluasi Proteksi

### 6.1. Vektor 1: Double-Spending pada Order Jual Cepat (Rapid Sell Race)
- **Skenario Serangan**: Dua thread bot atau permintaan pengguna mengirim order jual (SELL) untuk koin yang sama secara simultan dalam milidetik yang sama.
- **Mekanisme Pertahanan GAIN**:
  ```sql
  SELECT p.id, p.quantity, p.reserved_quantity FROM positions p
  WHERE p.bot_id = $1 AND p.symbol = $2 FOR UPDATE;
  ```
  Sistem mengeksekusi `SELECT ... FOR UPDATE` pada baris posisi. Thread pertama akan menaikkan `reserved_quantity`. Thread kedua yang mengantre akan membaca nilai yang telah diperbarui dan langsung ditolak dengan kode `POSITION_QUANTITY_RESERVED`.
- **Status Evaluasi**: **AMAN (TERLINDUNGI DENGAN BAIK)**.

---

### 6.2. Vektor 2: Replay Attack Deposit On-Chain (Blockchain Replay)
- **Skenario Serangan**: Penyerang memicu endpoint deposit berkali-kali dengan payload hash transaksi yang sama untuk mengkreditkan saldo internal ganda.
- **Mekanisme Pertahanan GAIN**:
  Tabel `deposits` memiliki konstrain:
  ```sql
  CONSTRAINT deposits_network_tx_hash_key UNIQUE (network, tx_hash)
  ```
  Selain itu, fungsi `claimDeposit` memeriksa status klaim di PostgreSQL. Upaya memasukkan transaksi yang sama akan memicu galat `DEPOSIT_TX_ALREADY_CLAIMED`.
- **Status Evaluasi**: **AMAN (TERLINDUNGI DENGAN BAIK)**.

---

### 6.3. Vektor 3: Replay Aktivasi Lisensi & Tagihan Saldo
- **Skenario Serangan**: Pengguna mengklik tombol "Aktivasi Lisensi" berulang kali dalam jeda sangat cepat untuk membingungkan pengurangan saldo dompet.
- **Mekanisme Pertahanan GAIN**:
  Fungsi `activateLicenseAtomic` mewajibkan `idempotencyKey`. Jika kunci telah ada dalam basis data:
  ```typescript
  if (existing.rows[0]) {
    return { replayed: true, license: existing.rows[0] };
  }
  ```
  Sistem mengembalikan rekod yang ada tanpa mendebit ulang saldo dompet.
- **Status Evaluasi**: **AMAN (TERLINDUNGI DENGAN BAIK)**.

---

### 6.4. Vektor 4: Eksploitasi Kuota Voucher Promosi (Flash Claim Race)
- **Skenario Serangan**: Ribuan pengguna menggunakan skrip otomasi untuk mengklaim kode kupon diskon kuota terbatas (`remaining_uses = 1`) pada detik yang sama.
- **Mekanisme Pertahanan GAIN**:
  Baris kupon dikunci dengan `SELECT FOR UPDATE FROM vouchers WHERE code = $1`. Database PostgreSQL memastikan setiap request antre secara serial, memeriksa `remaining_uses > 0`, lalu menguranginya secara atomik.
- **Status Evaluasi**: **AMAN (TERLINDUNGI DENGAN BAIK)**.

---

### 6.5. Vektor 5: Penarikan Dana Ganda (Withdrawal Double Claim Worker Race)
- **Skenario Serangan**: Dua instance worker penarikan mencoba menandatangani dan menyiarkan transaksi penarikan yang sama.
- **Mekanisme Pertahanan GAIN**:
  Worker menggunakan mekanisme *processor lease locking*:
  ```sql
  UPDATE withdrawals 
  SET status = 'PROCESSING', processor_lease_until = now() + interval '60 seconds'
  WHERE id = $1 AND status = 'APPROVED'
  RETURNING id;
  ```
  Hanya satu worker yang berhasil mengklaim baris penarikan tersebut.
- **Status Evaluasi**: **AMAN (TERLINDUNGI DENGAN BAIK)**.

---

## 7. Analisis Ancaman & Eksploitasi (Threat Modeling)

### 7.1. Ancaman 1: Eksfiltrasi Master Encryption Key (`ENCRYPTION_MASTER_KEY`)
- **Tingkat Keparahan**: **KRITIS**
- **Deskripsi**: Jika server mengalami intrusi dan environment variable terbaca, penyerang berpotensi mendekripsi API Secret exchange dan kunci privat hot wallet.
- **Mitigasi Saat Ini**: Kunci enkripsi tidak pernah di-commit ke Git (`.gitignore`).
- **Rekomendasi Pertahanan Tambahan**: Gunakan AWS Secrets Manager / GCP Secret Manager atau integrasikan HashiCorp Vault. Untuk penandatanganan penarikan kripto, migrasikan hot wallet ke arsitektur Multi-Party Computation (MPC) seperti Fireblocks atau Qredo.

---

### 7.2. Ancaman 2: Flash Crash & Manipulasi Pasar Ekstrem (Price Spike Slippage)
- **Tingkat Keparahan**: **TINGGI**
- **Deskripsi**: Penurunan harga tajam sesaat (*wick*) dapat memicu eksekusi seluruh layer averaging secara sekaligus hingga menghabiskan seluruh modal.
- **Mitigasi GAIN**:
  1. Guardrail `min_price` dan `max_price`: Order dibatalkan jika harga berada di luar batas koridor aman.
  2. Guardrail `MAX_BOT_EXPOSURE_USDT`: Membatasi total modal yang dapat dialokasikan per bot.
  3. Guardrail `MAX_USER_DAILY_LOSS_USDT`: Jika kerugian harian terakumulasi menyentuh batas batas risiko, bot dihentikan secara otomatis (*Kill Switch*).

---

### 7.3. Ancaman 3: Kehabisan Gas BNB pada Hot Wallet Kustodi
- **Tingkat Keparahan**: **SEDANG**
- **Deskripsi**: Lonjakan permintaan penarikan USDT dapat menghabiskan saldo BNB hot wallet, menyebabkan transaksi transfer token gagal tertunda.
- **Mitigasi GAIN**:
  Sistem memiliki tabel `gas_auto_refill_configs` dan fungsi `processGasAutoRefills`. Ketika saldo BNB hot wallet berada di bawah ambang batas minimum, sistem secara otomatis mengirimkan BNB gas dari kas operasional ke hot wallet sebelum menandatangani transaksi penarikan.

---

### 7.4. Ancaman 4: Serangan Phishing & Session Hijacking
- **Tingkat Keparahan**: **TINGGI**
- **Deskripsi**: Penyerang mencuri cookie atau token akses pengguna melalui kebocoran browser.
- **Mitigasi GAIN**:
  1. Content Security Policy (CSP) ketat yang membatasi eksekusi skrip dari domain pihak ketiga.
  2. Sesi elevasi terlindungi IP Address dan User-Agent binding.
  3. Penarikan dana dan pengubahan API Key tetap memerlukan TOTP Authenticator fisik pengguna (tidak dapat ditembus hanya dengan mencuri token sesi login).

---

## 8. Rekomendasi Roadmap & Peningkatan Rekayasa Sistem

1. **Pemisahan Worker Antrean Terdistribusi**:
   - Dekopel `botRunnerLoop.ts` dan `nativeBscWallet.ts` dari proses Express monolith.
   - Gunakan BullMQ atau Temporal untuk mengelola orkestrasi worker bot secara horizontal agar dapat diskalakan ke ribuan bot tanpa hambatan performa.
2. **Multi-RPC Provider Fallback**:
   - Implementasikan kelas pembungkus RPC yang otomatis berpindah ke node cadangan jika node utama mengalami galat HTTP 429 (Rate Limit) atau timeout.
3. **Penyimpanan Kunci Berbasis HSM / MPC**:
   - Tingkatkan penandatanganan on-chain dari single-key AES-encrypted hot wallet menjadi modul keamanan berbasis perangkat keras (Cloud HSM) atau skema ambang batas TSS/MPC.
4. **Automated Reconciliation Circuit Breaker**:
   - Jika skrip `financial:reconcile` mendeteksi ketidaksesuaian saldo aset versus liabilitas di atas batas toleransi ($0), sistem secara otomatis menghentikan penarikan dana baru (*circuit breaker*) dan mengirimkan alert darurat ke kanal pengawas.
