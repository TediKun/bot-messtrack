import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const envFilePath = path.resolve(process.cwd(), '.env');

export const config = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  waMessGroupJid: process.env.WA_MESS_GROUP_JID || '',
  isConfigured() {
    return Boolean(
      this.supabaseUrl &&
      this.supabaseServiceRoleKey &&
      !this.supabaseUrl.includes('your-supabase-project')
    );
  },
  // Automatically update and persist group JID into .env and runtime config
  updateGroupJid(newJid: string) {
    if (!newJid || this.waMessGroupJid === newJid) return;
    this.waMessGroupJid = newJid;
    process.env.WA_MESS_GROUP_JID = newJid;

    try {
      if (fs.existsSync(envFilePath)) {
        let envContent = fs.readFileSync(envFilePath, 'utf-8');
        if (envContent.includes('WA_MESS_GROUP_JID=')) {
          envContent = envContent.replace(
            /WA_MESS_GROUP_JID=.*/g,
            `WA_MESS_GROUP_JID=${newJid}`
          );
        } else {
          envContent += `\nWA_MESS_GROUP_JID=${newJid}\n`;
        }
        fs.writeFileSync(envFilePath, envContent, 'utf-8');
        console.log(`💾 [AUTO-CONFIG] WA_MESS_GROUP_JID berhasil disimpan permanen ke .env: ${newJid}`);
      }
    } catch (err) {
      console.error('Gagal menulis WA_MESS_GROUP_JID ke .env:', err);
    }
  }
};

