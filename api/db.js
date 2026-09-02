// =========================================================================
// db.js — helper untuk baca/tulis ke Supabase (database gratis kita)
// =========================================================================
// Kita pakai Supabase lewat REST API langsung (fetch biasa), TANPA library
// tambahan. Alasannya: lebih ringan, tidak ada dependency yang perlu
// di-install, dan lebih gampang dibaca urutan kerjanya.
//
// Cara kerja REST API Supabase (PostgREST):
//   GET    /rest/v1/users?chat_id=eq.123        -> ambil data
//   POST   /rest/v1/users                        -> tambah data baru
//   PATCH  /rest/v1/users?chat_id=eq.123          -> update data
// =========================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function supabaseRequest(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let res;
  try {
    res = await fetch(url, { ...options, headers: headers(options.headers), signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Supabase timeout setelah 15s di ${path}`);
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase error (${res.status}) di ${path}: ${errText}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// -------------------------------------------------------------------------
// USERS
// -------------------------------------------------------------------------

export async function getUser(chatId) {
  const rows = await supabaseRequest(`users?chat_id=eq.${chatId}`);
  return rows && rows.length > 0 ? rows[0] : null;
}

export async function createUser(chatId) {
  return supabaseRequest('users', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ chat_id: chatId, onboarding_done: false, onboarding_data: '{}' }]),
  }).then((rows) => rows[0]);
}

export async function updateUser(chatId, fields) {
  return supabaseRequest(`users?chat_id=eq.${chatId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  }).then((rows) => rows[0]);
}

export async function getAllUsersWithReminder(hourWIB) {
  // reminder_hours disimpan sebagai teks dipisah koma, contoh: "8,12,18"
  // Kita ambil semua user yang onboarding-nya selesai, filter jam-nya di kode
  // (lebih simpel daripada query array di PostgREST).
  const rows = await supabaseRequest('users?onboarding_done=eq.true');
  return (rows || []).filter((u) => {
    if (!u.reminder_hours) return false;
    const hours = u.reminder_hours.split(',').map((h) => parseInt(h.trim(), 10));
    return hours.includes(hourWIB);
  });
}

// -------------------------------------------------------------------------
// LOGS (catatan makan & olahraga harian)
// -------------------------------------------------------------------------

export async function insertLog(chatId, logDate, type, description, calories) {
  return supabaseRequest('logs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([
      { chat_id: chatId, log_date: logDate, type, description, calories },
    ]),
  }).then((rows) => rows[0]);
}

export async function getTodayLogs(chatId, logDate) {
  return supabaseRequest(`logs?chat_id=eq.${chatId}&log_date=eq.${logDate}&order=created_at.asc`);
}

// -------------------------------------------------------------------------
// UTIL: tanggal & jam WIB (UTC+7), supaya "hari ini" konsisten buat semua user
// -------------------------------------------------------------------------

export function todayWIB() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000); // geser ke WIB
  return now.toISOString().split('T')[0]; // "YYYY-MM-DD"
}

export function currentHourWIB() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return now.getUTCHours();
}
