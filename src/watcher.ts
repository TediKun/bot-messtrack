import { WASocket } from '@whiskeysockets/baileys';
import { supabase } from './supabase.js';
import { config } from './config.js';

/**
 * Memantau perubahan data keuangan dari web (dashboard admin) dan otomatis
 * mengumumkannya ke grup mess: pengeluaran/pemasukan baru, koreksi, penghapusan,
 * denda baru, serta sisa saldo kas dan log pengeluaran terbaru.
 *
 * Memakai polling (bukan Supabase Realtime) agar tidak perlu mengaktifkan
 * replication di database.
 */

const POLL_MS = 30_000;

interface Tx {
  id: string;
  type: 'income' | 'expense' | 'fine_payment';
  amount: number;
  description: string;
  created_at: string;
}
interface FineRow {
  id: string;
  user_id: string;
  amount: number;
  reason: string;
  is_paid: boolean;
}

const rupiah = (n: number) => 'Rp' + Math.round(n).toLocaleString('id-ID');
const dateOf = (iso: string) => String(iso).split('T')[0];

function balanceOf(txs: Tx[]) {
  const income = txs
    .filter((t) => t.type === 'income' || t.type === 'fine_payment')
    .reduce((s, t) => s + Number(t.amount), 0);
  const expense = txs.filter((t) => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);
  return { balance: income - expense, expense };
}

function expenseLog(txs: Tx[], limit = 5) {
  const list = txs
    .filter((t) => t.type === 'expense')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit);
  if (list.length === 0) return '_Belum ada pengeluaran._';
  return list
    .map((t, i) => `${i + 1}. ${t.description} — ${rupiah(t.amount)} (${dateOf(t.created_at)})`)
    .join('\n');
}

export function startFinanceWatcher(getSock: () => WASocket | null) {
  let txSnapshot: Map<string, Tx> | null = null;
  let fineSnapshot: Map<string, FineRow> | null = null;
  let running = false;

  async function announce(text: string) {
    const jid = config.waMessGroupJid;
    const sock = getSock();
    if (!jid || !sock) return;
    try {
      await sock.sendMessage(jid, { text });
    } catch (err) {
      console.error('[WATCHER] Gagal kirim pengumuman ke grup:', err);
    }
  }

  async function userName(userId?: string | null) {
    if (!userId) return 'Penghuni';
    const { data } = await supabase.from('users').select('name').eq('id', userId).single();
    return data?.name || 'Penghuni';
  }

  async function tick() {
    if (running || !config.isConfigured()) return;
    running = true;
    try {
      const [txRes, fineRes] = await Promise.all([
        supabase.from('finance_transactions').select('id, type, amount, description, created_at'),
        supabase.from('fines').select('id, user_id, amount, reason, is_paid'),
      ]);
      if (txRes.error || fineRes.error) return; // jaringan/DB bermasalah: coba lagi nanti

      const txs = (txRes.data || []) as Tx[];
      const fines = (fineRes.data || []) as FineRow[];
      const txMap = new Map(txs.map((t) => [t.id, t]));
      const fineMap = new Map(fines.map((f) => [f.id, f]));

      // Pertama kali: hanya simpan kondisi awal, jangan umumkan apa pun
      if (!txSnapshot || !fineSnapshot) {
        txSnapshot = txMap;
        fineSnapshot = fineMap;
        console.log(`👀 [WATCHER] Memantau ${txMap.size} transaksi & ${fineMap.size} denda.`);
        return;
      }

      const messages: string[] = [];
      const { balance } = balanceOf(txs);

      for (const t of txs) {
        const old = txSnapshot.get(t.id);
        if (!old) {
          const label =
            t.type === 'expense' ? '💸 *PENGELUARAN BARU*' : t.type === 'fine_payment' ? '💰 *PEMBAYARAN DENDA*' : '💰 *PEMASUKAN BARU*';
          let text =
            `${label}\n\n` +
            `📦 *Keterangan:* ${t.description}\n` +
            `💵 *Nominal:* ${rupiah(t.amount)}\n` +
            `📅 *Tanggal:* ${dateOf(t.created_at)}\n\n` +
            `🏦 *Sisa Kas Mess: ${rupiah(balance)}*`;
          if (t.type === 'expense') {
            text += `\n\n📋 *Log pengeluaran terakhir:*\n${expenseLog(txs)}`;
          }
          messages.push(text);
        } else if (Number(old.amount) !== Number(t.amount) || old.description !== t.description) {
          messages.push(
            `✏️ *TRANSAKSI DIKOREKSI*\n\n` +
              `📦 ${old.description} → *${t.description}*\n` +
              `💵 ${rupiah(old.amount)} → *${rupiah(t.amount)}*\n\n` +
              `🏦 *Sisa Kas Mess: ${rupiah(balance)}*\n\n` +
              `📋 *Log pengeluaran terakhir:*\n${expenseLog(txs)}`
          );
        }
      }

      for (const [id, old] of txSnapshot) {
        if (!txMap.has(id)) {
          messages.push(
            `🗑️ *TRANSAKSI DIHAPUS*\n\n` +
              `📦 ${old.description} (${rupiah(old.amount)})\n\n` +
              `🏦 *Sisa Kas Mess: ${rupiah(balance)}*\n\n` +
              `📋 *Log pengeluaran terakhir:*\n${expenseLog(txs)}`
          );
        }
      }

      for (const f of fines) {
        const old = fineSnapshot.get(f.id);
        if (!old) {
          messages.push(
            `⚠️ *DENDA BARU*\n\n` +
              `👤 *${await userName(f.user_id)}*\n` +
              `💵 *Nominal:* ${rupiah(f.amount)}\n` +
              `📝 *Alasan:* ${f.reason}`
          );
        } else if (!old.is_paid && f.is_paid) {
          messages.push(
            `✅ *DENDA LUNAS*\n\n👤 *${await userName(f.user_id)}* telah melunasi denda ${rupiah(f.amount)}.\n📝 ${f.reason}`
          );
        }
      }

      txSnapshot = txMap;
      fineSnapshot = fineMap;

      for (const m of messages) {
        await announce(m);
      }
      if (messages.length) console.log(`📣 [WATCHER] ${messages.length} update dikirim ke grup.`);
    } catch (err) {
      console.error('[WATCHER] Error:', err);
    } finally {
      running = false;
    }
  }

  setInterval(tick, POLL_MS);
  tick();
}

