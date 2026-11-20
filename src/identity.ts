import fs from 'fs';
import path from 'path';

/**
 * WhatsApp kini memakai LID (Linked ID, contoh: 37267615797333@lid) sebagai
 * identitas pengirim, bukan nomor HP. Modul ini menyimpan pemetaan LID -> nomor HP
 * (disimpan permanen ke auth_info_baileys/lid-pn-map.json) agar bot tetap bisa
 * mencocokkan pengirim dengan nomor yang terdaftar di database.
 */

const MAP_FILE = path.resolve(process.cwd(), 'auth_info_baileys', 'lid-pn-map.json');
const lidToPn = new Map<string, string>();

function load() {
  try {
    if (fs.existsSync(MAP_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8')) as Record<string, string>;
      for (const [lid, pn] of Object.entries(raw)) lidToPn.set(lid, pn);
      console.log(`🔗 [LID MAP] ${lidToPn.size} pemetaan LID dimuat dari cache.`);
    }
  } catch (err) {
    console.warn('Gagal memuat cache LID map:', err);
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
    fs.writeFileSync(MAP_FILE, JSON.stringify(Object.fromEntries(lidToPn), null, 2), 'utf-8');
  } catch (err) {
    console.warn('Gagal menyimpan cache LID map:', err);
  }
}

load();

/** "628xxx:12@s.whatsapp.net" -> "628xxx" */
export function bareNumber(jid?: string | null): string {
  if (!jid) return '';
  return jid.split('@')[0].split(':')[0];
}

export function isLidJid(jid?: string | null): boolean {
  return Boolean(jid && jid.endsWith('@lid'));
}

/** Simpan pasangan LID <-> nomor HP (urutan argumen bebas, akan dideteksi otomatis). */
export function rememberLidPn(a?: string | null, b?: string | null) {
  if (!a || !b) return;
  let lid: string | undefined;
  let pn: string | undefined;
  for (const j of [a, b]) {
    if (isLidJid(j)) lid = j;
    else if (j.includes('@s.whatsapp.net') || /^\d+$/.test(j)) pn = j;
  }
  if (!lid || !pn) return;

  const l = bareNumber(lid);
  const p = bareNumber(pn);
  if (!l || !p || l === p || lidToPn.get(l) === p) return;

  lidToPn.set(l, p);
  save();
  console.log(`🔗 [LID MAP] ${l}@lid -> ${p}`);
}

export function getPnForLid(lid?: string | null): string | undefined {
  return lidToPn.get(bareNumber(lid));
}

