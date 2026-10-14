# Master Usecase Diagram & Spesifikasi - GAIN NiagaKoin v4.0.0

Dokumen ini memetakan seluruh interaksi fungsional antara aktor dan sistem pada platform **GAIN NiagaKoin v4.0.0**. Dokumentasi ini dirancang agar mudah ditelusuri oleh pengembang, auditor sistem, maupun tim QA.

---

## 1. Diagram Usecase Sistem (Mermaid Format)

```mermaid
graph LR
    %% Definisi Aktor
    User["👤 Pengguna / Trader Terotentikasi"]
    Guest["👤 Pengunjung / Guest"]
    Admin["🛡️ Petugas Finansial / Compliance"]
    Engine["⚙️ Mesin Eksekusi Bot (System)"]
    ChainWorker["⛓️ Kustodi BSC & RPC Worker (System)"]
    Exchange["🏦 Exchange Kripto Eksternal (CCXT)"]

    %% Usecase Autentikasi & Keanggotaan
    subgraph Manajemen_Akun_dan_Keamanan [Manajemen Akun & Keamanan (Arsitektur 25)]
        UC01["UC-01: Otentikasi Google / Firebase"]
        UC02["UC-02: Elevasi Sesi Keamanan (Email OTP 24 Jam)"]
        UC03["UC-03: Setup & Validasi 2FA TOTP"]
        UC04["UC-04: Binding Kredensial Exchange (HMAC Fingerprint)"]
    end

    %% Usecase Lisensi & Promosi
    subgraph Lisensi_dan_Voucher [Lisensi & Program Promosi]
        UC05["UC-05: Aktivasi Paket Lisensi (Idempoten)"]
        UC06["UC-06: Penukaran Voucher Promosi"]
        UC07["UC-07: Klaim Bonus Sponsor & Referral"]
    end

    %% Usecase Trading & Bot Engine
    subgraph Operasi_Bot_dan_Trading [Operasi Bot Trading & Analisis]
        UC08["UC-08: Konfigurasi Parameter Bot (DCA/Grid)"]
        UC09["UC-09: Kontrol Bot (Start / Pause / Stop)"]
        UC10["UC-10: Evaluasi Sinyal & Eksekusi Order Otomatis"]
        UC11["UC-11: Pengujian Historis Strategi (Backtesting)"]
        UC12["UC-12: Rekonsiliasi & Karantina Drift Posisi"]
    end

    %% Usecase Dompet Finansial & Kustodi
    subgraph Finansial_dan_Kustodi_BSC [Finansial, Buku Besar, & Kustodi BSC]
        UC13["UC-13: Pembuatan Alamat Deposit HD EVM (BIP44)"]
        UC14["UC-14: Pemindaian & Pengkreditan Deposit Otomatis"]
        UC15["UC-15: Pengajuan Penarikan Dana (Withdrawal)"]
        UC16["UC-16: Persetujuan Ganda Penarikan (Dual-Approval)"]
        UC17["UC-17: Penandatanganan & Broadcast On-Chain BSC"]
        UC18["UC-18: Audit Buku Besar & Rekonsiliasi Cadangan"]
    end

    %% Hubungan Aktor ke Usecase
    Guest --> UC01
    User --> UC01
    User --> UC02
    User --> UC03
    User --> UC04
    User --> UC05
    User --> UC06
    User --> UC07
    User --> UC08
    User --> UC09
    User --> UC11
    User --> UC13
    User --> UC15

    Admin --> UC16
    Admin --> UC18

    Engine --> UC10
    Engine --> UC12
    UC10 --> Exchange
    UC12 --> Exchange

    ChainWorker --> UC14
    ChainWorker --> UC17
```

---

## 2. Rincian Aktor Sistem

