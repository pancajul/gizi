// =========================================================================
// api/telegram.js — OTAK UTAMA BOT
// =========================================================================
//
// ALUR SETIAP PESAN MASUK:
//
//   1. Cek: user ini sudah pernah isi profil belum?
//      BELUM -> mode ONBOARDING: kumpulkan data dikit-dikit lewat obrolan
//               biasa, sampai lengkap, lalu hitung target kalori harian.
//      SUDAH -> lanjut ke langkah 2.
//
//   2. Kalau user kirim FOTO -> analisis pakai Gemini vision (seperti versi
//      sebelumnya), lalu otomatis dicatat sebagai log makan hari ini.
//
//   3. Kalau user kirim TEKS -> satu panggilan Gemini yang:
//        a. Menentukan maksud pesan (lapor makan? lapor olahraga? cuma
//           ngobrol? tanya sisa kalori? atur jadwal reminder?)
//        b. Kalau itu laporan makan/olahraga, sekaligus mengestimasi kalorinya
//        c. Menyusun balasan yang natural (bukan template kaku)
//      Baru bot mencatat ke database (kalau perlu) dan membalas.
//
// =========================================================================

import {
  getUser, createUser, updateUser,
  insertLog, getTodayLogs, getAllUsersWithReminder,
  todayWIB,
} from './db.js';

export const config = {
  maxDuration: 60,
};

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const GEMINI_MODEL_PRIMARY = 'gemini-flash-lite-latest';
const GEMINI_MODEL_FALLBACK = 'gemini-flash-latest';
const GEMINI_TIMEOUT_MS = 20000;

// =========================================================================
// TELEGRAM HELPERS
// =========================================================================

async function telegramApi(method, payload) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API error di ${method}: ${data.description || JSON.stringify(data)}`);
  }
  return data.result;
}

function sendMessage(chatId, text) {
  return telegramApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

async function downloadPhotoAsBase64(fileId) {
  const fileInfo = await telegramApi('getFile', { file_id: fileId });
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error(`Gagal download foto (status ${fileRes.status})`);
  const arrayBuffer = await fileRes.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  const ext = fileInfo.file_path.split('.').pop().toLowerCase();
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
  return { base64, mimeType };
}

// =========================================================================
// GEMINI HELPER — dengan retry + fallback kalau server lagi overload (503)
// =========================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(model, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.4 },
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`Gemini timeout setelah ${GEMINI_TIMEOUT_MS / 1000} detik`);
      err.status = 503; // treat as overload -> boleh retry/fallback
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }

  const data = await res.json();

  if (!res.ok) {
    const err = new Error(`Gemini API error (${res.status}): ${data?.error?.message || JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error(`Gemini tidak mengembalikan teks. Response: ${JSON.stringify(data)}`);

  const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`Gagal parse JSON dari Gemini. Teks asli: ${cleaned.slice(0, 300)}`);
  }
}

async function askGemini(parts) {
  const attempts = [
    { model: GEMINI_MODEL_PRIMARY, delayBefore: 0 },
    { model: GEMINI_MODEL_FALLBACK, delayBefore: 0 },
  ];

  let lastError;
  for (const attempt of attempts) {
    if (attempt.delayBefore) await sleep(attempt.delayBefore);
    try {
      return await callGemini(attempt.model, parts);
    } catch (err) {
      lastError = err;
      if (err.status && err.status !== 503) throw err;
    }
  }
  throw lastError;
}

// =========================================================================
// LOGIKA NUTRISI — hitung kebutuhan kalori dari profil (rumus Mifflin-St Jeor)
// =========================================================================

const ACTIVITY_FACTOR = {
  sedentary: 1.2,     // jarang/tidak olahraga
  light: 1.375,       // olahraga ringan 1-3x/minggu
  moderate: 1.55,     // olahraga sedang 3-5x/minggu
  active: 1.725,      // olahraga berat 6-7x/minggu
  very_active: 1.9,   // atlet / sangat aktif
};

const GOAL_ADJUSTMENT = {
  cut: -500,      // defisit untuk turun berat badan
  maintain: 0,
  bulk: 500,      // surplus untuk naik berat badan
};

