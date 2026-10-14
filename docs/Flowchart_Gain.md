# Master Flowchart Sistem - GAIN NiagaKoin v4.0.0

Dokumen ini memetakan seluruh alur logika sistem GAIN NiagaKoin v4.0.0 secara komprehensif. Diagram disajikan menggunakan sintaks Mermaid standar yang dapat dirender otomatis oleh GitHub/Markdown viewer, disertai narasi logika langkah demi langkah, kondisi percabangan (*decision branching*), dan penanganan galat (*exception handling*).

---

## Daftar Isi
1. [Flowchart 1: Autentikasi & Model Otorisasi Arsitektur 25](#flowchart-1-autentikasi--model-otorisasi-arsitektur-25)
2. [Flowchart 2: Alur Siklus Hidup Bot Trading & Eksekusi Perdagangan](#flowchart-2-alur-siklus-hidup-bot-trading--eksekusi-perdagangan)
3. [Flowchart 3: Siklus Kustodi On-Chain Native BSC USDT (Deposit & Withdrawal)](#flowchart-3-siklus-kustodi-on-chain-native-bsc-usdt-deposit--withdrawal)
4. [Flowchart 4: Alur Pemulihan Kegagalan (Crash Recovery) & Rekonsiliasi Fail-Closed](#flowchart-4-alur-pemulihan-kegagalan-crash-recovery--rekonsiliasi-fail-closed)
5. [Flowchart 5: Sistem Aktivasi Lisensi & Penukaran Voucher Idempoten](#flowchart-5-sistem-aktivasi-lisensi--penukaran-voucher-idempoten)

---

## Flowchart 1: Autentikasi & Model Otorisasi Arsitektur 25

Model Arsitektur 25 memisahkan hak akses login dasar dengan otorisasi transaksi berisiko tinggi. Pengguna gratis dapat mengakses dashboard, namun fitur kritis membutuhkan elevasi keamanan (*24-hour Session Elevation*) dan verifikasi 2FA TOTP.

```mermaid
flowchart TD
    Start([Pengguna Mengakses GAIN]) --> AuthGoogle[Otentikasi Akun Google / Firebase Auth]
    AuthGoogle --> VerifyToken{Validasi Token Firebase di Server?}
    
    VerifyToken -- Gagal --> Reject401[Tolak Request: HTTP 401 Unauthorized]
    VerifyToken -- Sukses --> CheckMember[Query Data Pengguna di PostgreSQL: member_status]
    
    CheckMember --> MemberStatusDecision{Status Member?}
    MemberStatusDecision -- CLOSED / BANNED --> Reject403Closed[Tolak: HTTP 403 MEMBER_CLOSED]
    MemberStatusDecision -- SUSPENDED --> Reject403Susp[Tolak: HTTP 403 MEMBER_SUSPENDED]
    MemberStatusDecision -- ACTIVE --> LoadDashboard[Buka Dashboard & Fitur Publik / Read-Only]

    LoadDashboard --> UserAction{Pengguna Menjalankan Aksi Terlindungi?}
    UserAction -- Hanya Lihat Data / Demo --> AllowedRead[Akses Diizinkan Langsung]
    UserAction -- Aksi Berisiko: Live Order, Binding API, Withdrawal --> CheckLicense{Periksa Status Lisensi Aktif?}

    CheckLicense -- Tidak Memiliki Lisensi --> RejectLicense[Tolak: HTTP 403 LICENSE_REQUIRED]
    CheckLicense -- Lisensi Valid & Aktif --> CheckElevatedSession{Sesi Elevasi Keamanan Masih Berlaku? <24 Jam}

    CheckElevatedSession -- Berlaku --> Check2FARequirement{Tindakan Memerlukan 2FA / TOTP?}
    CheckElevatedSession -- Tidak Ada / Expired --> TriggerOTP[Kirim OTP Email 6-Digit via Resend]
    
    TriggerOTP --> InputOTP[Pengguna Memasukkan Kode OTP Email]
    InputOTP --> VerifyOTP{Validasi Kode OTP & Idempotensi}
    VerifyOTP -- Salah / Expired --> OTPFail[Tolak: Kode Tidak Valid / Percobaan Maksimal]
    VerifyOTP -- Benar --> IssueSession[Terbitkan Sesi Elevasi 24 Jam di DB & Redis]
    IssueSession --> Check2FARequirement

    Check2FARequirement -- Ya: Withdrawal / Rebind API --> InputTOTP[Pengguna Memasukkan Kode 2FA Authenticator]
    Check2FARequirement -- Tidak: Aksi Operasional Standar --> GrantExecution[Izinkan Akses Eksekusi]
    
    InputTOTP --> ValidateTOTP{Verifikasi TOTP RFC 6238}
    ValidateTOTP -- Gagal --> RejectTOTP[Tolak: HTTP 403 INVALID_TOTP]
    ValidateTOTP -- Sukses --> GrantExecution
    
    GrantExecution --> EndSuccess([Aksi Selesai Dijalankan])
```

### Penjelasan Logika Flowchart 1:
1. **Verifikasi Identitas**: Token ID Firebase diverifikasi melalui `firebase-admin` pada middleware `requireFirebaseIdentity`.
2. **Lifecycle Anggota**: Status pengguna di cek di PostgreSQL (`users.member_status`). Bila berstatus `SUSPENDED` atau `CLOSED`, akses ditolak tanpa kompromi.
3. **Pemisahan Dashboard vs Lisensi**: Pengguna tanpa lisensi (`license_status = 'none'`) tetap dapat masuk ke dashboard untuk melihat portofolio dan backtesting, namun tidak dapat menjalankan live-trading.
4. **Sesi Keamanan Elevasi (24 Jam)**: Tindakan seperti konfigurasi bot atau live-order memerlukan sesi elevasi. Jika sesi telah kedaluwarsa, kode OTP 6-digit dikirimkan melalui Resend. Sesi disimpan di PostgreSQL (`auth_session_elevations`) agar bertahan meskipun Redis mengalami restart.
5. **Faktor Transaksi Kritis (TOTP)**: Penarikan dana dan rotasi kunci API exchange mewajibkan faktor kedua berupa TOTP Authenticator (RFC 6238).

---

## Flowchart 2: Alur Siklus Hidup Bot Trading & Eksekusi Perdagangan

Alur ini mengendalikan loop evaluasi kondisi pasar, pembatasan risiko (*risk guardrails*), pencegahan duplikasi eksekusi (*execution reservation*), dan penyelesaian buku besar (*settlement*).

```mermaid
flowchart TD
    StartLoop([Bot Engine Loop: Detik/Interval Berjalan]) --> CheckLease{Validasi Heartbeat Lease Server?}
    CheckLease -- Lease Kadaluwarsa / Instance Lain --> SkipLoop([Skip: Hindari Eksekusi Ganda Antar Node])
    CheckLease -- Lease Valid --> FetchActiveBots[Ambil Daftar Bot Aktif dari Database]

    FetchActiveBots --> LoopBot[Iterasi Setiap Runner Bot]
    LoopBot --> CheckGasBalance{Cadangan Saldo Gas User Mencukupi?}
    CheckGasBalance -- Di bawah Ambang Batas --> PauseBotGas[Pause Bot: GAS_RESERVE_DEPLETED]
    CheckGasBalance -- Cukup --> MarketData[Tarik Data Pasar Ticker & Candle OHLCV]

    MarketData --> AggregateCandle[Normalisasi & Agregasi Candle ke Timeframe Strategi: 3m/5m/15m/1h]
    AggregateCandle --> StrategyEval{Evaluasi Aturan Strategi: DCA / Grid / Candle Driven}

    StrategyEval -- Tidak Ada Sinyal --> SleepInterval([Tidur Hingga Interval Berikutnya])
    StrategyEval -- Muncul Sinyal Buy / Sell --> RiskGuardrail{Evaluasi Risk Guardrails}

    RiskGuardrail -- Harga di Luar Min/Max Bounds --> RejectRisk[Blokir Order: PRICE_OUT_OF_BOUNDS]
    RiskGuardrail -- Melebihi Batas Kerugian Harian --> HaltRisk[Hentikan Bot: MAX_DAILY_LOSS_EXCEEDED]
    RiskGuardrail -- Melebihi Maksimum Paparan Modal --> RejectExposure[Blokir Order: MAX_EXPOSURE_REACHED]
    RiskGuardrail -- Lolos Semua Proteksi --> ReserveExecution[Reservasi Eksekusi di DB: order_execution_reservations]

    ReserveExecution --> LockPositionDB{Kunci Posisi di DB: SELECT FOR UPDATE}
    LockPositionDB -- Jika SELL: Saldo Posisi Tersedia? --> CheckPosQty{Quantity Cukup?}
    CheckPosQty -- Kurang --> AbortSell[Batalkan: POSITION_QUANTITY_RESERVED]
    CheckPosQty -- Cukup --> IncrementReserved[Update positions.reserved_quantity += Qty]
    
    IncrementReserved --> InsertReservation[Insert order_execution_reservations Status: RESERVED]
    LockPositionDB -- Jika BUY --> InsertReservation

    InsertReservation --> DispatchExchange[Kirim Order ke Exchange via CCXT dengan client_order_id Unik]
    DispatchExchange --> ExchangeResponse{Respon Exchange?}

    ExchangeResponse -- Error Jaringan / Timeout --> MarkReconcile[Set Order State: RECONCILING & Cek Ulang via API]
    ExchangeResponse -- Ditolak Exchange --> ReleaseResFail[Release Reservation: RELEASED & Reset reserved_quantity]
    ExchangeResponse -- Sukses Diterima / Terisi Langsung --> FinalizeFill[Terima Fill Event / WebSocket Execution Report]

    FinalizeFill --> DBTransaction[Buka Transaksi Atomik Database]
    DBTransaction --> UpdateOrderRecord[Update orders Status: FILLED]
    UpdateOrderRecord --> InsertFillRecord[Insert Rekod fills dengan ID Trade Exchange]
    InsertFillRecord --> UpdateDurablePosition[Update positions: Avg Entry, Quantity, PnL]
    UpdateDurablePosition --> SettleReservation[Update order_execution_reservations Status: SETTLED]
    SettleReservation --> MirrorFirestore[Sinkronisasi Firestore Read-Model untuk UI Real-Time]
    MirrorFirestore --> CommitTx([Commit Transaksi Database])
```

### Penjelasan Logika Flowchart 2:
1. **Heartbeat Lease**: Menjamin hanya satu node instance yang memproses runner bot tertentu untuk mencegah *split-brain execution*.
2. **Proteksi Gas & Risiko**: Bot secara berkala memeriksa saldo gas operasional. Sebelum order dibuat, sistem mengevaluasi ambang batas harga (*price bounds*), alokasi modal maksimum (*max committed capital*), dan batas kerugian harian (*max daily loss*).
3. **Pola Reservasi Eksekusi (Anti-Double Selling)**: 
   - Untuk order jual (*SELL*), baris posisi dikunci menggunakan `SELECT ... FOR UPDATE`.
   - Kolom `reserved_quantity` dinaikkan seketika. Jika order lain mencoba menjual koin yang sama pada saat bersamaan, permintaan kedua akan diblokir karena kuantitas yang tersedia tidak mencukupi.
4. **Idempotent Settlement**: Sinyal fill diproses secara atomik di dalam satu transaksi PostgreSQL: mencatat rekod pengisian (*fill*), memperbarui posisi (*durable position*), dan mengubah status reservasi menjadi `SETTLED`.

---

## Flowchart 3: Siklus Kustodi On-Chain Native BSC USDT (Deposit & Withdrawal)

Siklus ini mengatur pengelolaan dana on-chain pada BNB Smart Chain (BEP-20 USDT) secara non-kustodial terpusat dengan segregasi dompet operasional, hot wallet, dan cold storage.

```mermaid
flowchart TD
    subgraph Alur_Deposit_Otomatis [Alur Deposit Otomatis]
        UserDep[Pengguna Membuka Halaman Dompet] --> GenAddr[Sistem Menurunkan Alamat Unik via BIP44 HD: m/44'/60'/0'/0/index]
        GenAddr --> ShowQR[Tampilkan Alamat & QR Code BSC kepada Pengguna]
        
        ScannerWorker([Background Worker: scanNativeBscDeposits]) --> PollRPC[Query eth_getLogs dari BSC RPC untuk Kontrak USDT]
        PollRPC --> ParseLogs[Ekstraksi Event Transfer: from, to, value, txHash]
        ParseLogs --> CheckRecipient{Apakah Alamat Penerima Terdaftar di DB?}
        
        CheckRecipient -- Bukan Alamat Pengguna --> IgnoreLog[Abaikan Log Event]
        CheckRecipient -- Cocok dengan Alamat Pengguna --> CheckConfirmations{Konfirmasi Blok >= BSC_MIN_CONFIRMATIONS?}
        
        CheckConfirmations -- Belum Cukup --> WaitBlock[Tunggu Blok Tambahan Terkonfirmasi]
        CheckConfirmations -- Cukup --> CheckTxReplay{Cek Duplikasi: Apakah tx_hash Sudah Diklaim di DB?}
        
        CheckTxReplay -- Sudah Pernah Diproses --> DropDuplicate[Abaikan: DEPOSIT_TX_ALREADY_CLAIMED]
        CheckTxReplay -- Belum Pernah --> AtomicDepositTx[Buka Transaksi Database PostgreSQL]
        
        AtomicDepositTx --> RecordDeposit[Insert ke deposits Status: COMPLETED]
        RecordDeposit --> CreditLedger[Insert ke wallet_ledger & Tambah wallet_accounts.balance]
        CreditLedger --> MirrorDepFS[Sinkronisasi Saldo ke Firestore Mirror]
        MirrorDepFS --> CommitDeposit([Deposit Berhasil Dikreditkan])
    end

    subgraph Alur_Penarikan_Dana_Withdrawal [Alur Penarikan Dana / Withdrawal]
        StartWD[Pengguna Mengajukan Request Penarikan] --> ValidateWDFactors{Validasi TOTP 2FA & Sesi Elevasi?}
        ValidateWDFactors -- Tidak Valid --> RejectWDFactor[Tolak Penarikan: 403 Forbidden]
        ValidateWDFactors -- Valid --> CheckWDPolicy{Evaluasi Kebijakan Finansial POJK / Risk Limit}

        CheckWDPolicy -- Melebihi Limit Harian / Di Bawah Min --> RejectWDLimit[Tolak: WITHDRAWAL_LIMIT_EXCEEDED]
        CheckWDPolicy -- Alamat Tujuan Baru (< Cooldown) --> RejectWDCooldown[Tolak: ADDRESS_COOLDOWN_ACTIVE]
        CheckWDPolicy -- Lolos Verifikasi --> LockUserBal[Lock Saldo Pengguna & Potong Saldo Tersedia]

        LockUserBal --> InsertWDPending[Insert withdrawals Status: PENDING_APPROVAL]
        InsertWDPending --> DualApproval{Memerlukan Persetujuan Ganda: 2 Approver?}
        
        DualApproval -- Menunggu Approval --> HoldQueue[Antrean Penarikan Tertahan]
        DualApproval -- Telah Diapprove 2 Pejabat Finansial --> ProcessorWorker([Worker: processNativeWithdrawal])

        ProcessorWorker --> ClaimWDLease[Klaim Baris Penarikan dengan Processor Lease]
        ClaimWDLease --> CheckHotGas{Saldo BNB Hot Wallet Cukup untuk Gas Fee?}
        CheckHotGas -- Kurang --> AutoRefillGas[Eksekusi Gas Auto-Refill dari Kas Operasional]
        CheckHotGas -- Cukup --> SignRawTx[Buka Kunci Enkripsi Hot Wallet & Sign Transaksi secp256k1]

        AutoRefillGas --> SignRawTx
        SignRawTx --> BroadcastTx[Kirim Raw Transaction via eth_sendRawTransaction]
        BroadcastTx --> WaitForReceipt{Tunggu Konfirmasi Receipt On-Chain}

        WaitForReceipt -- Gagal / Revert On-Chain --> FailWD[Rollback: Kembalikan Saldo Pengguna di Ledger]
        WaitForReceipt -- Sukses Terkonfirmasi --> SettleWD[Update withdrawals Status: COMPLETED & Audit Event]
        SettleWD --> EndWD([Penarikan Selesai])
    end
```

### Penjelasan Logika Flowchart 3:
1. **Derivasi Alamat HD BIP44**: Alamat deposit pengguna diturunkan secara deterministik dari seed master yang dienkripsi dengan AES-256-GCM (`m/44'/60'/0'/0/${index}`). Kunci privat tidak pernah disimpan dalam format teks biasa (*plaintext*).
2. **Scanner Anti-Replay**: Pemindai log memeriksa nilai transaksi dan mencocokkannya ke basis data. Konstrain integritas `UNIQUE(network, tx_hash)` mencegah serangan *credit replay*.
3. **Pemisahan Dana (*Funds Segregation*)**: Dana operasional perusahaan dan dana konsumen dipisahkan secara fisik di rekening dan alamat blockchain terpisah.
4. **Governance Penarikan**: Penarikan di atas batas ambang memerlukan persetujuan ganda (*dual-officer approval*). Pekerja pemroses menandatangani transaksi on-chain secara terisolasi dengan sewa (*lease*) eksklusif untuk mencegah eksekusi ganda jika worker di-restart.

---

## Flowchart 4: Alur Pemulihan Kegagalan (Crash Recovery) & Rekonsiliasi Fail-Closed

Sistem GAIN mengadopsi prinsip **Fail-Closed by Default**. Saat server atau runtime dimulai ulang (*restart*), seluruh bot tidak langsung dijalankan secara liar tanpa pengawasan, melainkan dipertahankan dalam status aman hingga diverifikasi.

```mermaid
flowchart TD
    Boot([Server Node.js Booting / Restart]) --> ReadEnv[Baca Konfigurasi Lingkungan: .env]
    ReadEnv --> CheckAutoResume{BOT_STARTUP_AUTO_RESUME == true && Konfirmasi Valid?}

    CheckAutoResume -- Tidak (Default Fail-Closed) --> SafeState[Tandai Semua Bot Aktif Sebelumnya ke Status PAUSED]
    SafeState --> EmitAuditBoot[Catat Audit Event: BOT_STARTUP_SAFE_PAUSE_APPLIED]
    EmitAuditBoot --> NotifyUser[Kirim Notifikasi ke Operator: Manual Resume Diperlukan]
    NotifyUser --> ReadyServer([Server Siap Menerima Request])

    CheckAutoResume -- Ya (Opt-In Eksplisit) --> QueryActiveDB[Ambil Runner Bot yang Berstatus RUNNING dari DB]
    QueryActiveDB --> LoopRecover[Iterasi Setiap Runner Bot untuk Rekonsiliasi]

    LoopRecover --> CheckHangingOrders{Terdapat Order Menggantung? Status SUBMITTING / RECONCILING}
    
    CheckHangingOrders -- Tidak Ada Order Tertunda --> SyncPositions[Sinkronisasi Posisi Lokal vs Exchange Balances]
    CheckHangingOrders -- Ada Order Tertunda --> QueryExchangeOrder[Query Status Pesanan ke Exchange via CCXT menggunakan client_order_id]

    QueryExchangeOrder --> ExchangeOrderStatus{Status Pesanan di Exchange?}
    ExchangeOrderStatus -- Order Tidak Ditemukan / Canceled --> CancelLocal[Tandai Order Lokal: CANCELLED & Lepas Reservasi Saldo]
    ExchangeOrderStatus -- Order Terisi (Filled) --> ReplayFill[Eksekusi Finalize Order & Settle Posisi di DB]
    ExchangeOrderStatus -- Masih Terbuka (Open) --> KeepOpen[Pertahankan State SUBMITTED & Lanjutkan Monitoring]

    CancelLocal --> SyncPositions
    ReplayFill --> SyncPositions
    KeepOpen --> SyncPositions

    SyncPositions --> CheckPositionDrift{Apakah Terdeteksi Selisih Posisi (Drift)?}
    CheckPositionDrift -- Selisih Melebihi Toleransi --> QuarantineBot[Karantina Bot: POSITION_DRIFT_ALERT & Pause Bot]
    CheckPositionDrift -- Posisi Sinkron --> ResumeLoop[Aktifkan Heartbeat Loop & Mulai Runner Bot]

    QuarantineBot --> NextBot{Masih Ada Bot Berikutnya?}
    ResumeLoop --> NextBot

    NextBot -- Ya --> LoopRecover
    NextBot -- Selesai --> ReadyServer
```

### Penjelasan Logika Flowchart 4:
1. **Prinsip Fail-Closed**: Ketika terjadi *power failure* atau *container restart*, bot tidak otomatis mengeksekusi order baru sampai integritas posisi divalidasi.
2. **Penyelesaian Order Menggantung**: Pesanan yang berstatus `SUBMITTING` atau `RECONCILING` diselidiki langsung ke exchange menggunakan `client_order_id` yang bersifat deterministik dan unik.
3. **Deteksi Drift Posisi**: Jika jumlah aset pada akun exchange berbeda dengan catatan di `positions` PostgreSQL, bot akan dikarantina (*PAUSED*) untuk mencegah kesalahan perhitungan averaging berikutnya.

---

## Flowchart 5: Sistem Aktivasi Lisensi & Penukaran Voucher Idempoten

Alur ini mengelola aktivasi tier lisensi bot (Starter, Pro, Elite) dan penukaran voucher promosi dengan jaminan bebas race-condition.

```mermaid
flowchart TD
    StartLicense([Pengguna Memilih Paket Lisensi / Input Voucher]) --> ReqType{Jenis Permintaan?}

    ReqType -- Input Voucher Promo --> CheckVoucher[Validasi Kode Voucher di Database: FOR UPDATE]
    CheckVoucher --> VoucherValid{Voucher Aktif, Belum Expired, Kuota Tersedia?}
    VoucherValid -- Tidak Valid --> RejectVoucher[Tolak: VOUCHER_INVALID / QUOTA_EXCEEDED]
    VoucherValid -- Valid --> CheckUserRedemption{Pengguna Sudah Pernah Menukar Voucher Ini?}
    CheckUserRedemption -- Sudah Pernah --> RejectRedeemed[Tolak: VOUCHER_ALREADY_REDEEMED]
    CheckUserRedemption -- Belum --> ApplyVoucherDiscount[Hitung Potongan Biaya / Hak Akses Gratis]
    ApplyVoucherDiscount --> DeductQuota[Kurangi remaining_uses & Catat di voucher_redemptions]
    DeductQuota --> CheckPaymentNeeded{Apakah Masih Memerlukan Pembayaran?}

    ReqType -- Pembayaran Langsung via Saldo Dompet --> CheckPaymentNeeded
    CheckPaymentNeeded -- Gratis / Diskon 100% --> AtomicActivation[Eksekusi activateLicenseAtomic di PostgreSQL]
    CheckPaymentNeeded -- Memerlukan Saldo USDT --> VerifyBalance{Saldo USDT Pengguna Mencukupi?}

    VerifyBalance -- Tidak Cukup --> RejectBalance[Tolak: INSUFFICIENT_FUNDS]
    VerifyBalance -- Cukup --> DeductBalance[Debit Saldo Pengguna di wallet_ledger & wallet_accounts]
    DeductBalance --> DistributeBonus[Alokasi Bonus Sponsor & Referral jika Ada]
    DistributeBonus --> AtomicActivation

    AtomicActivation --> LockLicenseRow{Kunci Baris Lisensi Pengguna: FOR UPDATE}
    LockLicenseRow --> CheckIdempotency{Periksa Idempotency Key Transaksi}
    CheckIdempotency -- Kunci Pernah Diproses --> ReturnReplay[Kembalikan Hasil Sukses Terdahulu: Replayed True]
    CheckIdempotency -- Kunci Baru --> UpdateLicenseTier[Update licenses: tier, status=ACTIVE, expires_at]

    UpdateLicenseTier --> UpdateMemberStatus[Update users.member_status = ACTIVE]
    UpdateMemberStatus --> SyncFirestoreLicense[Perbarui Firestore Mirror: licenseStatus, maxActiveBots]
    SyncFirestoreLicense --> FinishActivation([Aktivasi Berhasil & Bot Slot Terbuka])
```

### Penjelasan Logika Flowchart 5:
1. **Penguncian Baris Voucher**: Pengecekan kuota voucher menggunakan `SELECT ... FOR UPDATE` untuk mencegah eksploitasi penggunaan ganda saat ribuan pengguna menukarkan kode voucher yang sama secara serentak (*flash claim*).
2. **Idempotensi Transaksi Atomik**: Fungsi `activateLicenseAtomic` mencatat kunci unik idempotensi. Pengiriman ulang formulir akibat gangguan jaringan tidak akan menagih biaya saldo dua kali.
3. **Pembaharuan Hak Slot Bot**: Begitu lisensi aktif, batas maksimum bot aktif (`maxActiveBots`) langsung dimutakhirkan secara otomatis.