| Aktor | Tipe | Deskripsi & Peran |
| :--- | :--- | :--- |
| **Guest / Pengunjung** | Manusia | Pengguna baru yang belum berotentikasi. Hanya dapat mengakses halaman login dan publikasi umum. |
| **Trader Terotentikasi** | Manusia | Pengguna terdaftar yang memiliki status `ACTIVE`. Dapat mengakses dashboard, backtest, dan fitur berlisensi sesuai paket yang dimiliki. |
| **Petugas Finansial (Admin)**| Manusia | Pejabat berwenang dengan hak akses peran internal untuk menyetujui transaksi penarikan dana berskala besar dan menjalankan audit buku besar. |
| **Mesin Bot Trading (Engine)**| Sistem | Background service yang memonitor pasar secara berkelanjutan, menghitung matriks indikator, memicu order, dan memvalidasi reservasi eksekusi. |
| **Kustodi BSC Worker** | Sistem | Background worker berkala yang memindai rantai blok (*blockchain logs*), mengelola saldo gas BNB, dan menandatangani transaksi transfer BEP-20. |
| **Exchange Provider** | Eksternal | Penyedia likuiditas kripto (Binance, Tokocrypto, Indodax, dll.) yang mengeksekusi order spot via protokol CCXT REST/WebSocket. |

---

## 3. Spesifikasi Detail Usecase

### UC-01: Otentikasi Google / Firebase
- **Aktor Utama**: Guest, Trader Terotentikasi.
- **Deskripsi**: Masuk ke dalam platform menggunakan akun Google Identity Platform via Firebase Auth SDK.
- **Pre-kondisi**: Pengguna memiliki koneksi internet dan akun Google aktif.
- **Alur Utama**:
  1. Pengguna menekan tombol "Login dengan Google".
  2. Firebase Client SDK menampilkan popup otentikasi Google OAuth.
  3. Pengguna menyetujui akses akun.
  4. Firebase Client menerbitkan ID Token JWT dan mengirimkannya ke header backend (`Authorization: Bearer <Token>`).
  5. Backend memvalidasi token menggunakan Firebase Admin SDK.
  6. Backend memeriksa tabel `users` di PostgreSQL:
     - Jika pengguna baru: membuat entitas pengguna baru dengan `member_status = 'active'`, tier lisensi `none`, dan alokasi bot `0`.
     - Jika pengguna lama: memverifikasi apakah `member_status` adalah `ACTIVE`.
  7. Backend mengembalikan status profil pengguna, hak lisensi, dan hak akses dashboard.
- **Alur Alternatif / Exception**:
  - `E-01 (MEMBER_SUSPENDED)`: Pengguna dalam status penangguhan diblokir dengan respons HTTP 403.
  - `E-02 (MEMBER_CLOSED)`: Pengguna yang telah dinonaktifkan permanen ditolak dengan respons HTTP 403.
- **Post-kondisi**: Pengguna masuk ke Dashboard dengan profil read-model tersinkronisasi.

---

### UC-02: Elevasi Sesi Keamanan (Email OTP 24 Jam)
- **Aktor Utama**: Trader Terotentikasi.
- **Aktor Sistem**: Layanan Pengiriman Email (Resend).
- **Deskripsi**: Meminta sesi keamanan berdurasi 24 jam untuk membuka hak aksi terlindungi (Arsitektur 25).
- **Pre-kondisi**: Pengguna telah login (UC-01) dan mencoba mengakses aksi terlindungi saat sesi elevasi tidak aktif/kedaluwarsa.
- **Alur Utama**:
  1. Klien mendeteksi respons `SESSION_ELEVATION_REQUIRED` dari server.
  2. Dialog modal keamanan muncul, memicu permintaan pengiriman kode verifikasi ke endpoint `/api/auth/send-login-code`.
  3. Server membuat kode OTP 6-digit acak secara kriptografis, mengenkripsi kode dengan salt dan masa berlaku 15 menit, lalu menyimpannya di basis data.
  4. Server mengirimkan email kode OTP ke email pengguna terdaftar menggunakan penyedia Resend dengan kunci idempotensi email.
  5. Pengguna membaca email dan memasukkan 6 digit kode ke antarmuka aplikasi.
  6. Klien mengirim kode ke `/api/auth/verify-login-code`.
  7. Server memvalidasi kecocokan kode dan mencatat entri sesi baru di `auth_session_elevations` (PostgreSQL) dengan masa kedaluwarsa 24 jam.
  8. Server menetapkan cookie sesi terenkripsi atau token sesi elevasi.