function computeTargetCalories(profile) {
  const { gender, age, weight_kg, height_cm, activity_level, goal } = profile;

  let bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age;
  bmr += gender === 'pria' ? 5 : -161;

  const tdee = bmr * (ACTIVITY_FACTOR[activity_level] || 1.2);
  const target = tdee + (GOAL_ADJUSTMENT[goal] ?? 0);

  return Math.round(target);
}

// =========================================================================
// PROMPT — ONBOARDING (mengumpulkan data profil lewat obrolan bebas)
// =========================================================================

function buildOnboardingPrompt(existingData, userMessage) {
  return `Kamu membantu mengumpulkan data profil pengguna untuk menghitung kebutuhan kalori harian.
Data yang SUDAH terkumpul sejauh ini: ${JSON.stringify(existingData)}

Pesan baru dari user: "${userMessage}"

Field yang dibutuhkan:
- gender: "pria" atau "wanita"
- age: umur dalam tahun (angka)
- weight_kg: berat badan dalam kg (angka)
- height_cm: tinggi badan dalam cm (angka)
- activity_level: salah satu dari "sedentary" (jarang olahraga), "light" (olahraga ringan 1-3x/minggu), "moderate" (olahraga sedang 3-5x/minggu), "active" (olahraga berat 6-7x/minggu), "very_active" (atlet/sangat aktif)
- goal: salah satu dari "cut" (turun berat badan/diet), "maintain" (jaga berat badan), "bulk" (naik berat badan)

Gabungkan data lama dengan info baru dari pesan user (kalau ada field yang disebut ulang dengan nilai beda, pakai yang terbaru).

Balas HANYA dalam format JSON, tanpa teks lain:
{
  "data": { "gender": ..., "age": ..., "weight_kg": ..., "height_cm": ..., "activity_level": ..., "goal": ... },
  "complete": boolean (true kalau SEMUA field di atas sudah terisi, false kalau masih ada yang null),
  "reply": "balasan ramah dalam Bahasa Indonesia santai. Kalau belum complete, tanya 1-2 field yang masih kosong dengan natural (jangan kaku seperti form). Kalau complete, cukup bilang 'siap, sebentar aku hitung ya' tanpa menyebutkan angka apapun."
}`;
}

// =========================================================================
// PROMPT — CHAT HARIAN (klasifikasi + logging + balasan natural)
// =========================================================================

function buildChatPrompt(profile, todaySummary, userMessage) {
  return `Kamu adalah asisten nutrisi personal yang ramah, santai, dan suportif. Gunakan Bahasa Indonesia santai sehari-hari, boleh emoji secukupnya (jangan berlebihan).

PROFIL USER:
${JSON.stringify(profile)}

RINGKASAN HARI INI:
- Target kalori harian: ${todaySummary.target} kkal
- Sudah makan: ${todaySummary.foodCalories} kkal
- Sudah olahraga (kalori terbakar): ${todaySummary.exerciseCalories} kkal
- Sisa kalori: ${todaySummary.remaining} kkal

PESAN USER: "${userMessage}"

Tentukan maksud pesan ini dan balas HANYA dalam format JSON:
{
  "intent": "food_log" | "exercise_log" | "summary_request" | "reminder_setting" | "chat",
  "log_description": "string, deskripsi singkat makanan/olahraga (null kalau bukan food_log/exercise_log)",
  "log_calories": number (untuk food_log: kalori masuk; untuk exercise_log: kalori yang terbakar, selalu angka positif; null kalau bukan keduanya),
  "reminder_hours": [array angka jam 0-23 dalam WIB] (isi HANYA kalau intent reminder_setting, null selainnya),
  "reply": "balasan natural ke user dalam Bahasa Indonesia santai"
}

PANDUAN:
- food_log: user cerita makan/minum sesuatu (misal "tadi sarapan roti telur", "ngemil gorengan 2 biji"). Estimasikan kalorinya secara wajar. Reply berisi konfirmasi santai + sisa kalori hari ini setelah ditambah ini.
- exercise_log: user cerita olahraga/aktivitas fisik (misal "lari pagi 30 menit", "gym 1 jam angkat beban"). Estimasikan kalori yang terbakar. Reply berisi apresiasi + update sisa kalori (yang jadi lebih longgar).
- summary_request: user tanya progress/sisa kalori hari ini. Reply berisi ringkasan lengkap dengan nada suportif.
- reminder_setting: user minta diingatkan di jam tertentu (misal "ingetin aku jam 8 pagi, 12 siang, 7 malem"). Reply konfirmasi jam yang di-set.
- chat: selain semua di atas -- ngobrol biasa, curhat, tanya-tanya, cerita di luar topik makanan. Balas natural dan hangat seperti teman, TIDAK KAKU. Boleh selipkan encouragement soal progress kalau relevan dan pas, tapi tidak wajib di setiap balasan.`;
}

