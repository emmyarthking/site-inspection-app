-- Run once in Supabase: SQL Editor > New query > paste > Run.
create table if not exists public.docs (
  collection text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
alter table public.docs enable row level security;
create policy "Signed-in staff can read and write" on public.docs
  for all to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.docs;

insert into storage.buckets (id, name, public) values ('photos', 'photos', true)
  on conflict (id) do nothing;
create policy "Signed-in staff can upload photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'photos');
