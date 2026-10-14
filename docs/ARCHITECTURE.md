# Spesifikasi Arsitektur Sistem GAIN NiagaKoin v4.0.0

Dokumen ini merupakan sumber kebenaran tunggal untuk seluruh arsitektur sistem GAIN NiagaKoin v4.0.0, mencakup otorisasi Arsitektur 25, identitas exchange & kepemilikan data, kustodi native BSC USDT, serta mekanisme eksekusi dan rekonsiliasi.

---

## 1. Arsitektur 25 & Model Otorisasi

Otorisasi aplikasi dipisahkan secara ketat ke dalam enam lapisan independen:

```text
Otentikasi Google / Firebase
        ↓
Siklus Hidup Anggota GAIN (Member Lifecycle)
        ↓
Hak Akses Lisensi (License Entitlement)
        ↓
Dashboard / Fitur Non-Lisensi
        ↓
Elevasi Keamanan (OTP Email 6-Digit, Sesi 24 Jam On-Demand)
        ↓
TOTP / 2FA (Tindakan Berisiko Tinggi)
        ↓
Gerbang Kredensial Exchange + Risiko + Runtime
        ↓
Eksekusi Live / Testnet
```

### 1.1 Penjelasan Enam Lapisan Otorisasi

1. **Identity** — Otentikasi Google / Firebase Authentication (`req.uid`) menjawab *siapa* pengguna.
2. **Member Lifecycle** — Status anggota (`users.status`: `active`, `suspended`, `closed`) menjawab apakah akun GAIN dapat digunakan.
3. **License Entitlement** — Status lisensi (`licenses.status`: `none`, `active`, `suspended`, `expired`) menjawab fitur berbayar yang dimiliki (`licenseTier`, kuota bot).
4. **Security Session** — Verifikasi email OTP 6-digit membuat sesi keamanan *elevated* selama 24 jam. Mekanisme ini **on-demand** dan bukan gerbang login/dashboard utama.
5. **Transaction Security** — Google Authenticator (TOTP) digunakan khusus untuk tindakan finansial berisiko tinggi (withdrawal, penutupan posisi darurat, perubahan kredensial).
6. **Resource / Execution Authorization** — Pemeriksaan akhir sebelum eksekusi mencakup kredensial exchange, mode sandbox/live, batas kuota bot, cadangan gas, dan guardrail risiko.

### 1.2 Klasifikasi Pengguna

- **User 2 (Member Tanpa Lisensi Aktif):**
  `memberStatus = active`, `licenseStatus = none`. Pengguna dapat berotentikasi dan membuka dashboard non-lisensi tanpa terhalang gerbang OTP.
- **User 1 (Member Dengan Lisensi Aktif):**
  `memberStatus = active`, `licenseStatus = active`. Pengguna menerima *entitlement* paket lisensi. Pengguna **tidak dipaksa** memasukkan OTP saat membuka dashboard.

### 1.3 Elevasi Sesi Keamanan 24 Jam (Security Session)

Jika pengguna melakukan tindakan yang membutuhkan sesi elevated, backend mengembalikan respons HTTP `403 SESSION_ELEVATION_REQUIRED`. Klien mendengarkan error ini dan membuka `SecurityVerificationModal` secara *on-demand*. Setelah OTP 6-digit diverifikasi:
- Sesi elevated berlaku selama **24 jam** di PostgreSQL/Redis;
- Logout mencabut sesi elevated secara seketika;
- Pengguna dapat mengulang tindakan tanpa perlu login ulang.

---

## 2. Identitas Akun Exchange & Kepemilikan Data

### 2.1 Skema Identitas & Fingerprint

Kredensial exchange tidak diikat hanya berdasarkan `(user_id, exchange)` biasa, melainkan menyertakan metadata identitas akun:
- `credential_fingerprint` — HMAC deterministik dari kredensial + exchange + environment.
- `reported_identity_key` — ID akun resmi yang dilaporkan exchange.
- `credential_version` & `identity_hint`.

```text
Gmail A → Firebase UID A → GAIN User A → Binance Account X (Fingerprint X)
Gmail B → Firebase UID B → GAIN User B → Binance Account Y (Fingerprint Y)
```

### 2.2 Proteksi Duplikasi Lintas Pengguna

Jika Gmail B mencoba menghubungkan API Key Binance yang menunjuk ke akun/fingerprint yang sama dengan Gmail A, server menolak secara eksplisit dengan error:

