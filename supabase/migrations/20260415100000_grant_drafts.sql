-- Grant drafts: save AI-generated grant application drafts per user + funder
create table if not exists public.grant_drafts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  funder_id    text not null,
  funder_name  text not null,
  funder_ein   text,
  title        text not null default '',
  content      text not null,
  mission      text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Row-level security
alter table public.grant_drafts enable row level security;

create policy "Users can manage their own grant drafts"
  on public.grant_drafts
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Index for fast lookups by user + funder
create index grant_drafts_user_funder_idx on public.grant_drafts (user_id, funder_id);

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Only create trigger if it doesn't already exist (function may be shared)
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'grant_drafts_updated_at'
      and tgrelid = 'public.grant_drafts'::regclass
  ) then
    create trigger grant_drafts_updated_at
      before update on public.grant_drafts
      for each row execute function public.set_updated_at();
  end if;
end;
$$;
