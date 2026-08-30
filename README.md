# Bot Telegram — Scan Kalori

Bot Telegram: kirim foto makanan → dapat balasan estimasi kalori & makro.
100% gratis: hosting di Vercel (serverless, webhook — bukan proses yang harus nyala terus) + AI vision di Gemini API (free tier).

## Struktur project

```
telegram-kalori/
├── api/
│   └── telegram.js   ← webhook handler, dipanggil Telegram setiap ada pesan masuk
├── package.json
└── README.md
```

Kenapa serverless/webhook cocok untuk hosting gratis: bot **tidak perlu proses yang nyala 24 jam** menunggu pesan (seperti `polling`). Telegram yang akan "membangunkan" function ini tiap kali ada pesan masuk, lalu function tidur lagi. Ini pas banget dengan model gratis Vercel yang menagih berdasarkan pemakaian, bukan waktu nyala.

## Langkah setup

### 1. Buat bot & dapatkan token
- Buka Telegram, chat `@BotFather`
- Ketik `/newbot`, ikuti instruksi (kasih nama & username)
- Simpan **BOT TOKEN** yang diberikan

### 2. Dapatkan Gemini API Key (gratis)
- Buka https://ai.google.dev → "Get API key" → login dengan akun Google → buat key baru
- Simpan API key-nya

### 3. Upload project ke GitHub
- Buat repo baru di GitHub (lewat web saja: "Add file" → "Upload files")
- Drag semua file dari project ini ke sana

### 4. Deploy ke Vercel
- Login ke https://vercel.com pakai akun GitHub (gratis)
- "Add New" → "Project" → pilih repo tadi → klik **Deploy** (tidak perlu ubah setting apa pun)
- Setelah selesai, kamu akan dapat URL seperti `https://telegram-kalori-xxxx.vercel.app`

### 5. Set environment variables
- Di dashboard project Vercel → Settings → Environment Variables, tambahkan:
  - `TELEGRAM_BOT_TOKEN` = token dari langkah 1
  - `GEMINI_API_KEY` = key dari langkah 2
- Redeploy project (Deployments → tombol "Redeploy" di deployment terakhir) supaya env var kebaca

### 6. Daftarkan webhook ke Telegram

Ini langkah penting yang bikin Telegram tahu ke mana harus kirim pesan. Buka URL berikut di browser (ganti bagian yang perlu diganti):

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<nama-project-kamu>.vercel.app/api/telegram
```

Contoh:
```
https://api.telegram.org/bot123456:ABC-DEF/setWebhook?url=https://telegram-kalori-xxxx.vercel.app/api/telegram
```

Kalau berhasil, browser akan menampilkan:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

### 7. Selesai — coba bot-nya
- Buka Telegram, cari bot kamu (sesuai username yang dibuat di langkah 1)
- Ketik `/start`, lalu kirim foto makanan
- Bot akan balas estimasi kalori & gizinya

## Cek status webhook (opsional, buat debugging)

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo
```

Kalau ada error, biasanya muncul di field `last_error_message`.

## Catatan

- Free tier Gemini API punya rate limit harian — cukup untuk pemakaian pribadi/kecil.
- Free tier Vercel juga punya limit jumlah eksekusi function per bulan, tapi jauh lebih dari cukup untuk bot personal.
- Estimasi kalori dari AI bersifat perkiraan, bukan pengukuran presisi laboratorium.