- **Alur Alternatif / Exception**:
  - `E-01 (INVALID_CODE)`: Pengguna memasukkan kode yang salah; server menambah penghitung percobaan (*attempts*).
  - `E-02 (MAX_ATTEMPTS_EXCEEDED)`: Percobaan salah melebihi 5 kali; kode dibatalkan dan pengguna harus meminta kode baru setelah cooldown.
- **Post-kondisi**: Pengguna memiliki sesi elevasi aktif selama 24 jam yang tahan banting terhadap *restart* Redis.

---

### UC-03: Setup & Validasi 2FA TOTP
- **Aktor Utama**: Trader Terotentikasi.
- **Deskripsi**: Menghubungkan aplikasi Google Authenticator/Authy untuk otentikasi dua faktor pada penarikan dana dan pengelolaan kunci API.
- **Pre-kondisi**: Pengguna memiliki sesi elevasi aktif (UC-02).
- **Alur Utama**:
  1. Pengguna membuka menu Pengaturan Akun -> Keamanan 2FA.
  2. Server membuat secret TOTP baru (Base32) dan menghasilkan QR Code.
  3. Secret disimpan dalam status `PENDING` di tabel `security_credentials`.
  4. Pengguna memindai QR Code di aplikasi Authenticator ponsel mereka.
  5. Pengguna memasukkan 6-digit kode verifikasi yang muncul di ponsel.
  6. Server memverifikasi kode menggunakan window waktu -1/+1 langkah 30 detik.
  7. Jika valid, secret dienkripsi menggunakan AES-256-GCM dan status diperbarui menjadi `ENABLED`.
- **Post-kondisi**: 2FA aktif dan wajib disertakan pada setiap penarikan dana dan perubahan kredensial exchange.

---

### UC-04: Binding Kredensial Exchange (HMAC Fingerprint)
- **Aktor Utama**: Trader Terotentikasi.
- **Aktor Eksternal**: Exchange Kripto (Binance, Indodax, dll.).
- **Deskripsi**: Menyimpan kredensial API Key & Secret exchange dengan pencegahan penggunaan ganda akun (*anti-duplication*).
- **Pre-kondisi**: Pengguna memiliki sesi elevasi aktif dan lulus validasi 2FA TOTP.
- **Alur Utama**:
  1. Pengguna memasukkan API Key, API Secret, dan Passphrase (jika ada) serta memilih mode (Sandbox atau Live).
  2. Backend menghitung sidik jari kriptografis (*HMAC Fingerprint*) dari API Key menggunakan master pepper.
  3. Backend memeriksa tabel `exchange_credentials`:
     - Jika fingerprint telah terdaftar pada pengguna lain: sistem menolak pendaftaran (*CREDENTIAL_ALREADY_BOUND*).
  4. Backend menguji validitas kredensial ke exchange terkait melalui koneksi read-only `fetchBalance()` CCXT.
  5. Jika koneksi berhasil, API Secret dienkripsi dengan AES-256-GCM dan disimpan di `exchange_credentials`.
  6. Entri riwayat dicatat di `exchange_credential_history`.
- **Alur Alternatif / Exception**:
  - `E-01 (API_KEY_INVALID)`: Kredensial ditolak oleh exchange (pesan error diteruskan dengan aman tanpa membocorkan kunci rahasia).
  - `E-02 (DUPLICATE_KEY_DETECTED)`: Kunci API terdeteksi digunakan di akun GAIN yang berbeda. Sistem memblokir pendaftaran untuk mencegah duplikasi saldo & manipulasi referral.
- **Post-kondisi**: Akun exchange terhubung dan siap digunakan oleh bot trading pengguna.

---

