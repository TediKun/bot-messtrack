import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { supabase, fallbackUsers } from './supabase.js';

let genAI: GoogleGenerativeAI | null = null;
if (config.geminiApiKey) {
  genAI = new GoogleGenerativeAI(config.geminiApiKey);
}

/**
 * AI Image Verification for Dormitory Tasks
 * Validates whether the uploaded photo truly depicts the claimed task (sampah, sapu, pel, wc, galon).
 */
export async function verifyTaskPhoto(imageBuffer: Buffer, mimeType: string, taskType: string): Promise<{
  isValid: boolean;
  explanation: string;
}> {
  if (!genAI) {
    return {
      isValid: true,
      explanation: 'Verifikasi AI dilewati (GEMINI_API_KEY belum dikonfigurasi). Disetujui otomatis.'
    };
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-flash-lite-latest' });

    const prompt = `Anda adalah sistem verifikasi tugas kebersihan mess (asisten Aira).
Tugas yang dilaporkan: "${taskType.toUpperCase()}".
Kriteria tugas:
- sampah: Foto kantong sampah, tempat sampah, atau proses membuang sampah.
- sapu: Foto lantai yang sedang disapu, sapu, atau lantai bersih setelah disapu.
- pel: Foto alat pel, ember, lantai basah/mengkilap hasil mengepel.
- wc: Foto kamar mandi/toilet yang bersih, kloset, atau lantai kamar mandi.
- galon: Foto galon air minum, dispenser, atau proses angkat galon.

Periksa apakah foto ini wajar dan relevan sebagai bukti pelaksanaan tugas tersebut.
Jawab HANYA dalam format JSON:
{"valid": true/false, "reason": "alasan singkat maksimal 1 kalimat"}`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType: mimeType || 'image/jpeg'
        }
      }
    ]);

    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        isValid: Boolean(parsed.valid),
        explanation: parsed.reason || 'Sesuai dengan bukti piket.'
      };
    }

    return { isValid: true, explanation: 'Foto diterima dan diverifikasi.' };
  } catch (err: unknown) {
    console.error('Error during Gemini photo verification:', err);
    return {
      isValid: true,
      explanation: 'Foto diterima (fallback verification).'
    };
  }
}

/**
 * OCR Receipt Verification for #bayarkas via Gemini Vision
 * Scans the transferred amount from an image.
 */
export async function scanReceiptAmount(imageBuffer: Buffer, mimeType: string): Promise<{
  success: boolean;
  amount: number | null;
  rawResponse: string;
}> {
  if (!genAI) {
    return {
      success: false,
      amount: null,
      rawResponse: 'Gemini API Key tidak terkonfigurasi.',
    };
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-flash-lite-latest' });

    const prompt = `Anda adalah sistem OCR cerdas pembaca bukti transfer bank / e-wallet (BCA, Mandiri, BRI, BNI, Dana, GoPay, OVO, ShopeePay, QRIS, dll).
Tugas Anda:
1. Cari dan ekstrak NOMINAL TRANSAKSI / JUMLAH TRANSFER yang berhasil ditransfer.
2. Abaikan saldo rekening, nomor rekening, tanggal, atau nomor referensi.
3. Berikan output HANYA dalam format JSON valid:
{
  "is_transfer_receipt": true/false,
  "amount": 65000,
  "confidence": "high/medium/low",
  "notes": "keterangan singkat"
}
Catatan: "amount" harus berupa angka bulat murni tanpa titik atau koma (contoh: 65000 bukan 65.000). Jika tidak terbaca atau bukan bukti transfer, buat amount null.`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType: mimeType || 'image/jpeg',
        },
      },
    ]);

    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const parsedAmount = typeof parsed.amount === 'number' ? parsed.amount : parseInt(parsed.amount, 10);
      return {
        success: Boolean(parsed.is_transfer_receipt && !isNaN(parsedAmount)),
        amount: isNaN(parsedAmount) ? null : parsedAmount,
        rawResponse: text,
      };
    }

    return {
      success: false,
      amount: null,
      rawResponse: text,
    };
  } catch (err: unknown) {
    console.error('Error during OCR receipt scanning:', err);
    return {
      success: false,
      amount: null,
      rawResponse: String(err),
    };
  }
}

