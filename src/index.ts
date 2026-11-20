import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  proto,
  WASocket,
  WAMessage,
  WAMessageKey,
  CacheStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import path from 'path';
import { config } from './config.js';
import { supabase, fallbackUsers, User } from './supabase.js';
import { bareNumber, isLidJid, rememberLidPn, getPnForLid } from './identity.js';
import { verifyTaskPhoto, scanReceiptAmount, askAira } from './ai.js';
import { setupCronJobs } from './cron.js';
import { startFinanceWatcher } from './watcher.js';
import { generateFinanceExcelBuffer } from './excel.js';

// Clean and normalize phone number into standard variants
function cleanNumberOnly(str: string): string {
  return str.replace(/\D/g, '');
}

function getPhoneVariants(rawPhone: string): string[] {
  const digits = cleanNumberOnly(rawPhone);
  if (!digits) return [];

  const variants = new Set<string>();
  variants.add(digits);

  // If starts with 628...
  if (digits.startsWith('62')) {
    variants.add('0' + digits.slice(2));
    variants.add('+' + digits);
    variants.add(digits.slice(2)); // e.g. 812xxx
  } else if (digits.startsWith('0')) {
    variants.add('62' + digits.slice(1));
    variants.add('+62' + digits.slice(1));
    variants.add(digits.slice(1)); // e.g. 812xxx
  } else if (digits.startsWith('8')) {
    variants.add('0' + digits);
    variants.add('62' + digits);
    variants.add('+62' + digits);
  }

  return Array.from(variants);
}

// Ambil daftar user terdaftar (DB, fallback ke data statis)
async function getRegisteredUsers(): Promise<User[]> {
  if (config.isConfigured()) {
    try {
      const { data } = await supabase.from('users').select('*');
      if (data && data.length > 0) return data as User[];
    } catch (err) {
      console.error('Gagal mengambil daftar user dari Supabase:', err);
    }
  }
  return fallbackUsers;
}

// Tanya server WhatsApp LID milik setiap nomor terdaftar, lalu simpan ke cache.
let lastLidRefresh = 0;
async function refreshRegisteredLids(sock: WASocket, force = false) {
  if (!force && Date.now() - lastLidRefresh < 60_000) return; // throttle 1 menit
  lastLidRefresh = Date.now();
  try {
    const users = await getRegisteredUsers();
    for (const u of users) {
      const digits = cleanNumberOnly(u.phone_number || '');
      if (!digits) continue;
      const phone = digits.startsWith('0') ? '62' + digits.slice(1) : digits;
      try {
        const res = await sock.onWhatsApp(`${phone}@s.whatsapp.net`);
        const hit = res?.[0];
        if (hit?.exists && typeof hit.lid === 'string') {
          rememberLidPn(hit.lid, hit.jid || `${phone}@s.whatsapp.net`);
        }
      } catch (e) {
        console.warn(`Gagal cek LID untuk ${u.name} (${phone}):`, (e as Error).message);
      }
    }
  } catch (err) {
    console.error('Gagal refresh LID penghuni:', err);
  }
}

/**
 * Tentukan nomor HP asli pengirim pesan.
 * WhatsApp bisa mengirim identitas berupa LID (xxx@lid), jadi kita coba:
 * 1) field alternatif dari Baileys (senderPn / participantPn)
 * 2) cache LID -> nomor
 * 3) refresh LID semua nomor terdaftar via onWhatsApp, lalu cek ulang cache
 */
async function resolveSenderPhone(msg: WAMessage, sock: WASocket): Promise<{ jid: string; phone: string }> {
  const key = msg.key as WAMessageKey;
  const isGroup = Boolean(key.remoteJid?.endsWith('@g.us'));
  const jid = (isGroup ? key.participant : key.remoteJid) || '';

  // Rekam semua pasangan LID <-> PN yang dikirim server
  if (isGroup) {
    rememberLidPn(key.participant, key.participantPn);
    rememberLidPn(key.participant, key.participantLid);
  } else {
    rememberLidPn(key.remoteJid, key.senderPn);
    rememberLidPn(key.remoteJid, key.senderLid);
  }

  if (!isLidJid(jid)) return { jid, phone: bareNumber(jid) };

  let pn = getPnForLid(jid);
  if (!pn) {
    await refreshRegisteredLids(sock);
    pn = getPnForLid(jid);
  }
  return { jid, phone: pn || '' };
}

