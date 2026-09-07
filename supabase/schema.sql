-- Zeno Wallet storage.
-- Run this once in the Supabase SQL editor for the project used by Zeno.

create table if not exists public.wallet (
  user_id bigint primary key,
  earn_balance bigint not null default 0 check (earn_balance >= 0),
  zeno_balance bigint not null default 0 check (zeno_balance >= 0),
  updated_at timestamptz not null default now(),
  daily_claimed_at timestamptz,
  referred_by bigint,
  referral_rewarded boolean not null default false
);

alter table public.wallet
  add column if not exists daily_claimed_at timestamptz,
  add column if not exists referred_by bigint,
  add column if not exists referral_rewarded boolean not null default false;

create index if not exists wallet_updated_at_idx
  on public.wallet (updated_at desc);

-- The bot uses the REST API with the project key. Keep RLS disabled for this
-- server-side table, or add equivalent policies for the key used by the bot.
-- Never expose SUPABASE_KEY in a client-side application.