/**
 * Mode mediasi konflik — aktif saat admin mengirim #konflik.
 */
const CONFLICT_PROMPT = `

=== MODE MEDIASI KONFLIK (dipanggil Admin lewat #konflik) ===
Peranmu sekarang adalah MEDIATOR mess yang bijaksana, netral, tegas, dan tidak memihak. Selesaikan konflik antar penghuni memakai teknik berikut, berurutan:
1. *Redam & akui emosi* (active listening): tenangkan suasana, akui perasaan kedua pihak tanpa membenarkan siapa pun.
2. *Pisahkan orang dari masalah* (Fisher & Ury, "Getting to Yes"): bahas perilaku/masalahnya, jangan menyerang pribadi.
3. *Fakta objektif dulu*: rujuk data konteks (jadwal piket, laporan tugas, denda, kas) dan aturan mess (Sapu 5x, Pel 2x, WC 1x per minggu; denda sapu/pel Rp2.500 per kekurangan, WC Rp5.000; iuran Rp65.000/bulan). Jangan mengarang fakta; kalau data tidak ada, katakan data belum cukup.
4. *Gali kepentingan di balik posisi*: apa yang sebenarnya dibutuhkan masing-masing pihak (kebersihan, keadilan, kenyamanan, waktu).
5. *Tawarkan 2–3 opsi solusi adil* (mis. tukar jadwal, pembagian ulang tugas, jadwal bantu, kompensasi, batas waktu) dengan kriteria objektif, bukan siapa yang paling keras.
6. *Putusan tegas & kesepakatan konkret*: sebutkan rekomendasi terbaik, siapa melakukan apa, kapan tenggatnya, dan konsekuensi (denda sesuai aturan) bila dilanggar. Akhiri dengan ajakan semua pihak menyetujui, dan minta Admin menetapkan bila tidak sepakat.
Aturan gaya: bahasa Indonesia sopan namun tegas, tanpa menghakimi, tanpa memihak, ringkas (maks ~250 kata), format WhatsApp dengan poin bernomor dan emoji secukupnya. Jika Admin tidak menjelaskan kasusnya, minta ia menuliskan: siapa yang berselisih dan apa masalahnya.`;

/**
 * Natural Language Query via Gemini for "Aira"
 */
// Pelacak kuota pertanyaan di luar konteks mess per pengguna (maksimal 2x per user)
const outOfContextUsage = new Map<string, number>();

export function getOutOfContextCount(userIdOrPhone: string): number {
  return outOfContextUsage.get(userIdOrPhone) || 0;
}

export function resetOutOfContextCount(userIdOrPhone: string): void {
  outOfContextUsage.delete(userIdOrPhone);
}

