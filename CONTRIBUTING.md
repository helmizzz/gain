# Panduan Kontribusi (Contributing)

## Sebelum Membuat Pull Request

Pastikan seluruh langkah verifikasi sumber berjalan dengan sukses di lingkungan lokal Anda:

```bash
npm ci
npm run doctor
npm run lint
npm test
npm run test:core
npm run build
```

Untuk perubahan yang mempengaruhi otorisasi, status finansial, eksekusi exchange, atau pemulihan (recovery), perbarui dokumen terkait di bawah direktori `docs/` dan tambahkan atau perbarui pengujian regresi (regression test) yang relevan.

## Aturan Keamanan Repositori

Dilarang melakukan commit terhadap:
- Hasil *build* kompilasi (`dist/`)
- Modul dependensi lokal (`node_modules/`)
- Konfigurasi rahasia lingkungan lokal (`.env`)
- Kredensial akun layanan, kunci privat (private key), atau Kunci Rahasia API Exchange.