// Cari user terdaftar berdasarkan nomor HP
async function findUserByPhone(rawSenderNumber: string, jidForLog: string): Promise<User | null> {
  if (!rawSenderNumber) {
    console.warn(`❌ [AUTH FAILED] Nomor HP untuk ${jidForLog} belum bisa diketahui (LID belum terpetakan).`);
    return null;
  }

  const senderVariants = getPhoneVariants(rawSenderNumber);

  console.log(`🔍 [AUTH CHECK] JID: ${jidForLog} -> Nomor: ${rawSenderNumber}, Variants:`, senderVariants);

  if (config.isConfigured()) {
    try {
      // 1. First attempt: Query with OR filter on phone_number
      const orFilter = senderVariants.map((v) => `phone_number.eq.${v}`).join(',');
      const { data: users, error } = await supabase
        .from('users')
        .select('*')
        .or(orFilter);

      if (!error && users && users.length > 0) {
        console.log(`✅ [AUTH SUCCESS] User found: ${users[0].name} (${users[0].phone_number})`);
        return users[0];
      }

      // 2. Second attempt: In case phone stored with dashes/spaces/symbols in DB, check all users
      const { data: allUsers } = await supabase.from('users').select('*');
      if (allUsers && allUsers.length > 0) {
        for (const u of allUsers) {
          const userDigits = cleanNumberOnly(u.phone_number || '');
          const userVariants = getPhoneVariants(userDigits);
          if (senderVariants.some((sv) => userVariants.includes(sv))) {
            console.log(`✅ [AUTH SUCCESS via regex] User found: ${u.name} (${u.phone_number})`);
            return u;
          }
        }
      }
    } catch (err) {
      console.error('Error querying user from Supabase:', err);
    }
  }

  // Fallback users check
  for (const u of fallbackUsers) {
    const userVariants = getPhoneVariants(u.phone_number);
    if (senderVariants.some((sv) => userVariants.includes(sv))) {
      console.log(`✅ [AUTH FALLBACK] User found: ${u.name}`);
      return u;
    }
  }

  console.warn(`❌ [AUTH FAILED] Nomor ${rawSenderNumber} (${jidForLog}) tidak terdaftar.`);
  return null;
}

// Cek apakah sebuah JID adalah milik bot (format nomor HP maupun LID)
function isBotJid(sock: WASocket, jid?: string | null): boolean {
  if (!jid) return false;
  const target = bareNumber(jid);
  const me = sock.user as { id?: string; lid?: string } | undefined;
  return Boolean(target && (target === bareNumber(me?.id) || target === bareNumber(me?.lid)));
}

const WELCOME_TEXT =
  `👋 *Halo rekan-rekan mess! Salam kenal, saya Aira (MessTrack AI).* 🤖✨\n\n` +
  `Saya hadir di grup ini sebagai *problem solver* untuk membenahi sistem manual menjadi serba otomatis, teratur, dan transparan:\n\n` +
  `🎯 *Misi Utama Aira:*\n` +
  `1. *Ketertiban & Kebersihan Mess:* Memastikan jadwal piket harian berjalan disiplin tanpa saling tunjuk, mencatat bukti foto secara real-time, dan mengevaluasi target mingguan otomatis.\n` +
  `2. *Transparansi Kas & Finansial:* Mencatat keluar-masuk uang kas secara terbuka tanpa ada kecurigaan atau pencatatan manual yang rawan selip.\n` +
  `3. *Penyelesai Masalah & Mediator:* Bersikap adil, tegas, dan netral membantu Admin menengahi kesalahpahaman atau perselisihan tugas di mess secara bijaksana.\n\n` +
  `📌 *Panduan Penggunaan Singkat:*\n` +
  `• 🧹 *Lapor Piket:* Kirim foto bukti dengan hashtag \`#sampah\`, \`#sapu\`, \`#pel\`, atau \`#wc\`\n` +
  `• 💰 *Catat Belanja Mess:* Ketik \`#keluar [Nominal] [Keterangan]\` (misal: \`#keluar 35000 beli wipol & sabun\`)\n` +
  `• 💳 *Bayar Iuran/Kas:* Kirim foto bukti transfer dengan caption \`#bayarkas\`\n` +
  `• 💬 *Tanya Jawab / Diskusi:* Cukup tag @Aira di grup ini atau chat pribadi langsung ke nomor saya.\n\n` +
  `_Mari kita jaga kenyamanan, kekompakan, dan kebersihan mess bersama-sama!_ 🌟💪`;