### UC-05: Aktivasi Paket Lisensi (Idempoten)
- **Aktor Utama**: Trader Terotentikasi.
- **Deskripsi**: Membeli atau mengaktifkan paket lisensi bot (Starter, Pro, Elite) menggunakan saldo USDT dompet internal secara atomik.
- **Pre-kondisi**: Pengguna memiliki saldo USDT yang mencukupi atau diskon voucher 100%.
- **Alur Utama**:
  1. Pengguna memilih paket lisensi (contoh: Pro - 12 Bot, Durasi 30 Hari).
  2. Klien mengirim permintaan aktivasi dengan menyertakan `idempotencyKey` unik (UUIDv4).
  3. Server membuka transaksi database PostgreSQL `BEGIN TRANSACTION`.
  4. Server mengunci baris lisensi pengguna dengan `SELECT FOR UPDATE FROM licenses WHERE user_id = $1`.
  5. Server memeriksa apakah `idempotencyKey` sudah pernah diproses:
     - Jika ya: mengembalikan data transaksi sebelumnya (`replayed: true`).
  6. Server mendebit saldo dompet di `wallet_accounts` dan mencatat mutasi pengeluaran di `wallet_ledger`.
  7. Server memperbarui tier lisensi, status `ACTIVE`, dan menghitung tanggal kedaluwarsa baru.
  8. Server mengalokasikan bonus sponsor & komisi referral ke sponsor pengguna di tabel `referral_events`.
  9. Server memperbarui Firestore read-model untuk menyinkronkan status klien secara instan.
  10. Server melakukan `COMMIT TRANSACTION`.
- **Post-kondisi**: Lisensi aktif, slot bot terbuka, dan saldo dompet berkurang secara tepat tanpa risiko double-charge.

---

### UC-06: Penukaran Voucher Promosi
- **Aktor Utama**: Trader Terotentikasi.
- **Deskripsi**: Mengklaim kode voucher potongan harga lisensi atau promosi gratis.
- **Pre-kondisi**: Pengguna memiliki kode voucher yang valid.
- **Alur Utama**:
  1. Pengguna memasukkan string kode voucher (contoh: `LAUNCH50`).
  2. Server mengunci baris voucher di `vouchers` menggunakan `FOR UPDATE`.
  3. Server memverifikasi status: voucher aktif, tanggal kedaluwarsa belum lewat, dan `remaining_uses > 0`.
  4. Server memeriksa apakah `user_id` telah tercatat di `voucher_redemptions`.
  5. Jika belum pernah, server mendiskon tagihan pembelian lisensi, mengurangi `remaining_uses`, dan mencatat klaim di `voucher_redemptions`.
- **Alur Alternatif / Exception**:
  - `E-01 (VOUCHER_QUOTA_EXHAUSTED)`: Kuota voucher habis.
  - `E-02 (VOUCHER_ALREADY_USED)`: Pengguna telah menggunakan voucher tersebut sebelumnya.
- **Post-kondisi**: Diskon diterapkan pada kalkulasi tagihan lisensi pengguna.

---

### UC-07: Konfigurasi Parameter Bot (DCA & Grid)
- **Aktor Utama**: Trader Terotentikasi.
- **Deskripsi**: Menentukan pasangan mata uang, modal maksimum, batas harga, jumlah layer averaging, dan target take-profit bot.
- **Pre-kondisi**: Pengguna memiliki lisensi aktif dan kuota slot bot belum melampaui batas maksimum (`activeBots < maxActiveBots`).
- **Alur Utama**:
  1. Pengguna memilih pasangan koin (contoh: `BTC/USDT`), tipe strategi (`Avarage Only`, `Grid Only`, atau `Avarage+Grid`).
  2. Pengguna mengatur parameter: `base_order_usd`, `take_profit_pct`, `step_deviation_pct`, `volume_multiplier`, `max_capital_usd`, `min_price`, dan `max_price`.
  3. Klien mengevaluasi parameter terhadap guardrail risiko (`assessStrategyRisk`).
  4. Klien mengirim konfigurasi ke `/api/bots`.
  5. Server memvalidasi kepemilikan akun exchange, memastikan simbol didukung oleh exchange terkait, dan menyimpan konfigurasi ke `bots` dan `bot_strategy_configs`.
- **Post-kondisi**: Bot tersimpan dalam status `CONFIGURED` / `PAUSED`.

---