`EXCHANGE_ACCOUNT_ALREADY_LINKED`

Tabel `exchange_accounts` menggunakan *unique partial index* di PostgreSQL untuk mencegah *race condition* pendaftaran ganda.

### 2.3 Siklus Penggantian Kredensial (Rebind & Rotation)

- **Rotasi API Key (Akun Sama):** Diizinkan langsung selama `reported_identity_key` konsisten.
- **Penggantian Akun (Rebind):** Jika kredensial baru menunjuk ke akun exchange berbeda:
  - Jika bot masih memiliki posisi aktif atau order tertahan, rebind **DITOLAK**:
    `EXCHANGE_CREDENTIAL_REBIND_REQUIRES_FLAT`
  - Jika tidak ada posisi, runner dipause, open order dicoba dibatalkan, lalu kredensial baru disimpan.

---

## 3. Spesifikasi Kustodi Native BSC USDT (BEP-20)

Repositori menggunakan kustodi internal Native BSC tanpa ketergantungan penyedia pihak ketiga.

### 3.1 Penurunan Alamat Deposit HD (BIP-32 / BIP-44)

- **Jaringan:** BSC Mainnet (Chain ID 56)
- **Kontrak Token:** Binance-Peg USDT (BEP-20)
- **Jalur EVM Standard:** `m/44'/60'/0'/0/<derivation_index>`
- **Seed Utama (Root Seed):** Diambil dari `BSC_DEPOSIT_MASTER_SEED_HEX` atau dihasilkan sekali secara aman dan disimpan terenkripsi di `system_settings`.
- **Alokasi Indeks:** Menggunakan urutan PostgreSQL atomik untuk menjamin 1 alamat unik per pengguna.

### 3.2 Pemindai Log Deposit (Deposit Scanner)

Pemindai membaca event `Transfer(address,address,uint256)` dari RPC BSC resmi, memetakan alamat tujuan ke pengguna, menunggu konfirmasi `BSC_MIN_CONFIRMATIONS`, lalu mengkredit saldo `wallet_ledger` secara idempotensial. Saldo tidak pernah dikreditkan hanya berdasarkan klaim TX hash manual.

### 3.3 Penanda Tangan Penarikan (Withdrawal Hot Wallet Signer)

- Kunci privat hot wallet dikonfigurasi melalui Panel Admin, dienkripsi menggunakan **AES-256-GCM** dengan `ENCRYPTION_MASTER_KEY`, dan tidak pernah dikembalikan ke UI.
- Penanda tangan memverifikasi kecukupan saldo gas BNB sebelum menandatangani transaksi `transfer(address,uint256)`.
- Jika transaksi blockchain gagal, saldo yang ditahan dilepaskan kembali secara otomatis melalui jurnal kompensasi.

---

## 4. Eksekusi, Pemesanan, & Rekonsiliasi

### 4.1 Hirarki Sumber Kebenaran (Source of Truth)

1. **Exchange** — Sumber kebenaran eksekusi eksternal yang paling berwenang.
2. **PostgreSQL** — Buku besar finansial internal GAIN (`orders`, `fills`, `positions`, `execution_reservations`).
3. **Firestore** — Proyeksi status runtime dan tampilan UI saja.
4. **React** — Lapisan presentasi UI.

### 4.2 Hambatan Eksekusi (Execution Barrier)

Sebelum order dikirim ke exchange:
1. Idempotensi `clientOrderId` diverifikasi di PostgreSQL;
2. Kuantitas SELL dipastikan tidak melebihi posisi tahan lama (*durable position*) dikurangi kuantitas cadangan (*reserved quantity*);
3. Pemesanan eksekusi (*execution reservation*) disimpan;
4. Perintah `createOrder()` baru dipanggil.

Jika koneksi timeout, reservasi dipertahankan dan bot masuk ke status pemulihan (*recovery*). Perintah order kedua **tidak pernah dikirim ulang secara otomatis**.

### 4.3 Rekonsiliasi Posisi

- `ORDER_STATUS_UNCERTAIN` — Status order exchange belum konfirmatif.
- `POSITION_LEDGER_MISMATCH` — Selisih antara eksekusi exchange dan posisi PostgreSQL.
- **Repair Ledger:** Menggunakan riwayat `fills` immutable dari PostgreSQL untuk merekonstruksi posisi tanpa pernah memanipulasi posisi secara manual atau mengirim order spekulatif ke exchange.
