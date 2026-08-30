# Scan Kalori — Web App

Web app sederhana: foto makanan → estimasi kalori & gizi, ditampilkan seperti label Nutrition Facts.
100% gratis: hosting di Vercel (free tier) + AI vision di Gemini API (free tier).

## Struktur project

```
kalori-web/
├── index.html        ← halaman utama (frontend, statis)
├── api/
│   └── analyze.js     ← serverless function yang panggil Gemini API
├── package.json
└── README.md
```

## Langkah deploy (tanpa VPS, tanpa install apa pun di komputer)

1. **Dapatkan Gemini API Key (gratis)**
   - Buka https://ai.google.dev
   - Klik "Get API key", login dengan akun Google, buat API key baru.
   - Simpan key-nya.

2. **Upload project ke GitHub**
   - Buat repo baru di GitHub (bisa lewat web, tanpa command line): klik "Add file" → "Upload files", lalu drag semua file/folder di project ini ke sana.

3. **Deploy ke Vercel**
   - Daftar/login di https://vercel.com pakai akun GitHub (gratis).
   - Klik "Add New" → "Project", pilih repo yang baru kamu upload.
   - Vercel akan otomatis mendeteksi ini sebagai project statis + serverless function. Tidak perlu ubah build settings apa pun — langsung klik "Deploy".

4. **Set environment variable**
   - Di dashboard project Vercel → Settings → Environment Variables.
   - Tambahkan: `GEMINI_API_KEY` = (API key dari langkah 1).
   - Redeploy project (Settings → Deployments → tombol "Redeploy" pada deployment terakhir) supaya env var terbaca.

5. **Selesai**
   - Buka URL yang diberikan Vercel (contoh: `https://scan-kalori-xxxx.vercel.app`).
   - Coba upload foto makanan dan klik "Analisis Foto".

## Catatan

- Free tier Gemini API punya rate limit (permintaan per menit/hari). Untuk pemakaian pribadi/kecil biasanya lebih dari cukup.
- Kalau mau ganti ke model Gemini lain, ubah nama model di `api/analyze.js` pada baris yang memanggil `generativelanguage.googleapis.com/v1beta/models/...`.
- Estimasi kalori dari AI bersifat perkiraan, bukan pengukuran presisi laboratorium.
