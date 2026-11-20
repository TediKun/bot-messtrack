import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

export interface User {
  id: string;
  name: string;
  phone_number: string;
  role: 'user' | 'admin';
}

export interface Schedule {
  id: string;
  user_id: string;
  date: string;
  task_type: string[];
  status: 'pending' | 'completed';
}

export interface TaskLog {
  id: string;
  user_id: string;
  task_date: string;
  task_type: string;
  proof_url?: string | null;
  verified_at: string;
}

export interface Fine {
  id: string;
  user_id: string;
  month: number;
  year: number;
  amount: number;
  reason: string;
  is_paid: boolean;
}

export interface FinanceTransaction {
  id: string;
  user_id?: string | null;
  type: 'income' | 'expense' | 'fine_payment';
  amount: number;
  description: string;
  created_at: string;
}

export interface Arrear {
  id: string;
  user_id: string;
  type: 'kas_wifi' | 'denda';
  amount_due: number;
  month: number;
  year: number;
  is_paid: boolean;
  created_at: string;
}


// Fallback users if Supabase is still being initialized
export const fallbackUsers: User[] = [
  { id: '00000000-0000-0000-0000-000000000001', name: 'Cecep Supriatna', phone_number: '628120000001', role: 'user' },
  { id: '00000000-0000-0000-0000-000000000002', name: 'Dadan', phone_number: '628120000002', role: 'user' },
  { id: '00000000-0000-0000-0000-000000000003', name: 'Sofwan', phone_number: '628120000003', role: 'user' },
  { id: '00000000-0000-0000-0000-000000000004', name: 'Tedi Triadi', phone_number: '628120000004', role: 'admin' },
  { id: '00000000-0000-0000-0000-000000000005', name: 'Rama Cahya Maulana', phone_number: '628120000005', role: 'user' }
];

export const supabase = createClient(
  config.supabaseUrl || 'https://placeholder.supabase.co',
  config.supabaseServiceRoleKey || 'placeholder'
);

