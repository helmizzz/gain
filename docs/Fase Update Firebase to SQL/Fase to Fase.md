Pilihan yang berani dan sangat bagus! Membangunnya secara bertahap (per fase) adalah strategi *engineering* yang paling aman agar sistem yang sedang berjalan tidak langsung rusak total.

Jika kita sepakat menggunakan **Opsi 2 (Hapus Firebase 100%)**, berikut adalah rancangan **4 Fase Migrasi** yang akan kita lakukan. 

---

### 📝 Rencana Migrasi Bertahap (Fase 1 - 4)

#### **Fase 1: Membangun Fondasi Auth di Backend (Node.js)**
Pada fase ini, kita belum menyentuh tampilan (UI) sama sekali. Kita fokus menyiapkan "mesin" login buatan sendiri di server.
*   **Yang disiapkan:** Menginstal `google-auth-library` dan `jsonwebtoken` (JWT) di backend.
*   **Pekerjaan:** Membuat endpoint API baru (contoh: `/api/auth/google/callback`) yang akan menerima token dari Google, memvalidasinya, lalu menerbitkan JWT buatan server kita sendiri. 
*   **Database:** Memastikan tabel `users` di PostgreSQL siap menyimpan identitas Google secara mandiri tanpa bergantung pada Firebase UID.

#### **Fase 2: Migrasi Jalur Data (Meninggalkan Firestore)**
Sebelum memutus sistem login Firebase, kita pindahkan dulu aliran data agar mandiri.
*   **Pekerjaan Backend:** Menghapus fungsi-fungsi yang mengirim duplikat data ke Firestore (seperti `syncFirestoreWalletReadModel` di `firestoreUtils.ts`).
*   **Pekerjaan Frontend:** Mengubah file `firebaseService.ts`. Kita akan mematikan fungsi `onSnapshot` (real-time Firestore) dan menggantinya dengan metode pemanggilan API standar (REST API `fetch`) ke Node.js untuk melihat portofolio, histori, dan posisi bot.

#### **Fase 3: Eksekusi Migrasi Total (Pencabutan Firebase)**
Ini adalah puncaknya. Mesin login buatan kita di Fase 1 dan jalur data di Fase 2 sudah siap pakai.
*   **Pekerjaan Frontend:** Merombak total `AuthContext.tsx`. Kita matikan `onAuthStateChanged` dari Firebase, dan ganti dengan logika untuk membaca JWT / HTTP-Only Cookies dari server kita.
*   **Pencabutan:** Meng-uninstall (menghapus) paket `firebase` dari frontend dan `firebase-admin` dari backend secara permanen.

#### **Fase 4: Pembersihan & Stabilisasi (Clean Up)**
*   Membersihkan sisa-sisa kode mati (*dead code*).
*   Membuat *script migrasi* jika diperlukan agar pengguna lama (yang mendaftar pakai Firebase UID) tidak kehilangan akses dan saldonya tetap terhubung dengan email Google mereka.

---

### Bagaimana?
Jika Anda setuju dengan alur ini, **kita bisa mulai dari Fase 1 sekarang.** 

Yang saya butuhkan dari Anda untuk memulai Fase 1 adalah:
1. Izin untuk menginstal paket baru di backend (`npm install google-auth-library jsonwebtoken`).
2. Izin untuk mulai mengedit `server.ts` dan membuat *routes* autentikasi baru.

Apakah Anda siap kita mulai mengerjakan **Fase 1**?