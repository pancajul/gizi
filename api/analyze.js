// Serverless function (Vercel) - menganalisis foto makanan pakai Gemini API (gratis)
// Env var yang dibutuhkan: GEMINI_API_KEY (set di dashboard Vercel > Settings > Environment Variables)

const SYSTEM_PROMPT = `Kamu adalah asisten nutrisi ahli. Kamu akan diberikan foto makanan.
Tugasmu:
1. Identifikasi jenis makanan/minuman yang ada di foto (bisa lebih dari satu item).
2. Perkirakan porsi/berat masing-masing item secara wajar berdasarkan tampilan visual.
3. Hitung estimasi kalori total dan breakdown makronutrien (protein, karbohidrat, lemak, serat, gula, natrium) dalam gram/miligram, mengikuti gaya label Nutrition Facts Amerika.
4. Berikan catatan singkat (misal: tinggi gula, tinggi natrium, sumber protein baik, dsb).

PENTING: Balas HANYA dalam format JSON valid, tanpa teks lain, tanpa markdown, dengan struktur PERSIS seperti ini:
{
  "nama_hidangan": "string, nama umum dari keseluruhan hidangan di foto",
  "items": [
    {"nama": "string", "porsi_perkiraan": "string"}
  ],
  "porsi_takaran": "string, misal '1 piring (approx 350g)'",
  "kalori": number,
  "lemak_total_g": number,
  "lemak_jenuh_g": number,
  "natrium_mg": number,
  "karbohidrat_total_g": number,
  "serat_g": number,
  "gula_g": number,
  "protein_g": number,
  "catatan": "string singkat, 1 kalimat"
}
Jika gambar bukan makanan atau tidak jelas, kembalikan semua angka 0, items kosong, dan catatan yang menjelaskan itu.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY belum di-set di environment variable server.' });
  }

  try {
    const { image, mimeType } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Tidak ada gambar yang dikirim.' });
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: SYSTEM_PROMPT },
                {
                  inline_data: {
                    mime_type: mimeType || 'image/jpeg',
                    data: image,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(502).json({ error: `Gemini API error: ${errText}` });
    }

    const data = await geminiRes.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      return res.status(502).json({ error: 'Gagal membaca hasil AI. Coba foto lain.', raw: rawText });
    }

    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