// =========================================================================
// PROMPT — ANALISIS FOTO MAKANAN (sama seperti versi sebelumnya)
// =========================================================================

const PHOTO_PROMPT = `Kamu adalah asisten nutrisi ahli. Kamu akan diberikan foto makanan.
Identifikasi makanan di foto, perkirakan porsinya, dan hitung estimasi kalori totalnya.

Balas HANYA dalam format JSON:
{
  "nama_hidangan": "string",
  "kalori": number,
  "catatan": "string singkat, 1 kalimat"
}
Jika gambar bukan makanan, kembalikan kalori 0 dan catatan yang menjelaskan itu.`;

// =========================================================================
// HANDLER: ONBOARDING
// =========================================================================

async function handleOnboarding(chatId, user, userMessage) {
  const existingData = JSON.parse(user.onboarding_data || '{}');
  const result = await askGemini([{ text: buildOnboardingPrompt(existingData, userMessage) }]);

  await updateUser(chatId, { onboarding_data: JSON.stringify(result.data) });

  if (!result.complete) {
    await sendMessage(chatId, result.reply);
    return;
  }

  // Data lengkap -> hitung target kalori dan simpan sebagai profil final
  const targetCalories = computeTargetCalories(result.data);

  await updateUser(chatId, {
    onboarding_done: true,
    gender: result.data.gender,
    age: result.data.age,
    weight_kg: result.data.weight_kg,
    height_cm: result.data.height_cm,
    activity_level: result.data.activity_level,
    goal: result.data.goal,
    target_calories: targetCalories,
  });

  const goalLabel = { cut: 'menurunkan berat badan', maintain: 'menjaga berat badan', bulk: 'menaikkan berat badan' }[result.data.goal];

  await sendMessage(
    chatId,
    `Siap, profil kamu sudah aku catat! 🎯\n\n` +
    `Target kalori harianmu untuk ${goalLabel}: <b>${targetCalories} kkal/hari</b>\n\n` +
    `Sekarang tinggal cerita aja tiap kali makan atau olahraga, aku yang catetin dan itung otomatis. ` +
    `Foto juga bisa. Mau atur jam pengingat harian juga? Tinggal bilang aja, misal "ingetin aku jam 8, 12, dan 7 malam".`
  );
}

// =========================================================================
// HANDLER: RINGKASAN HARI INI (dipakai berkali-kali)
// =========================================================================

async function getTodaySummary(chatId, profile) {
  const logDate = todayWIB();
  const logs = await getTodayLogs(chatId, logDate);

  const foodCalories = logs.filter((l) => l.type === 'food').reduce((sum, l) => sum + l.calories, 0);
  const exerciseCalories = logs.filter((l) => l.type === 'exercise').reduce((sum, l) => sum + l.calories, 0);
  const target = profile.target_calories;
  const remaining = target - foodCalories + exerciseCalories;

  return { logDate, foodCalories, exerciseCalories, target, remaining };
}

// =========================================================================
// HANDLER: PESAN TEKS SETELAH ONBOARDING SELESAI
// =========================================================================

async function handleChatMessage(chatId, user, userMessage) {
  const profile = {
    gender: user.gender, age: user.age, weight_kg: user.weight_kg,
    height_cm: user.height_cm, activity_level: user.activity_level, goal: user.goal,
  };

  const summary = await getTodaySummary(chatId, user);
  const result = await askGemini([
    { text: buildChatPrompt(profile, summary, userMessage) },
  ]);

  if (result.intent === 'food_log' && result.log_calories) {
    await insertLog(chatId, summary.logDate, 'food', result.log_description, result.log_calories);
  } else if (result.intent === 'exercise_log' && result.log_calories) {
    await insertLog(chatId, summary.logDate, 'exercise', result.log_description, result.log_calories);
  } else if (result.intent === 'reminder_setting' && result.reminder_hours) {
    await updateUser(chatId, { reminder_hours: result.reminder_hours.join(',') });
  }

  await sendMessage(chatId, result.reply);
}

