-- Chạy một lần trong Supabase: SQL Editor > New query > dán vào > Run

create table if not exists public.sentences (
  id uuid primary key default gen_random_uuid(),
  hanzi text not null,
  pinyin text not null default '',
  meaning text not null default '',
  topic text not null default 'Câu của tôi',
  created_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Bật RLS và không tạo policy nào: chỉ Worker (dùng khoá service_role) đọc ghi được.
alter table public.sentences enable row level security;
alter table public.app_settings enable row level security;

-- Kho lưu file âm thanh đã tạo, để mỗi câu chỉ tốn ký tự Azure/ElevenLabs một lần.
insert into storage.buckets (id, name, public)
values ('tts-cache', 'tts-cache', false)
on conflict (id) do nothing;