### UC-08: Kontrol Bot (Start / Pause / Stop)
- **Aktor Utama**: Trader Terotentikasi.
- **Aktor Sistem**: Mesin Eksekusi Bot.
- **Deskripsi**: Mengaktifkan mesin eksekusi bot atau menghentikannya secara aman.
- **Pre-kondisi**: Akun exchange terhubung dan saldo gas pengguna mencukupi batas minimum cadangan.
- **Alur Utama**:
  1. Pengguna menekan tombol "Start Bot".
  2. Server memvalidasi:
     - Kredensial exchange aktif dan valid.
     - Lisensi pengguna aktif.
     - Cadangan saldo gas operasional (*Gas Reserve*) mencukupi (`checkUserGasReserveStatus`).
     - Alokasi modal tidak melebihi batas portofolio harian.
  3. Server memperbarui status bot di `bots` menjadi `RUNNING`.
  4. Server mendaftarkan instance runner bot ke `activeBotsRegistry` dalam memori server.
  5. Mesin loop bot mulai menyertakan bot ini dalam setiap iterasi evaluasi sinyal.
- **Alur Alternatif (Pause / Stop)**:
  - Saat bot dihentikan (*Stop*), server melepaskan sewa (*lease*), membatalkan order terbuka yang belum terisi di exchange, dan menandai status bot menjadi `STOPPED`.
- **Post-kondisi**: Bot aktif bertransaksi secara otomatis di pasar.

---

### UC-09: Evaluasi Sinyal & Eksekusi Order Otomatis
- **Aktor Utama**: Mesin Eksekusi Bot (System Actor).
- **Aktor Eksternal**: Exchange Kripto (CCXT).
- **Deskripsi**: Mengevaluasi pergerakan candle OHLCV, memeriksa batas deviasi layer, mengunci reservasi posisi, dan mengirim order ke exchange.
- **Pre-kondisi**: Bot berstatus `RUNNING`.
- **Alur Utama**:
  1. Worker bot menarik harga terkini melalui WebSocket atau REST API publik.
  2. Normalisasi candle dilakukan melalui `aggregateOhlcv` untuk menjamin hanya candle yang telah tertutup penuh yang dievaluasi.
  3. Algoritma DCA/Grid menghitung apakah harga menyentuh layer deviasi beli baru atau menyentuh target take-profit.
  4. Jika kondisi terpenuhi:
     - Sistem membuat `order_id` unik dan memanggil `reserveOrderExecution`.
     - Baris posisi di PostgreSQL dikunci (`SELECT ... FOR UPDATE`).
     - Jika order SELL, sistem memvalidasi ketersediaan `quantity - reserved_quantity` dan menaikkan `reserved_quantity`.
  5. Sistem mengirimkan order ke exchange via CCXT dengan `client_order_id` identik dengan `order_id` lokal.
  6. Ketika order berhasil dieksekusi di exchange (*FILLED*):
     - Sistem mencatat transaksi di tabel `fills`.
     - Menghitung ulang rata-rata harga masuk (*average entry*) dan PnL pada tabel `positions`.
     - Mengubah status reservasi di `order_execution_reservations` menjadi `SETTLED`.
     - Menyinkronkan pembaruan ke Firestore read-model untuk antarmuka pengguna.
- **Alur Alternatif / Exception**:
  - `E-01 (INSUFFICIENT_POSITION_RESERVE)`: Upaya sell dibatalkan seketika jika kuantitas koin telah direservasi oleh order sebelumnya.
  - `E-02 (EXCHANGE_TIMEOUT)`: Order diberi status `RECONCILING` dan diverifikasi pada siklus iterasi berikutnya melalui query `client_order_id`.
- **Post-kondisi**: Transaksi terekam dengan akurat di buku besar posisi tanpa risiko overfill atau double-execution.

---

### UC-10: Pengujian Historis Strategi (Backtesting)
- **Aktor Utama**: Trader Terotentikasi.
- **Deskripsi**: Mensimulasikan performa strategi trading pada data harga historis candle tanpa risiko modal nyata.
- **Pre-kondisi**: Pengguna membuka halaman Backtest Workspace.
- **Alur Utama**:
  1. Pengguna memilih koin, rentang tanggal historis, timeframe candle (misal 5m, 15m, 1h), modal awal, dan parameter DCA/Grid.
  2. Klien atau server menarik histori OHLCV pasar dari cache atau arsip exchange.
  3. Mesin `backtestService` menjalankan simulasi bar per bar (*tick-by-tick / candle-by-candle*).
  4. Mesin menghitung metrik performa: Total Keuntungan (PnL USD & %), Maksimum Penurunan Modal (*Max Drawdown*), Win Rate, Rata-rata Durasi Floating, dan Total Layer yang Tereksekusi.
  5. Menampilkan grafik kurva ekuitas (*equity curve*) dan riwayat simulasi order.