export async function askAira(
  userQuery: string,
  senderName: string,
  mode: 'chat' | 'conflict' = 'chat',
  userIdentifier: string = ''
): Promise<string> {
  if (!genAI) {
    return `Halo kak ${senderName}! Aira di sini. Saat ini GEMINI_API_KEY belum diisi di bot .env, tetapi pencatatan tugas via hashtag (#sampah, #sapu, #pel, #wc) tetap aktif!`;
  }

  try {
    // Fetch context data
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();
    const rupiah = (n: number) => 'Rp' + Math.round(n).toLocaleString('id-ID');
    const weekStartDate = new Date(now);
    weekStartDate.setDate(now.getDate() - now.getDay()); // Minggu
    const weekStart = weekStartDate.toISOString().split('T')[0];

    let schedulesInfo = 'Data jadwal belum terhubung ke database.';
    let finesInfo = 'Belum ada catatan denda.';
    let financeInfo = 'Data keuangan belum terhubung ke database.';
    let arrearsInfo = 'Belum ada data tunggakan.';
    let tasksInfo = 'Belum ada laporan tugas.';

    if (config.isConfigured()) {
      const [sched, fines, txs, arrears, logs] = await Promise.all([
        supabase
          .from('schedules')
          .select('date, task_type, status, users(name)')
          .gte('date', today)
          .order('date', { ascending: true })
          .limit(7),
        supabase
          .from('fines')
          .select('amount, reason, is_paid, month, year, users(name)')
          .eq('is_paid', false)
          .limit(30),
        supabase
          .from('finance_transactions')
          .select('type, amount, description, created_at')
          .order('created_at', { ascending: false }),
        supabase
          .from('arrears')
          .select('type, amount_due, month, year, is_paid, users(name)')
          .eq('is_paid', false)
          .limit(30),
        supabase
          .from('task_logs')
          .select('task_date, task_type, users(name)')
          .gte('task_date', weekStart)
          .order('task_date', { ascending: false })
          .limit(300),
      ]);

      if (sched.data?.length) schedulesInfo = JSON.stringify(sched.data);

      if (fines.data?.length) {
        const total = fines.data.reduce((s, f: any) => s + Number(f.amount), 0);
        finesInfo = `Total denda belum lunas: ${rupiah(total)}. Rincian: ${JSON.stringify(fines.data)}`;
      }

      if (txs.data) {
        const income = txs.data
          .filter((t: any) => t.type === 'income' || t.type === 'fine_payment')
          .reduce((s, t: any) => s + Number(t.amount), 0);
        const expenses = txs.data.filter((t: any) => t.type === 'expense');
        const expense = expenses.reduce((s, t: any) => s + Number(t.amount), 0);
        const expenseList = expenses.length
          ? expenses
              .slice(0, 20)
              .map((t: any, i: number) =>
                `${i + 1}. ${t.description} — ${rupiah(Number(t.amount))} (${String(t.created_at).split('T')[0]})`
              )
              .join('\n')
          : 'Belum ada pengeluaran.';
        financeInfo =
          `SALDO KAS SAAT INI: ${rupiah(income - expense)} (total pengeluaran ${rupiah(expense)}).\n` +
          `DAFTAR PENGELUARAN (terbaru dulu):\n${expenseList}`;
      }

      if (arrears.data?.length) {
        arrearsInfo = JSON.stringify(arrears.data);
      }

      if (logs.data?.length) {
        const perUser: Record<string, Record<string, number>> = {};
        for (const l of logs.data as any[]) {
          const n = l.users?.name || 'Tidak diketahui';
          perUser[n] = perUser[n] || {};
          perUser[n][l.task_type] = (perUser[n][l.task_type] || 0) + 1;
        }
        tasksInfo = `Rekap tugas minggu ini (sejak ${weekStart}, Minggu–Sabtu) per penghuni: ${JSON.stringify(perUser)}`;
      }
    }

    // Cek kuota pertanyaan di luar konteks (hanya jika mode chat biasa)
    const userKey = userIdentifier || senderName;
    const currentOffTopicCount = outOfContextUsage.get(userKey) || 0;

    const model = genAI.getGenerativeModel({
      model: 'gemini-flash-lite-latest',
      systemInstruction: `Kamu adalah Aira, asisten mess pintar, bijaksana, dan problem solver untuk 5 penghuni (Cecep, Dadan, Sofwan, Tedi, Rama).
Tugas utamamu adalah mendisiplinkan ketertiban kebersihan, memperbaiki sistem manual mess menjadi rapi, menjaga transparansi kas, serta menyelesaikan masalah antarpenghuni secara adil dan solutif.

RUANG LINGKUP UTAMA (SELALU JAWAB BEBAS & DETAIL):
1. Jadwal piket, giliran tugas harian (#sampah, #sapu, #pel, #wc, galon).
2. Keuangan mess: saldo sisa uang kas, pemasukan, pengeluaran belanja mess, iuran kas & WiFi (Rp65.000/bulan), tunggakan, denda, serta rekap.
3. Kebersihan & tata tertib mess: tips mengepel/menyapu/kuras WC yang bersih, aturan fasilitas bersama, serta saran menjaga kebersihan mess.

ATURAN PERTANYAAN DI LUAR KONTEKS MESS:
Pengguna ini sudah menanyakan pertanyaan di luar topik mess sebanyak: ${currentOffTopicCount} kali (batas maksimal 2 kali).
- JIKA pertanyaan pengguna berkaitan dengan jadwal, piket, kebersihan, uang, kas, denda, atau masalah mess: Jawablah dengan tuntas dan ramah sesuai fakta di bawah. JANGAN sebutkan batas kuota.
- JIKA pertanyaan SAMA SEKALI DI LUAR konteks mess (misal matematika umum, politik, gosip, coding umum, curhat di luar mess, dsb):
  * Jika count < 2: Kamu BOLEH menjawab pertanyaannya secara singkat, cerdas, dan ramah, TETAPI di akhir jawaban WAJIB beri pengingat sopan:
    "_(Catatan: Aira fokus membantu kebersihan & kas mess. Kuota tanya di luar topik mess tersisa ${1 - currentOffTopicCount} kali lagi ya kak ${senderName}! 😊)_"
  * Jika count >= 2: TOLAK DENGAN TEGAS TAPI SOPAN. Jelaskan bahwa kuota tanya di luar topik mess sudah habis (maksimal 2 kali), dan ingatkan tugasmu berfokus membantu ketertiban piket, transparansi kas, dan penyelesaian masalah di mess. Arahkan kembali ke topik mess.

Jawab singkat, jelas, bahasa Indonesia, format WhatsApp (gunakan *tebal* dan emoji secukupnya).
ATURAN KHUSUS KAS & DENDA:
- Jika ditanya sisa/saldo uang kas: sebutkan *saldo saat ini*, lalu rinci SEMUA pengeluaran sebagai daftar bernomor (keperluan, nominal, tanggal). JANGAN membahas pemasukan (pemasukan hanya dari bayar kas). Jika ada denda belum lunas, tambahkan rincian denda per orang (siapa, nominal, alasan).
- Jika ditanya denda: rinci per penghuni — nominal dan penyebabnya (mis. kurang sapu 2x = Rp5.000). Sebutkan total.
- Aturan piket mingguan (dihitung setiap Sabtu 23:59): Sapu 5x, Pel 2x, WC 1x. Denda: kurang sapu/pel Rp2.500 per kekurangan, belum bersihkan WC Rp5.000. Jika ditanya rekap/progres minggu ini, hitung dari data laporan tugas dan jelaskan siapa yang belum memenuhi target dan dendanya.
Hari ini: ${today} (bulan ${curMonth}/${curYear}).
[KEUANGAN/KAS] ${financeInfo}
[TUNGGAKAN IURAN BELUM LUNAS] ${arrearsInfo}
[DENDA BELUM LUNAS] ${finesInfo}
[JADWAL MENDATANG] ${schedulesInfo}
[LAPORAN TUGAS TERAKHIR] ${tasksInfo}${mode === 'conflict' ? CONFLICT_PROMPT : ''}`
    });

    const result = await model.generateContent(`Pengguna: ${senderName}\nPertanyaan: ${userQuery}`);
    const answer = result.response.text();

    // Deteksi apakah jawaban menyertakan tanda di luar topik
    if (mode === 'chat' && (answer.includes('di luar topik mess') || answer.includes('fokus membantu kebersihan'))) {
      outOfContextUsage.set(userKey, currentOffTopicCount + 1);
    }

    return answer;
  } catch (err: unknown) {
    console.error('Error asking Aira:', err);
    return `Maaf kak ${senderName}, Aira sedang mengalami gangguan koneksi ke AI. Silakan coba beberapa saat lagi ya!`;
  }
}