// Daftarkan grup sebagai grup mess + kirim sambutan (dipanggil saat bot dimasukkan ke grup)
const welcomedGroups = new Set<string>();
async function registerGroup(sock: WASocket, groupJid: string, reason: string) {
  if (!groupJid.endsWith('@g.us') || welcomedGroups.has(groupJid)) return;
  welcomedGroups.add(groupJid);
  console.log(`👥 [GROUP DETECTED] Bot masuk ke grup ${groupJid} (${reason})`);
  config.updateGroupJid(groupJid);
  try {
    await sock.sendMessage(groupJid, { text: WELCOME_TEXT });
  } catch (err) {
    console.error('Gagal mengirim pesan sambutan grup:', err);
  }
}

// Socket aktif saat ini (berganti setiap reconnect) — dipakai cron agar tidak memakai socket lama
let activeSock: WASocket | null = null;
let cronStarted = false;

// Cache pesan terkirim agar Baileys bisa resend otomatis saat penerima kirim retry receipt (atasi "Waiting for this message")
const sentMessages = new Map<string, proto.IMessage>();
const MAX_SENT_CACHE = 500;

function rememberSentMessage(key?: proto.IMessageKey | null, message?: proto.IMessage | null) {
  if (!key?.id || !message) return;
  if (sentMessages.size >= MAX_SENT_CACHE) {
    const oldestKey = sentMessages.keys().next().value;
    if (oldestKey) sentMessages.delete(oldestKey);
  }
  sentMessages.set(key.id, message);
}

// Bypass userDevicesCache agar device:0 dari grup & chat pribadi tidak saling menimpa di Baileys 6.7.24
const noOpDevicesCache: CacheStore = {
  get: () => undefined,
  set: () => {},
  del: () => {},
  flushAll: () => {},
};

