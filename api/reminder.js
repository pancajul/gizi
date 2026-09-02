// =========================================================================
// api/reminder.js — dipanggil scheduler EKSTERNAL (cron-job.org) tiap jam
// =========================================================================
//
// KENAPA TIDAK PAKAI CRON BAWAAN VERCEL?
// Cron gratis Vercel cuma bisa jalan 1x/hari, sedangkan kita butuh cek
// tiap jam (karena tiap user bisa pilih jam reminder yang beda-beda).
// Solusinya: endpoint ini adalah URL biasa yang bisa "dicolek" siapa saja
// pakai HTTP request -- dan cron-job.org (gratis) yang akan mencoleknya
// tiap jam secara otomatis.
//
// ALUR:
//   1. cron-job.org kirim request ke endpoint ini, tiap jam pas menit ke-0
//   2. Kita cek jam berapa sekarang (WIB)
//   3. Ambil semua user yang reminder_hours-nya mengandung jam ini
//   4. Kirim pesan pengingat ke masing-masing
// =========================================================================

import { getAllUsersWithReminder, currentHourWIB } from './db.js';

export const config = {
  maxDuration: 60,
};

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

export default async function handler(req, res) {
  // Endpoint ini sengaja menerima GET juga, karena kebanyakan scheduler
  // gratis (termasuk cron-job.org) defaultnya kirim GET request.
  if (!TELEGRAM_TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(200).json({ ok: false, error: 'Env var belum lengkap' });
  }

  try {
    const hour = currentHourWIB();
    const usersToRemind = await getAllUsersWithReminder(hour);

    for (const user of usersToRemind) {
      await sendMessage(
        user.chat_id,
        `⏰ Waktunya lapor! Udah makan/olahraga apa aja sejauh ini? Ceritain aja ke aku ya 😊`
      );
    }

    return res.status(200).json({ ok: true, hour, remindedCount: usersToRemind.length });
  } catch (err) {
    console.error('Error di reminder:', err);
    return res.status(200).json({ ok: false, error: err.message });
  }
}