- **Post-kondisi**: Pengguna memperoleh wawasan performa sebelum mengaktifkan bot di pasar nyata.

---

### UC-11: Pembuatan Alamat Deposit HD EVM (BIP44)
- **Aktor Utama**: Trader Terotentikasi.
- **Deskripsi**: Menghasilkan alamat deposit setoran BEP-20 USDT unik yang terikat secara permanen ke akun pengguna.
- **Pre-kondisi**: Pengguna telah terotentikasi dan membuka menu Deposit Dompet.
- **Alur Utama**:
  1. Pengguna membuka tampilan Dompet -> Setor Saldo.
  2. Server memeriksa apakah pengguna telah memiliki alamat deposit terdaftar di `wallet_deposit_addresses`.
  3. Jika belum:
     - Server mengambil indeks derivasi berikutnya secara atomik.
     - Server mendekripsi seed master kustodi menggunakan AES-256-GCM.
     - Server menurunkan pasangan kunci baru melalui path BIP44: `m/44'/60'/0'/0/${index}` menggunakan kurva secp256k1 dan hashing Keccak-256.
     - Alamat publik disimpan di `wallet_deposit_addresses` dan dihubungkan ke `user_id`. Kunci privat langsung dibuang dari memori.
  4. Server menampilkan alamat publik (format 0x...) dan QR Code kepada pengguna.
- **Post-kondisi**: Pengguna memiliki alamat setoran unik untuk menerima dana USDT BEP-20.

---

### UC-12: Pemindaian & Pengkreditan Deposit Otomatis
- **Aktor Utama**: Kustodi BSC Worker (System Actor).
- **Aktor Eksternal**: BNB Smart Chain RPC Provider.
- **Deskripsi**: Mendeteksi transfer on-chain USDT ke alamat pengguna dan mengkreditkan saldo internal secara otomatis.
- **Pre-kondisi**: Worker `scanNativeBscDeposits` aktif berjalan dalam interval periodik.
- **Alur Utama**:
  1. Worker memanggil RPC `eth_blockNumber` untuk mengetahui blok rantai terbaru.
  2. Worker melakukan query `eth_getLogs` untuk kontrak token USDT resmi BSC pada rentang blok konfirmasi.
  3. Worker memfilter log dengan topik event `Transfer(address,address,uint256)`.
  4. Jika alamat tujuan cocok dengan alamat terdaftar di `wallet_deposit_addresses`:
     - Worker memverifikasi jumlah konfirmasi blok terhadap ambang batas aman (`BSC_MIN_CONFIRMATIONS`).
     - Worker memeriksa tabel `deposits` apakah `tx_hash` sudah pernah diklaim sebelumnya:
       - Jika sudah: log diabaikan (`DEPOSIT_TX_ALREADY_CLAIMED`).
     - Jika baru: worker membuka transaksi PostgreSQL, mencatat deposit di tabel `deposits`, menambahkan saldo di `wallet_accounts`, dan membuat entri mutasi kredit di `wallet_ledger`.
     - Worker menyinkronkan saldo ke Firestore mirror pengguna.
- **Post-kondisi**: Saldo dompet pengguna bertambah secara otomatis tanpa intervensi manual.

---

