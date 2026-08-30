// Webhook handler untuk bot Telegram (Vercel serverless function)
// Telegram akan memanggil endpoint ini setiap kali ada pesan baru masuk ke bot.
//
// Env vars yang dibutuhkan (set di Vercel > Settings > Environment Variables):
//   TELEGRAM_BOT_TOKEN  -> token dari @BotFather
//   GEMINI_API_KEY      -> API key gratis dari https://ai.google.dev

// Naikkan batas waktu eksekusi function jadi 60 detik (default Vercel cuma 10 detik),
// supaya sempat: download foto -> panggil Gemini -> kirim balasan.
export const config = {
  maxDuration: 60,
};

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const SYSTEM_PROMPT = `Kamu adalah asisten nutrisi ahli. Kamu akan diberikan foto makanan.
Tugasmu:
1. Identifikasi jenis makanan/minuman yang ada di foto (bisa lebih dari satu item).
2. Perkirakan porsi/berat masing-masing item secara wajar berdasarkan tampilan visual.
3. Hitung estimasi kalori total dan breakdown makro (protein, karbohidrat, lemak) dalam gram.
4. Berikan catatan singkat (misal: tinggi gula, tinggi natrium, sumber protein baik, dsb).

PENTING: Balas HANYA dalam format JSON valid, tanpa teks lain, tanpa markdown, dengan struktur PERSIS seperti ini:
{
  "nama_hidangan": "string",
  "items": [
    {"nama": "string", "porsi_perkiraan": "string", "kalori": number}
  ],
  "total_kalori": number,
  "protein_g": number,
  "karbohidrat_g": number,
  "lemak_g": number,
  "catatan": "string singkat"
}
Jika gambar bukan makanan atau tidak jelas, kembalikan items kosong dan catatan yang menjelaskan itu.`;

async function tgCall(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function sendMessage(chatId, text) {
  return tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

async function downloadPhotoAsBase64(fileId) {
  const fileInfo = await tgCall('getFile', { file_id: fileId }).then((r) => r.result);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
  const fileRes = await fetch(fileUrl);
  const arrayBuffer = await fileRes.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  const ext = fileInfo.file_path.split('.').pop().toLowerCase();
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
  return { base64, mimeType };
}

async function analyzeWithGemini(base64, mimeType) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: SYSTEM_PROMPT },
              { inline_data: { mime_type: mimeType, data: base64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0.2 },
      }),
    }
  );

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned);
}

function formatResult(data) {
  if (!data.items || data.items.length === 0) {
    return `⚠️ ${data.catatan || 'Tidak bisa mengenali makanan pada foto ini. Coba foto yang lebih jelas ya.'}`;
  }

  const lines = [`🍱 <b>${data.nama_hidangan || 'Hasil Analisis Makanan'}</b>`, ''];
  for (const item of data.items) {
    lines.push(`• ${item.nama} (${item.porsi_perkiraan}) — ${item.kalori} kkal`);
  }
  lines.push('');
  lines.push(`🔥 <b>Total Kalori:</b> ${data.total_kalori} kkal`);
  lines.push(
    `🥩 Protein: ${data.protein_g} g   🍚 Karbo: ${data.karbohidrat_g} g   🧈 Lemak: ${data.lemak_g} g`
  );
  if (data.catatan) {
    lines.push('');
    lines.push(`💡 <i>${data.catatan}</i>`);
  }
  return lines.join('\n');
}

export default async function handler(req, res) {
  // Telegram akan hit endpoint ini dengan POST setiap ada update.
  if (req.method !== 'POST') {
    return res.status(200).send('Bot kalori aktif. Endpoint ini menerima webhook dari Telegram.');
  }

  if (!TELEGRAM_TOKEN || !GEMINI_API_KEY) {
    console.error('Env var TELEGRAM_BOT_TOKEN atau GEMINI_API_KEY belum di-set.');
    return res.status(200).json({ ok: true }); // tetap balas 200 ke Telegram supaya tidak retry terus
  }

  try {
    const update = req.body;
    const message = update.message;

    if (!message) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;

    // /start atau pesan teks biasa
    if (message.text) {
      await sendMessage(
        chatId,
        'Halo! 👋 Kirim foto makananmu, dan aku akan hitung estimasi kalori dan kandungan gizinya. 📸'
      );
      return res.status(200).json({ ok: true });
    }

    // Foto masuk
    if (message.photo && message.photo.length > 0) {
      await sendMessage(chatId, '🔍 Menganalisis foto makananmu, tunggu sebentar...');

      const largestPhoto = message.photo[message.photo.length - 1];
      const { base64, mimeType } = await downloadPhotoAsBase64(largestPhoto.file_id);
      const result = await analyzeWithGemini(base64, mimeType);
      const text = formatResult(result);

      await sendMessage(chatId, text);
      return res.status(200).json({ ok: true });
    }

    // Tipe pesan lain (stiker, dokumen, dll)
    await sendMessage(chatId, 'Kirim aku foto makanan ya untuk dianalisis kalorinya 📸');
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error di webhook:', err);
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) {
        await sendMessage(chatId, '⚠️ Maaf, ada kendala saat menganalisis foto. Coba kirim ulang ya.');
      }
    } catch (notifyErr) {
      console.error('Gagal kirim pesan error ke user:', notifyErr);
    }
    return res.status(200).json({ ok: true }); // tetap 200 supaya Telegram tidak spam retry
  }
}
