// =========================================================================
// BOT TELEGRAM — SCAN KALORI DARI FOTO MAKANAN
// =========================================================================
//
// ALUR KERJANYA:
//   1. User kirim foto ke bot di Telegram
//   2. Telegram memanggil URL ini (webhook) dengan data pesan tersebut
//   3. Kita download foto itu dari server Telegram
//   4. Foto dikirim ke Gemini API (vision) dengan instruksi untuk
//      mengenali makanan dan menghitung kalori/gizinya
//   5. Hasilnya diformat jadi teks rapi dan dikirim balik ke user
//
// ENV VARS YANG WAJIB DI-SET (di Vercel > Settings > Environment Variables):
//   TELEGRAM_BOT_TOKEN  -> didapat dari @BotFather di Telegram
//   GEMINI_API_KEY      -> didapat gratis dari https://ai.google.dev
//
// =========================================================================

// Batas waktu eksekusi function dinaikkan ke 60 detik.
// Default Vercel cuma 10 detik, dan itu SERING KURANG karena proses kita
// harus: kirim pesan -> download foto -> panggil Gemini -> kirim hasil.
export const config = {
  maxDuration: 60,
};

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Model Gemini yang dipakai. "gemini-flash-latest" adalah ALIAS yang selalu
// mengarah ke versi Flash terbaru dari Google, jadi tidak perlu diganti manual
// tiap kali Google merilis versi baru atau mem-pensiunkan versi lama.
const GEMINI_MODEL = 'gemini-flash-latest';

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

// -------------------------------------------------------------------------
// HELPER: panggil method Telegram Bot API (sendMessage, getFile, dst)
// -------------------------------------------------------------------------
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

// -------------------------------------------------------------------------
// STEP 1: download foto dari server Telegram, ubah jadi base64
// -------------------------------------------------------------------------
async function downloadPhotoAsBase64(fileId) {
  const fileInfo = await telegramApi('getFile', { file_id: fileId });
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;

  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`Gagal download foto dari Telegram (status ${fileRes.status})`);
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  const ext = fileInfo.file_path.split('.').pop().toLowerCase();
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

  return { base64, mimeType };
}

// -------------------------------------------------------------------------
// STEP 2: kirim foto ke Gemini API, minta analisis dalam format JSON
// -------------------------------------------------------------------------
async function analyzeWithGemini(base64, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
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
  });

  const data = await res.json();

  // Selalu cek res.ok dulu -- kalau tidak, error dari Google (misal API key
  // salah, model tidak ditemukan, kuota habis) akan tertelan diam-diam dan
  // menyebabkan error yang membingungkan di langkah berikutnya.
  if (!res.ok) {
    throw new Error(`Gemini API error (${res.status}): ${data?.error?.message || JSON.stringify(data)}`);
  }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error(`Gemini tidak mengembalikan hasil teks. Response: ${JSON.stringify(data)}`);
  }

  const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`Gagal membaca hasil dari Gemini sebagai JSON. Teks asli: ${cleaned.slice(0, 300)}`);
  }
}

// -------------------------------------------------------------------------
// STEP 3: format hasil analisis jadi teks yang enak dibaca di Telegram
// -------------------------------------------------------------------------
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

// -------------------------------------------------------------------------
// HANDLER UTAMA — dipanggil Telegram setiap ada pesan baru masuk ke bot
// -------------------------------------------------------------------------
export default async function handler(req, res) {
  // GET dipakai cuma untuk cek manual di browser, bukan dari Telegram
  if (req.method !== 'POST') {
    return res.status(200).send('Bot kalori aktif. Endpoint ini menerima webhook dari Telegram.');
  }

  if (!TELEGRAM_TOKEN || !GEMINI_API_KEY) {
    console.error('TELEGRAM_BOT_TOKEN atau GEMINI_API_KEY belum di-set di environment variable.');
    return res.status(200).json({ ok: true });
  }

  const message = req.body?.message;
  if (!message) {
    // Update jenis lain (misal edited_message) -- abaikan saja
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat.id;

  try {
    // Kasus 1: pesan teks biasa / command
    if (message.text) {
      await sendMessage(
        chatId,
        'Halo! 👋 Kirim foto makananmu, dan aku akan hitung estimasi kalori dan kandungan gizinya. 📸'
      );
      return res.status(200).json({ ok: true });
    }

    // Kasus 2: foto masuk -- ini alur utamanya
    if (message.photo && message.photo.length > 0) {
      await sendMessage(chatId, '🔍 Menganalisis foto makananmu, tunggu sebentar...');

      // Telegram mengirim beberapa resolusi sekaligus; ambil yang terbesar
      const largestPhoto = message.photo[message.photo.length - 1];

      const { base64, mimeType } = await downloadPhotoAsBase64(largestPhoto.file_id);
      const result = await analyzeWithGemini(base64, mimeType);
      const formattedText = formatResult(result);

      await sendMessage(chatId, formattedText);
      return res.status(200).json({ ok: true });
    }

    // Kasus 3: tipe pesan lain (stiker, dokumen, voice note, dll)
    await sendMessage(chatId, 'Kirim aku foto makanan ya untuk dianalisis kalorinya 📸');
    return res.status(200).json({ ok: true });

  } catch (err) {
    // Kalau ada error di mana pun di atas, tangkap di sini supaya:
    // (a) user tetap dapat pesan, tidak nge-hang di "menganalisis..."
    // (b) kita bisa lihat detail error-nya untuk debugging
    console.error('Error saat memproses pesan:', err);

    try {
      await sendMessage(chatId, `⚠️ Maaf, ada kendala saat menganalisis foto.\n\nDetail: ${err.message}`);
    } catch (notifyErr) {
      console.error('Gagal kirim pesan error ke user:', notifyErr);
    }

    // Tetap balas 200 ke Telegram, supaya Telegram tidak mengulang-ulang
    // kirim webhook yang sama karena mengira gagal.
    return res.status(200).json({ ok: true });
  }
}