### UC-13: Pengajuan Penarikan Dana (Withdrawal)
- **Aktor Utama**: Trader Terotentikasi.
- **Deskripsi**: Mengajukan penarikan dana USDT ke alamat dompet eksternal pengguna.
- **Pre-kondisi**: Pengguna lulus verifikasi sesi elevasi 24 jam dan 2FA TOTP.
- **Alur Utama**:
  1. Pengguna memasukkan alamat tujuan penarikan BSC (0x...), jumlah nominal penarikan, dan kode 2FA Authenticator.
  2. Server memvalidasi kode TOTP.
  3. Server mengevaluasi kebijakan finansial (`financialControlPolicy`):
     - Format alamat tujuan valid.
     - Alamat tujuan bukan alamat internal/terlarang dan telah melewati periode pendinginan (*address cooldown hours*).
     - Nominal berada di antara batas minimum dan maksimum penarikan, serta tidak melebihi batas penarikan harian (*daily limit*).
  4. Server mengunci saldo pengguna, memotong saldo yang dapat ditarik, dan memasukkan rekod ke tabel `withdrawals` dengan status `PENDING_APPROVAL`.
- **Post-kondisi**: Permintaan penarikan masuk ke antrean verifikasi kepatuhan / approval.

---

### UC-14: Persetujuan Ganda & Penandatanganan On-Chain Penarikan
- **Aktor Utama**: Petugas Finansial (Admin), Kustodi BSC Worker.
- **Aktor Eksternal**: BNB Smart Chain RPC Provider.
- **Deskripsi**: Verifikasi compliance ganda dan eksekusi transaksi on-chain otomatis dari hot wallet kustodi.
- **Pre-kondisi**: Terdapat transaksi penarikan berstatus `PENDING_APPROVAL`.
- **Alur Utama**:
  1. Petugas Finansial 1 memeriksa dan memberikan approval pada sistem.
  2. Petugas Finansial 2 memverifikasi dan menyetujui transaksi (`WITHDRAWAL_APPROVAL_COUNT = 2`).
  3. Worker penarikan (`processNativeWithdrawal`) mengklaim baris transaksi dengan kunci sewa (*processor lease*).
  4. Worker memeriksa saldo BNB pada hot wallet untuk pembayaran gas fee:
     - Jika saldo BNB rendah: worker memicu `gas_auto_refill_configs` untuk mentransfer gas dari kas operasional.
  5. Worker mendekripsi private key hot wallet dari penyimpanan aman, menyusun raw transaction transfer token USDT BEP-20, dan menandatanganinya dengan secp256k1.
  6. Worker menyiarkan transaksi melalui `eth_sendRawTransaction`.
  7. Worker menunggu receipt konfirmasi di blockchain:
     - Jika sukses on-chain: status penarikan diubah menjadi `COMPLETED`.
     - Jika revert on-chain: status diubah menjadi `FAILED` dan saldo pengguna dikembalikan secara otomatis di ledger (*refund balance*).
- **Post-kondisi**: Token USDT terkirim ke alamat pengguna di blockchain dan buku besar keuangan tetap seimbang.

---

### UC-15: Audit Buku Besar Finansial & Rekonsiliasi Cadangan
- **Aktor Utama**: Petugas Finansial (Admin), Sistem Rekonsiliasi Otomatis.
- **Deskripsi**: Memverifikasi kecocokan total kewajiban saldo pengguna terhadap aset nyata di dompet on-chain (*Proof of Reserves & Liabilities Reconcile*).
- **Pre-kondisi**: Tersedia akses baca ke PostgreSQL dan saldo on-chain kustodi.
- **Alur Utama**:
  1. Admin atau cron menjalankan skrip audit `npm run financial:reconcile`.
  2. Sistem menghitung total kewajiban pengguna (*total liabilities*) dari penjumlahan seluruh saldo di `wallet_accounts`.
  3. Sistem memindai saldo riil USDT on-chain pada dompet cold storage dan hot wallet kustodi.
  4. Sistem menghitung rasio cadangan (*Reserve Coverage Ratio = Custody Assets / Total Liabilities*).
  5. Sistem membandingkan mutasi di `wallet_ledger` dengan saldo kumulatif di `wallet_accounts` untuk mendeteksi anomali mutasi ghaib (*ghost balance*).
  6. Hasil snapshot dicatat di tabel `financial_reconciliation_runs` dan `reserve_snapshots`.
- **Post-kondisi**: Laporan kesesuaian cadangan tercatat dengan rahasia integritas matematis tanpa selisih (*zero-drift*).
