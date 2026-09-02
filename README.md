# Gizi Assistant — Bot Telegram dengan Ingatan

Asisten nutrisi personal di Telegram: isi data diri sekali di awal, lalu tinggal
cerita apa aja yang kamu makan/olahraga (teks atau foto) — bot yang mencatat,
menjumlahkan, dan mengingatkan.

100% gratis: hosting **Vercel**, AI (chat + vision) **Gemini API**, database **Supabase**,
penjadwal reminder **cron-job.org**.

## Alur Kerja

1. **Onboarding** (sekali di awal): user cerita bebas soal umur/berat/tinggi/aktivitas/tujuan.
   Gemini mengekstrak data itu dari kalimat bebas (nggak perlu isi form kaku),
   nanya lagi kalau ada yang kurang, lalu menghitung target kalori harian
   pakai rumus Mifflin-St Jeor.
2. **Chat harian**: tiap pesan setelah itu diklasifikasi otomatis — laporan
   makan, laporan olahraga, pertanyaan progress, atur jam reminder, atau
   sekadar ngobrol biasa — dan direspons secara natural, bukan template kaku.
3. **Reminder**: cron-job.org "mencolek" bot tiap jam; bot cek siapa yang
   minta diingatkan jam segitu dan kirim pesan pengingat.

## Struktur Project

```
gizi-assistant/
├── api/
│   ├── telegram.js   <- webhook utama, semua logic chat & onboarding
│   ├── reminder.js   <- endpoint yang dicolek scheduler tiap jam
│   └── db.js          <- helper baca/tulis Supabase
├── package.json
└── README.md
```

## Setup — Langkah demi Langkah

### 1. Buat bot Telegram
Chat `@BotFather` → `/newbot` → simpan **BOT TOKEN**.

### 2. Dapatkan Gemini API Key (gratis)
https://ai.google.dev → "Get API key" → simpan.

### 3. Buat database Supabase (gratis)
1. Daftar di https://supabase.com, buat project baru (gratis, pilih region Singapore biar dekat)
2. Setelah project jadi, buka menu **SQL Editor** di sidebar kiri
3. Paste dan jalankan SQL ini (bikin 2 tabel yang kita butuhkan):

```sql
create table users (
  chat_id bigint primary key,
  onboarding_done boolean default false,
  onboarding_data text default '{}',
  gender text,
  age int,
  weight_kg numeric,
  height_cm numeric,
  activity_level text,
  goal text,
  target_calories int,
  reminder_hours text default '',
  created_at timestamptz default now()
);

create table logs (
  id bigserial primary key,
  chat_id bigint references users(chat_id),
  log_date text,
  type text,
  description text,
  calories int,
  created_at timestamptz default now()
);
```

4. Buka menu **Project Settings → API**. Kamu butuh 2 nilai:
   - **Project URL** (contoh: `https://xxxxx.supabase.co`)
   - **service_role key** (di bagian "Project API keys" — PAKAI YANG `service_role`,
     BUKAN `anon`, karena bot butuh akses baca-tulis penuh. Key ini rahasia,
     jangan disebar / taruh di kode publik)

### 4. Upload project ke GitHub
Upload semua isi folder `gizi-assistant/` ke root repo GitHub baru.

### 5. Deploy ke Vercel
- Login https://vercel.com pakai GitHub
- Add New → Project → pilih repo tadi → Deploy
- Cek domain yang benar-benar aktif di halaman project (bisa beda dari nama repo)

### 6. Set Environment Variables
Project Vercel → Settings → Environment Variables, tambahkan 4 ini:

| Key | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token dari langkah 1 |
| `GEMINI_API_KEY` | key dari langkah 2 |
| `SUPABASE_URL` | Project URL dari langkah 3 |
| `SUPABASE_SERVICE_KEY` | service_role key dari langkah 3 |

Redeploy setelah itu (Deployments → deployment terakhir → Redeploy).

### 7. Tes endpoint dulu
Buka `https://<domain-vercel>/api/telegram` di browser — harus muncul
"Bot Gizi AI aktif...". Kalau masih 404, cek dulu struktur folder di GitHub
(harus `api/` persis di root repo).

### 8. Daftarkan webhook Telegram
Buka di browser:
```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain-vercel>/api/telegram
```

### 9. Setup reminder pakai cron-job.org (gratis)
1. Daftar di https://cron-job.org
2. Buat cron job baru:
   - URL: `https://<domain-vercel>/api/reminder`
   - Schedule: **every hour** (misal tiap menit ke-0 setiap jam)
3. Aktifkan. Sekarang tiap jam, cron-job.org otomatis memanggil endpoint
   reminder kita, dan bot akan cek siapa yang perlu diingatkan.

### 10. Selesai — coba bot-nya
Chat bot kamu di Telegram, ketik `/start`, ceritain data dirimu, lalu mulai
cerita makan/olahraga atau kirim foto makanan.

## Contoh Percakapan

```
User: /start
Bot: Halo! 👋 Aku bakal bantu hitung kebutuhan kalori harianmu...

User: cewek, 24 tahun, 55kg, 160cm, jarang olahraga, mau diet
Bot: Siap, profil kamu sudah aku catat! 🎯
     Target kalori harianmu untuk menurunkan berat badan: 1400 kkal/hari
     ...

User: tadi sarapan nasi uduk sama telur ceplok
Bot: Noted! Nasi uduk + telur ceplok itu sekitar 420 kkal.
     Sisa kalori hari ini: 980 kkal. Masih aman kok 😊

User: abis lari 30 menit
Bot: Mantap! 🏃 Lari 30 menit bakar sekitar 250 kkal.
     Sisa kalorimu jadi 1230 kkal sekarang.

User: ingetin aku jam 8 pagi, 12 siang, sama jam 7 malem
Bot: Oke, aku bakal ingetin kamu tiap jam 8, 12, dan 19 (WIB) ya!

User: gimana progress aku hari ini?
Bot: Sejauh ini kamu makan 420 kkal, olahraga bakar 250 kkal.
     Dari target 1400 kkal, sisa kamu masih 1230 kkal. On track! 💪
```

## Catatan Teknis

- **Onboarding disimpan bertahap**: kalau user cuma kasih sebagian data
  (misal cuma umur & berat), bot nyimpen itu dulu dan nanya sisanya di
  pesan berikutnya — nggak perlu diulang dari nol.
- **"Hari ini" pakai zona WIB** (UTC+7), supaya jumlah kalori harian reset
  pas tengah malam WIB, bukan UTC.
- **Retry + fallback model Gemini**: kalau server Gemini lagi sibuk (503),
  bot otomatis coba lagi, lalu pindah ke model cadangan kalau masih gagal.
- **Semua error dikirim ke chat Telegram**, jadi kamu nggak perlu bolak-balik
  cek log Vercel buat debug.
- Estimasi kalori dari AI bersifat perkiraan, bukan pengukuran laboratorium presisi.
- Free tier Gemini & Supabase punya rate limit, tapi untuk pemakaian pribadi
  biasanya jauh lebih dari cukup.
