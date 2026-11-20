import cron from 'node-cron';
import { WASocket } from '@whiskeysockets/baileys';
import { supabase, fallbackUsers } from './supabase.js';
import { config } from './config.js';

export function setupCronJobs(getSock: () => WASocket) {
  // Helper to dynamically get group JID (so if auto-detected runtime, it immediately applies)
  const getTargetGroupJid = () => config.waMessGroupJid;

  // 1. Morning Reminder (Daily at 06:30 AM)
  // Tags scheduled person specifically for "Buang Sampah"
  cron.schedule('30 6 * * *', async () => {
    console.log('[CRON] Running 06:30 AM Morning Reminder...');
    const targetGroupJid = getTargetGroupJid();
    if (!targetGroupJid) {
      console.warn('[CRON] WA_MESS_GROUP_JID is not configured. Skipping reminder broadcast.');
      return;
    }

    try {
      const today = new Date().toISOString().split('T')[0];
      let assignedUserName = 'Penghuni yang bertugas';
      let assignedPhone = '';

      if (config.isConfigured()) {
        const { data: schedule } = await supabase
          .from('schedules')
          .select('*, users(*)')
          .eq('date', today)
          .single();

        if (schedule && schedule.users) {
          assignedUserName = schedule.users.name;
          assignedPhone = schedule.users.phone_number;
        }
      }

      const mentionTag = assignedPhone ? `@${assignedPhone}` : assignedUserName;
      const message = `🌅 *PENGINGAT PAGI PIKET MESS* 🌅\n\n` +
        `Selamat pagi rekan-rekan mess! ☀️\n` +
        `Jadwal piket hari ini (${today}) adalah giliran:\n` +
        `👉 *${mentionTag}*\n\n` +
        `⚠️ *WAJIB:* Jangan lupa buang sampah pagi ini sebelum beraktivitas ya! Silakan kirim foto sampah ke grup dengan hashtag *#sampah* untuk verifikasi.\n\n` +
        `Semangat menjaga kebersihan mess kita! 💪✨`;

      await getSock().sendMessage(targetGroupJid, {
        text: message,
        mentions: assignedPhone ? [`${assignedPhone}@s.whatsapp.net`] : []
      });

      console.log('[CRON] Morning reminder sent successfully.');
    } catch (err: unknown) {
      console.error('[CRON] Failed to send morning reminder:', err);
    }
  });

  // 2. Weekly Penalty Calculation (Every Saturday at 23:59)
  // Cut-Off: Sapu: 5x, Pel: 2x, WC: 1x, Sampah: per hari mangkir
  cron.schedule('59 23 * * 6', async () => {
    console.log('[CRON] Running Saturday 23:59 Weekly Penalty Cut-off Calculation...');
    if (!config.isConfigured()) {
      console.warn('[CRON] Supabase not connected. Skipping weekly fine insert.');
      return;
    }

    try {
      const now = new Date();
      // Calculate start of current week (Sunday) to Saturday
      const saturdayDate = now.toISOString().split('T')[0];
      const sunday = new Date(now);
      sunday.setDate(now.getDate() - 6);
      const sundayDate = sunday.toISOString().split('T')[0];

      // Get schedules for this week
      const { data: weekSchedules } = await supabase
        .from('schedules')
        .select('*')
        .gte('date', sundayDate)
        .lte('date', saturdayDate);

      // Get unique users scheduled this week
      const userIds = Array.from(new Set(weekSchedules?.map(s => s.user_id) || []));
      const recapLines: string[] = [];

      for (const userId of userIds) {
        // Count actual completed tasks this week
        const { data: logs } = await supabase
          .from('task_logs')
          .select('task_type')
          .eq('user_id', userId)
          .gte('task_date', sundayDate)
          .lte('task_date', saturdayDate);

        const counts: Record<string, number> = { sapu: 0, pel: 0, wc: 0, sampah: 0 };
        logs?.forEach(l => {
          if (counts[l.task_type] !== undefined) {
            counts[l.task_type]++;
          }
        });

        // Targets: Sapu: 5x, Pel: 2x, WC: 1x, Sampah: 7x (daily)
        let penaltyAmount = 0;
        const reasons: string[] = [];

        if (counts.sapu < 5) {
          const missed = 5 - counts.sapu;
          const cost = missed * 2500;
          penaltyAmount += cost;
          reasons.push(`Kurang sapu ${missed}x (Rp${cost.toLocaleString('id-ID')})`);
        }

        if (counts.pel < 2) {
          const missed = 2 - counts.pel;
          const cost = missed * 2500;
          penaltyAmount += cost;
          reasons.push(`Kurang ngepel ${missed}x (Rp${cost.toLocaleString('id-ID')})`);
        }

        if (counts.wc < 1) {
          penaltyAmount += 5000;
          reasons.push(`Belum bersihkan WC (Rp5.000)`);
        }

        if (penaltyAmount > 0) {
          // Insert fine into fines table
          await supabase.from('fines').insert({
            user_id: userId,
            month: now.getMonth() + 1,
            year: now.getFullYear(),
            amount: penaltyAmount,
            reason: `Evaluasi Mingguan (${sundayDate} s/d ${saturdayDate}): ${reasons.join(', ')}`,
            is_paid: false
          });
        }

        // Susun rekap per penghuni untuk dikirim ke grup
        const { data: u } = await supabase.from('users').select('name').eq('id', userId).single();
        const name = u?.name || 'Penghuni';
        const status = (done: number, target: number) => `${done}/${target} ${done >= target ? '✅' : '❌'}`;
        let line =
          `👤 *${name}*\n` +
          `   🧹 Sapu: ${status(counts.sapu, 5)} | 🪣 Pel: ${status(counts.pel, 2)} | 🚽 WC: ${status(counts.wc, 1)} | 🗑️ Sampah: ${counts.sampah}x\n`;
        if (penaltyAmount > 0) {
          line += `   ⚠️ *Denda Rp${penaltyAmount.toLocaleString('id-ID')}* — ${reasons.join(', ')}`;
        } else {
          line += `   🎉 Semua target terpenuhi, tidak ada denda.`;
        }
        recapLines.push(line);
      }

      // Kirim rekap mingguan ke grup mess
      const recapGroup = getTargetGroupJid();
      if (recapGroup && recapLines.length > 0) {
        const text =
          `📊 *REKAP PIKET MINGGUAN* 📊\n` +
          `Periode: ${sundayDate} s/d ${saturdayDate}\n` +
          `Target: Sapu 5x, Pel 2x, WC 1x per minggu\n\n` +
          recapLines.join('\n\n') +
          `\n\n_Denda dicatat otomatis. Cek detail di dashboard atau tanya Aira._`;
        await getSock().sendMessage(recapGroup, { text });
        console.log('[CRON] Weekly recap broadcast sent.');
      }

      console.log('[CRON] Weekly penalty calculation finished.');
    } catch (err: unknown) {
      console.error('[CRON] Error during weekly penalty calculation:', err);
    }
  });

  // 3. Automated Billing & Arrears Reminder (Every 10th of the month at 08:00 AM)
  // Section 4.4 PRD V3: Check if users have paid Rp 65.000 for current month.
  // If not, insert/ensure arrears record, broadcast tag in WA group.
  cron.schedule('0 8 10 * *', async () => {
    console.log('[CRON] Running 10th of Month Automated Billing & Arrears Reminder...');
    if (!config.isConfigured()) {
      console.warn('[CRON] Supabase not connected. Skipping 10th billing cron.');
      return;
    }

    try {
      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();

      const { data: allUsers } = await supabase.from('users').select('*');
      if (!allUsers || allUsers.length === 0) return;

      const unpaidUsers: { name: string; phone: string }[] = [];

      for (const u of allUsers) {
        // Check if user already has an arrear entry for this month
        const { data: existingArrear } = await supabase
          .from('arrears')
          .select('*')
          .eq('user_id', u.id)
          .eq('type', 'kas_wifi')
          .eq('month', currentMonth)
          .eq('year', currentYear)
          .single();

        if (!existingArrear) {
          // Insert new arrear record
          await supabase.from('arrears').insert({
            user_id: u.id,
            type: 'kas_wifi',
            amount_due: 65000,
            month: currentMonth,
            year: currentYear,
            is_paid: false,
          });
          unpaidUsers.push({ name: u.name, phone: u.phone_number });
        } else if (!existingArrear.is_paid) {
          unpaidUsers.push({ name: u.name, phone: u.phone_number });
        }
      }

      // Action: Broadcast to WA group tagging unpaid users
      const targetGroupJid = getTargetGroupJid();
      if (targetGroupJid && unpaidUsers.length > 0) {
        const monthNames = [
          'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
          'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
        ];
        const monthLabel = monthNames[currentMonth - 1] || `${currentMonth}`;

        const tagsList = unpaidUsers
          .map((u, i) => `${i + 1}. @${u.phone} (${u.name}) - Rp 65.000`)
          .join('\n');

        const message =
          `📢 *PERINGATAN TANGGAL 10: IURAN KAS & WIFI MESS* 📢\n\n` +
          `Halo rekan-rekan mess! Hari ini sudah tanggal 10 ${monthLabel} ${currentYear}.\n` +
          `Berikut adalah daftar penghuni yang *belum membayar uang kas & WiFi* (Rp 65.000):\n\n` +
          `${tagsList}\n\n` +
          `💳 *Rincian:* Kas Mess Rp 50.000 + WiFi Rp 15.000 = *Rp 65.000*\n` +
          `📸 *Cara Konfirmasi:* Kirimkan foto bukti transfer ke grup ini dengan caption *#bayarkas* agar Aira verifikasi otomatis via OCR.\n\n` +
          `Terima kasih atas kerja samanya! 🙏✨`;

        const mentions = unpaidUsers.map((u) => `${u.phone}@s.whatsapp.net`);

        await getSock().sendMessage(targetGroupJid, {
          text: message,
          mentions: mentions,
        });

        console.log('[CRON] 10th monthly billing broadcast sent successfully.');
      }
    } catch (err: unknown) {
      console.error('[CRON] Error during 10th monthly billing:', err);
    }
  });
}