// =========================================================================
// HANDLER: FOTO MAKANAN
// =========================================================================

async function handlePhotoMessage(chatId, user, fileId) {
  await sendMessage(chatId, '🔍 Menganalisis foto makananmu, tunggu sebentar...');

  const { base64, mimeType } = await downloadPhotoAsBase64(fileId);
  const result = await askGemini([
    { text: PHOTO_PROMPT },
    { inline_data: { mime_type: mimeType, data: base64 } },
  ]);

  if (!result.kalori) {
    await sendMessage(chatId, `⚠️ ${result.catatan || 'Tidak bisa mengenali makanan pada foto ini.'}`);
    return;
  }

  const logDate = todayWIB();
  await insertLog(chatId, logDate, 'food', result.nama_hidangan, result.kalori);

  const summary = await getTodaySummary(chatId, user);

  await sendMessage(
    chatId,
    `🍱 <b>${result.nama_hidangan}</b> — ${result.kalori} kkal\n\n` +
    `${result.catatan ? `💡 <i>${result.catatan}</i>\n\n` : ''}` +
    `📊 Total hari ini: ${summary.foodCalories} kkal makan, ${summary.exerciseCalories} kkal terbakar\n` +
    `Sisa kalori: <b>${summary.remaining} kkal</b>`
  );
}

// =========================================================================
// HANDLER UTAMA
// =========================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot Gizi AI aktif. Endpoint ini menerima webhook dari Telegram.');
  }

  if (!TELEGRAM_TOKEN || !GEMINI_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('Ada environment variable yang belum di-set.');
    return res.status(200).json({ ok: true });
  }

  const message = req.body?.message;
  if (!message) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;

  try {
    let user = await getUser(chatId);
    if (!user) user = await createUser(chatId);

    // --- /start selalu disambut, tidak dianggap bagian dari onboarding data
    if (message.text === '/start') {
      if (user.onboarding_done) {
        await sendMessage(chatId, 'Halo lagi! 👋 Ada yang mau dicatat atau ditanyain?');
      } else {
        await sendMessage(
          chatId,
          'Halo! 👋 Aku bakal bantu hitung kebutuhan kalori harianmu dan catat makan/olahragamu tiap hari.\n\n' +
          'Boleh cerita dulu: umur, gender, berat badan, tinggi badan, seberapa sering kamu olahraga, dan tujuanmu (turun/jaga/naik berat badan)?\n\n' +
          'Bebas kok, nggak perlu format khusus -- misal "cewek, 24 tahun, 55kg, 160cm, jarang olahraga, mau diet".'
        );
      }
      return res.status(200).json({ ok: true });
    }

    // --- Mode onboarding: user belum lengkap profilnya
    if (!user.onboarding_done) {
      if (!message.text) {
        await sendMessage(chatId, 'Ceritain dulu data dirinya via teks ya, biar aku bisa hitung kebutuhan kalorimu 🙂');
        return res.status(200).json({ ok: true });
      }
      await handleOnboarding(chatId, user, message.text);
      return res.status(200).json({ ok: true });
    }

    // --- Sudah onboarding: foto -> analisis + catat otomatis
    if (message.photo && message.photo.length > 0) {
      const largestPhoto = message.photo[message.photo.length - 1];
      await handlePhotoMessage(chatId, user, largestPhoto.file_id);
      return res.status(200).json({ ok: true });
    }

    // --- Sudah onboarding: teks -> klasifikasi + catat/jawab
    if (message.text) {
      await handleChatMessage(chatId, user, message.text);
      return res.status(200).json({ ok: true });
    }

    // --- Tipe pesan lain
    await sendMessage(chatId, 'Ceritain aja makan/olahragamu, atau kirim foto makanan ya 📸');
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Error saat memproses pesan:', err);
    try {
      await sendMessage(chatId, `⚠️ Maaf, ada kendala.\n\nDetail: ${err.message}`);
    } catch (notifyErr) {
      console.error('Gagal kirim pesan error ke user:', notifyErr);
    }
    return res.status(200).json({ ok: true });
  }
}