async function startBot() {
  const authDir = process.env.AUTH_DIR
    ? path.resolve(process.env.AUTH_DIR)
    : path.resolve(process.cwd(), 'auth_info_baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const silentLogger = pino({ level: 'silent' });
  let sockRef: WASocket | null = null;
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    logger: silentLogger,
    printQRInTerminal: false,
    userDevicesCache: noOpDevicesCache,
    getMessage: async (key) => {
      const msg = key.id ? sentMessages.get(key.id) : undefined;
      if (msg) {
        console.log(`🔁 [RETRY] Mengirim ulang pesan ${key.id} untuk ${key.remoteJid}`);
      }
      return msg;
    },
    cachedGroupMetadata: async (jid) => {
      if (!sockRef) return undefined;
      try {
        const meta = await sockRef.groupMetadata(jid);
        return {
          ...meta,
          participants: meta.participants.filter((p) => !isBotJid(sockRef!, p.id)),
        };
      } catch {
        return undefined;
      }
    },
  });
  sockRef = sock;
  activeSock = sock;

  // Simpan setiap pesan yang dikirim bot ke cache untuk kebutuhan retry
  const origSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, options) => {
    const fullMsg = await origSendMessage(jid, content, options);
    if (fullMsg) {
      rememberSentMessage(fullMsg.key, fullMsg.message);
    }
    return fullMsg;
  };

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n======================================================');
      console.log('📌 SCAN QR CODE BERIKUT DENGAN WHATSAPP ANDA:');
      console.log('======================================================\n');
      qrcode.generate(qr, { small: true });

      // Link instan agar bisa dibuka langsung di browser jika tampilan log terminal patah/terpotong
      const qrScannerUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(qr)}`;
      console.log('\n🔗 [LINK GAMBAR QR JELAS]:');
      console.log(qrScannerUrl);
      console.log('(Buka link di atas di browser untuk scan QR gambar yang mulus)\n');
    }

    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus. Mencoba reconnect:', shouldReconnect);
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      console.log('\n✅ WHATSAPP BOT "AIRA" BERHASIL TERHUBUNG!\n');
      console.log(`🤖 Nomor bot: ${bareNumber(sock.user?.id)} | Grup mess: ${config.waMessGroupJid || '(belum ada — masukkan bot ke grup)'}`);

      // Cron cukup didaftarkan sekali; cron selalu memakai socket aktif terbaru
      if (!cronStarted) {
        cronStarted = true;
        setupCronJobs(() => activeSock as WASocket);
        startFinanceWatcher(() => activeSock);
      }

      // Petakan LID semua nomor terdaftar sejak awal agar chat pribadi langsung dikenali
      refreshRegisteredLids(sock, true).catch(() => {});
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Kumpulkan pemetaan LID <-> nomor HP dari event yang dikirim WhatsApp
  sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => rememberLidPn(lid, jid));
  const onContacts = (contacts: Partial<{ id: string; lid?: string; jid?: string }>[]) => {
    for (const c of contacts) {
      rememberLidPn(c.lid, c.jid);
      rememberLidPn(c.id, c.jid);
      rememberLidPn(c.id, c.lid);
    }
  };
  sock.ev.on('contacts.upsert', onContacts);
  sock.ev.on('contacts.update', onContacts);

  // Bot dimasukkan ke grup baru -> otomatis daftarkan JID grup
  sock.ev.on('groups.upsert', async (groups) => {
    for (const g of groups) {
      await registerGroup(sock, g.id, 'groups.upsert');
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { id: groupJid, participants, action } = update;
      // Hanya bereaksi jika yang ditambahkan adalah bot itu sendiri
      if (action === 'add' && participants.some((p) => isBotJid(sock, p))) {
        await registerGroup(sock, groupJid, 'group-participants.update');
      }
    } catch (err) {
      console.error('Error handling group-participants.update:', err);
    }
  });

  // Message Handler
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      rememberSentMessage(msg.key, msg.message);
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid === 'status@broadcast') continue;

      const isGroup = remoteJid.endsWith('@g.us');

      // Jika grup mess belum pernah terdaftar, pakai grup pertama yang mengirim pesan
      if (isGroup && !config.waMessGroupJid) {
        config.updateGroupJid(remoteJid);
      }

      const { jid: senderJid, phone: senderPhone } = await resolveSenderPhone(msg, sock);
      const user = await findUserByPhone(senderPhone, senderJid);

      // Identity Verification: Reject unregistered numbers
      if (!user) {
        // Di grup: diam saja. Di chat pribadi: beri tahu belum terdaftar.
        if (!isGroup) {
          await sock.sendMessage(remoteJid, {
            text:
              'Halo! Nomor Anda belum terdaftar di sistem MessTrack. Silakan hubungi Admin.' +
              (senderPhone ? `\n\nNomor terdeteksi: ${senderPhone}` : ''),
          });
        }
        continue;
      }

      // Extract caption or text
      const textMessage =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      const isImage = Boolean(msg.message.imageMessage);

      // 1. Task Reporting Logic via Hashtags (#sampah, #sapu, #pel, #wc, #galon)
      const hashtags = textMessage.match(/#(sampah|sapu|pel|wc|galon)\b/gi);
      if (hashtags && hashtags.length > 0) {
        const rawTask = hashtags[0].replace('#', '').toLowerCase();
        let verificationResult = { isValid: true, explanation: 'Tugas dicatat.' };

        if (isImage) {
          try {
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              {
                logger: pino({ level: 'silent' }),
                reuploadRequest: sock.updateMediaMessage,
              }
            );
            const mimeType = msg.message.imageMessage?.mimetype || 'image/jpeg';
            verificationResult = await verifyTaskPhoto(buffer as Buffer, mimeType, rawTask);
          } catch (e) {
            console.error('Failed to download media for verification:', e);
          }
        }

        if (verificationResult.isValid) {
          const today = new Date().toISOString().split('T')[0];
          if (config.isConfigured()) {
            await supabase.from('task_logs').insert({
              user_id: user.id,
              task_date: today,
              task_type: rawTask,
              proof_url: null, // As clarified, photos are analyzed real-time and not stored
              verified_at: new Date().toISOString(),
            });
          }

          const replyText =
            `✅ *TUGAS TERVERIFIKASI & TERCATAT!*\n\n` +
            `👤 *Penghuni:* ${user.name}\n` +
            `🧹 *Tugas:* #${rawTask}\n` +
            `📅 *Tanggal:* ${new Date().toLocaleDateString('id-ID')}\n` +
            `🤖 *Catatan Aira:* ${verificationResult.explanation}\n\n` +
            `Terima kasih sudah menjaga kebersihan mess hari ini! 🌟`;

          await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
        } else {
          const rejectText =
            `⚠️ *VERIFIKASI TUGAS DITOLAK*\n\n` +
            `Halo kak ${user.name}, foto yang Anda kirimkan untuk tugas #${rawTask} tidak sesuai kriteria.\n` +
            `Alasan: ${verificationResult.explanation}\n\n` +
            `Silakan kirimkan kembali foto bukti yang sesuai ya!`;

          await sock.sendMessage(remoteJid, { text: rejectText }, { quoted: msg });
        }
        continue;
      }

      // =========================================================================
      // 2. Finance Module: OCR Billing (#bayarkas)
      // =========================================================================
      if (textMessage.toLowerCase().includes('#bayarkas')) {
        if (!isImage) {
          await sock.sendMessage(
            remoteJid,
            {
              text: '⚠️ Untuk konfirmasi pembayaran kas, silakan kirimkan *foto bukti transfer* dengan caption *#bayarkas*.',
            },
            { quoted: msg }
          );
          continue;
        }

        try {
          const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            {
              logger: pino({ level: 'silent' }),
              reuploadRequest: sock.updateMediaMessage,
            }
          );
          const mimeType = msg.message.imageMessage?.mimetype || 'image/jpeg';
          const ocrResult = await scanReceiptAmount(buffer as Buffer, mimeType);

          const now = new Date();
          const currentMonth = now.getMonth() + 1;
          const currentYear = now.getFullYear();

          if (!ocrResult.success || ocrResult.amount === null) {
            await sock.sendMessage(
              remoteJid,
              {
                text: `⚠️ *BUKTI TIDAK TERBACA*\n\nAira tidak dapat mendeteksi nominal transfer pada gambar yang dikirimkan. Pastikan foto struk/bukti transfer jelas dan tidak terpotong, lalu ulangi dengan caption *#bayarkas*.`,
              },
              { quoted: msg }
            );
            continue;
          }

          const detectedAmount = ocrResult.amount;

          // Strict Logic: If amount == Rp 65.000 -> Log as 'income' in DB, mark arrears paid
          if (detectedAmount === 65000) {
            if (config.isConfigured()) {
              // 1. Insert into finance_transactions
              await supabase.from('finance_transactions').insert({
                user_id: user.id,
                type: 'income',
                amount: 65000,
                description: `Bayar Kas & WiFi Bln ${currentMonth}/${currentYear} (${user.name})`,
                created_at: new Date().toISOString(),
              });

              // 2. Mark arrears for this month as paid
              await supabase
                .from('arrears')
                .update({ is_paid: true })
                .eq('user_id', user.id)
                .eq('type', 'kas_wifi')
                .eq('month', currentMonth)
                .eq('year', currentYear);
            }

            const successText =
              `✅ *PEMBAYARAN KAS & WIFI DITERIMA & LUNAS!*\n\n` +
              `👤 *Penghuni:* ${user.name}\n` +
              `💰 *Nominal Terbaca:* Rp 65.000 (Kas 50k + WiFi 15k)\n` +
              `📅 *Periode:* Bulan ${currentMonth} / ${currentYear}\n` +
              `🤖 *Status OCR:* Terverifikasi Otomatis oleh Gemini AI\n\n` +
              `Terima kasih kak ${user.name}! Status tunggakan Anda di dashboard sudah diperbarui menjadi LUNAS. 🌟`;

            await sock.sendMessage(remoteJid, { text: successText }, { quoted: msg });
          } else {
            // Strict Logic: If amount != Rp 65.000 -> DO NOT save to DB yet.
            const formattedDetected = new Intl.NumberFormat('id-ID', {
              style: 'currency',
              currency: 'IDR',
              maximumFractionDigits: 0,
            }).format(detectedAmount);

            const mismatchText =
              `⚠️ *NOMINAL TIDAK SESUAI*\n\n` +
              `Nominal terbaca: *${formattedDetected}*.\n` +
              `Tagihan seharusnya *Rp 65.000* (Kas 50k + WiFi 15k).\n\n` +
              `Tolong konfirmasi apakah ini bayar sebagian, atau ulangi kirim bukti yang benar dengan caption *#bayarkas*.`;

            await sock.sendMessage(remoteJid, { text: mismatchText }, { quoted: msg });
          }
        } catch (err) {
          console.error('Error handling #bayarkas:', err);
          await sock.sendMessage(
            remoteJid,
            { text: '⚠️ Terjadi kendala teknis saat memproses bukti transfer. Silakan hubungi Admin.' },
            { quoted: msg }
          );
        }
        continue;
      }

      // =========================================================================
      // 3. Finance Module: Expense Tracking (#pengeluaran [Nama Barang] [Nominal])
      // =========================================================================
      if (textMessage.startsWith('#pengeluaran')) {
        // Regex strictly matching: #pengeluaran [Nama Barang] [Nominal angka saja]
        const match = textMessage.match(/^#pengeluaran\s+(.+?)\s+(\d+)$/i);

        if (!match) {
          const errorHelpText =
            `⚠️ *FORMAT PENGELUARAN SALAH*\n\n` +
            `Gunakan format nominal angka saja tanpa huruf (rb/k) atau titik/koma.\n\n` +
            `👉 *Format yang benar:*\n` +
            `\`#pengeluaran [Nama Barang] [Nominal angka saja]\`\n\n` +
            `Contoh:\n` +
            `\`#pengeluaran Beli Galon 20000\`\n` +
            `\`#pengeluaran Refill Gas Elpiji 22000\``;

          await sock.sendMessage(remoteJid, { text: errorHelpText }, { quoted: msg });
          continue;
        }

        const itemName = match[1].trim();
        const amount = parseInt(match[2], 10);

        if (isNaN(amount) || amount <= 0) {
          await sock.sendMessage(
            remoteJid,
            { text: '⚠️ Nominal pengeluaran harus berupa angka lebih besar dari 0.' },
            { quoted: msg }
          );
          continue;
        }

        let newBalance = 0;
        if (config.isConfigured()) {
          // Log to finance_transactions
          await supabase.from('finance_transactions').insert({
            user_id: user.id,
            type: 'expense',
            amount: amount,
            description: `${itemName} (oleh ${user.name})`,
            created_at: new Date().toISOString(),
          });

          // Calculate current balance
          const { data: allTxs } = await supabase
            .from('finance_transactions')
            .select('type, amount');

          if (allTxs) {
            const inc = allTxs
              .filter((t) => t.type === 'income' || t.type === 'fine_payment')
              .reduce((sum, t) => sum + Number(t.amount), 0);
            const exp = allTxs
              .filter((t) => t.type === 'expense')
              .reduce((sum, t) => sum + Number(t.amount), 0);
            newBalance = inc - exp;
          }
        }

        const formattedAmount = new Intl.NumberFormat('id-ID', {
          style: 'currency',
          currency: 'IDR',
          maximumFractionDigits: 0,
        }).format(amount);

        const formattedBalance = new Intl.NumberFormat('id-ID', {
          style: 'currency',
          currency: 'IDR',
          maximumFractionDigits: 0,
        }).format(newBalance);

        const successText =
          `💸 *PENGELUARAN DICATAT*\n\n` +
          `📦 *Keperluan:* ${itemName}\n` +
          `💰 *Nominal:* ${formattedAmount}\n` +
          `👤 *Dicatat oleh:* ${user.name}\n\n` +
          `Pengeluaran dicatat. Sisa saldo Kas Mess saat ini: *${formattedBalance}*.\n\n` +
          `_(Tip: Jika terjadi salah nominal, balas pesan ini dengan \`#koreksi [Nominal Baru]\`)_`;

        await sock.sendMessage(remoteJid, { text: successText }, { quoted: msg });
        continue;
      }

      // =========================================================================
      // 4. Finance Module: Typo Correction (#koreksi [New Nominal])
      // =========================================================================
      if (textMessage.startsWith('#koreksi')) {
        const match = textMessage.match(/^#koreksi\s+(\d+)$/i);
        if (!match) {
          await sock.sendMessage(
            remoteJid,
            {
              text: '⚠️ Format koreksi salah! Balas pesan pengeluaran dengan format:\n`#koreksi [Nominal angka saja]`\nContoh: `#koreksi 25000`',
            },
            { quoted: msg }
          );
          continue;
        }

        const newAmount = parseInt(match[1], 10);
        if (isNaN(newAmount) || newAmount <= 0) {
          await sock.sendMessage(
            remoteJid,
            { text: '⚠️ Nominal baru harus berupa angka positif.' },
            { quoted: msg }
          );
          continue;
        }

        // Check if message is a quoted reply
        const contextInfo = msg.message.extendedTextMessage?.contextInfo;
        const quotedText =
          contextInfo?.quotedMessage?.conversation ||
          contextInfo?.quotedMessage?.extendedTextMessage?.text ||
          '';

        // Check if the quoted message is an expense report
        if (!quotedText.includes('PENGELUARAN DICATAT')) {
          await sock.sendMessage(
            remoteJid,
            {
              text: '⚠️ Mohon balas (reply/quote) langsung pada pesan pengeluaran yang ingin dikoreksi.',
            },
            { quoted: msg }
          );
          continue;
        }

        // Fetch latest expense by user or admin
        if (config.isConfigured()) {
          const { data: latestExpense } = await supabase
            .from('finance_transactions')
            .select('*')
            .eq('type', 'expense')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

          if (!latestExpense) {
            await sock.sendMessage(
              remoteJid,
              { text: '⚠️ Data transaksi pengeluaran tidak ditemukan di database.' },
              { quoted: msg }
            );
            continue;
          }

          // Strict Authorization: Sender must be original author OR Admin
          const isAuthor = latestExpense.user_id === user.id;
          const isAdmin = user.role === 'admin';

          if (!isAuthor && !isAdmin) {
            await sock.sendMessage(
              remoteJid,
              {
                text: '⛔ Anda tidak memiliki hak akses untuk mengoreksi pengeluaran ini. Hanya pencatat awal atau Admin Mess yang diizinkan.',
              },
              { quoted: msg }
            );
            continue;
          }

          // Update transaction amount
          await supabase
            .from('finance_transactions')
            .update({ amount: newAmount })
            .eq('id', latestExpense.id);

          // Recalculate balance
          const { data: allTxs } = await supabase
            .from('finance_transactions')
            .select('type, amount');

          let newBalance = 0;
          if (allTxs) {
            const inc = allTxs
              .filter((t) => t.type === 'income' || t.type === 'fine_payment')
              .reduce((sum, t) => sum + Number(t.amount), 0);
            const exp = allTxs
              .filter((t) => t.type === 'expense')
              .reduce((sum, t) => sum + Number(t.amount), 0);
            newBalance = inc - exp;
          }

          const formattedNewAmount = new Intl.NumberFormat('id-ID', {
            style: 'currency',
            currency: 'IDR',
            maximumFractionDigits: 0,
          }).format(newAmount);

          const formattedBalance = new Intl.NumberFormat('id-ID', {
            style: 'currency',
            currency: 'IDR',
            maximumFractionDigits: 0,
          }).format(newBalance);

          const correctionSuccess =
            `✏️ *KOREKSI PENGELUARAN BERHASIL*\n\n` +
            `Nominal pengeluaran telah diperbarui menjadi *${formattedNewAmount}*.\n` +
            `Sisa saldo Kas Mess saat ini: *${formattedBalance}*.\n\n` +
            `Diverifikasi oleh: ${user.name} (${isAdmin ? 'Admin' : 'Pencatat'})`;

          await sock.sendMessage(remoteJid, { text: correctionSuccess }, { quoted: msg });
          continue;
        }
      }

      // =========================================================================
      // 5. Finance Module: Admin Excel Export via WhatsApp Attachment
      // =========================================================================
      const isExcelExportIntent =
        textMessage.toLowerCase().includes('rekap excel') ||
        textMessage.toLowerCase().includes('export excel') ||
        textMessage.toLowerCase().includes('laporan excel');

      if (isExcelExportIntent) {
        if (user.role !== 'admin') {
          await sock.sendMessage(
            remoteJid,
            { text: '⛔ Fitur ekspor laporan Excel ini khusus untuk Admin Mess.' },
            { quoted: msg }
          );
          continue;
        }

        await sock.sendMessage(
          remoteJid,
          { text: '⏳ Sedang menyiapkan dan membuat file Excel laporan keuangan multi-sheet... Mohon tunggu sebentar.' },
          { quoted: msg }
        );

        try {
          const excelBuffer = await generateFinanceExcelBuffer();
          const todayDate = new Date().toISOString().split('T')[0];
          const fileName = `Laporan_Keuangan_MessTrack_${todayDate}.xlsx`;

          await sock.sendMessage(
            remoteJid,
            {
              document: excelBuffer,
              mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              fileName: fileName,
              caption: `📊 *Laporan Keuangan MessTrack (${todayDate})*\nLampiran multi-sheet: Pemasukan Kas, Pengeluaran, & Rekap Denda/Tunggakan.`,
            },
            { quoted: msg }
          );
        } catch (err) {
          console.error('Failed to generate Excel for WhatsApp:', err);
          await sock.sendMessage(
            remoteJid,
            { text: '⚠️ Gagal membuat file Excel. Silakan periksa koneksi Supabase.' },
            { quoted: msg }
          );
        }
        continue;
      }

      // 5b. Admin Command: #konflik [deskripsi] -> Aira menjadi mediator
      if (textMessage.toLowerCase().startsWith('#konflik')) {
        if (user.role !== 'admin') {
          await sock.sendMessage(
            remoteJid,
            { text: '⛔ Perintah #konflik hanya dapat dijalankan oleh Admin Mess.' },
            { quoted: msg }
          );
          continue;
        }

        const caseText = textMessage.replace(/^#konflik/i, '').trim();
        const quotedCtx = msg.message.extendedTextMessage?.contextInfo;
        const quotedText =
          quotedCtx?.quotedMessage?.conversation ||
          quotedCtx?.quotedMessage?.extendedTextMessage?.text ||
          '';
        const fullCase = [caseText, quotedText && `Pesan yang dibalas: "${quotedText}"`]
          .filter(Boolean)
          .join('\n');

        await sock.sendMessage(
          remoteJid,
          { text: '⚖️ Aira masuk mode mediator. Sedang menganalisis konflik dengan data mess...' },
          { quoted: msg }
        );
        console.log(`⚖️ [KONFLIK] Dipanggil oleh admin ${user.name}: "${fullCase}"`);
        const mediation = await askAira(
          fullCase || 'Admin memanggil mediasi tanpa menjelaskan kasus. Minta penjelasan kasusnya.',
          user.name,
          'conflict'
        );
        await sock.sendMessage(remoteJid, { text: `⚖️ *MEDIASI KONFLIK — AIRA*\n\n${mediation}` }, { quoted: msg });
        continue;
      }

      // 6. Admin Command: #tukar @Nama
      if (textMessage.startsWith('#tukar')) {
        if (user.role !== 'admin') {
          await sock.sendMessage(
            remoteJid,
            { text: '⚠️ Perintah tukar jadwal hanya dapat dijalankan oleh Admin Mess.' },
            { quoted: msg }
          );
          continue;
        }

        await sock.sendMessage(
          remoteJid,
          {
            text: `Perintah tukar jadwal diterima oleh Admin ${user.name}. Perubahan jadwal dapat juga dikelola langsung via Admin Panel (/dashboard).`,
          },
          { quoted: msg }
        );
        continue;
      }

      // =========================================================================
      // 7. Percakapan / Tanya Jawab (AI Aira)
      // Aturan:
      // - Di Chat Pribadi: Selalu dibalas langsung oleh Aira.
      // - Di Grup WA: Wajib men-tag nomor bot (atau membalas pesan bot / ketik @aira).
      // =========================================================================
      const ctx =
        msg.message.extendedTextMessage?.contextInfo ||
        msg.message.imageMessage?.contextInfo ||
        undefined;
      const mentionsBot =
        Boolean(ctx?.mentionedJid?.some((j) => isBotJid(sock, j))) ||
        isBotJid(sock, ctx?.participant) || // membalas (reply) pesan bot
        textMessage.toLowerCase().includes('@aira');

      // Jika di grup tapi tidak mention Aira, jangan balas (agar grup tidak berisik)
      if (isGroup && !mentionsBot) {
        continue;
      }

      if (textMessage.trim().length > 0) {
        console.log(`🤖 [AIRA RESPONSE] Memproses chat dari ${user.name} [${user.role}] (${isGroup ? 'Grup' : 'Pribadi'}): "${textMessage}"`);
        // Hapus tag @nomorbot / @aira dari teks pertanyaan
        const cleanQuery =
          textMessage.replace(/@aira/gi, '').replace(/@\d{6,}/g, '').trim() || 'Halo';
        const aiResponse = await askAira(cleanQuery, user.name, 'chat', user.id || senderPhone);
        await sock.sendMessage(remoteJid, { text: aiResponse }, { quoted: msg });
      }
    }
  });
}

startBot().catch((err) => {
  console.error('Fatal error starting Aira WhatsApp bot:', err);
});

