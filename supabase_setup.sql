-- =============================================================
-- Pivot Sites: Supabase schema + seed data + RLS policies
-- Run this ONCE in Supabase Dashboard -> SQL Editor -> New query
-- =============================================================

-- Tables ------------------------------------------------------

create table if not exists public.sources (
  name       text primary key,
  color      text not null default '#666666',
  created_at timestamptz default now()
);

create table if not exists public.sites (
  id         bigserial primary key,
  source     text not null references public.sources(name) on delete cascade,
  name       text,
  lat        double precision not null,
  lng        double precision not null,
  radius_m   double precision,
  notes      text,
  created_at timestamptz default now(),
  constraint sites_lat_range check (lat between -90 and 90),
  constraint sites_lng_range check (lng between -180 and 180)
);

create index if not exists idx_sites_source on public.sites(source);

-- Seed the three requested sources (idempotent) ---------------

insert into public.sources (name, color) values
  ('Verizon Sites',      '#EE0000'),
  ('Google Earth Sites', '#4285F4'),
  ('Google Sheets Sites','#4285F4'),
  ('AgSense Sites',      '#F5A623'),
  ('Fitzgerald',         '#34A853'),
  ('Live Oak',           '#FBBC04'),
  ('Brownsville',        '#EA4335'),
  ('Americus',           '#8B5A2B')
on conflict (name) do nothing;

-- Row Level Security ------------------------------------------
-- Allow the publishable/anon key full read + write access.
-- (Rework later with auth if you want per-user restrictions.)

alter table public.sources enable row level security;
alter table public.sites   enable row level security;

drop policy if exists "public read sources"   on public.sources;
drop policy if exists "public write sources"  on public.sources;
drop policy if exists "public update sources" on public.sources;
drop policy if exists "public delete sources" on public.sources;
drop policy if exists "public read sites"     on public.sites;
drop policy if exists "public write sites"    on public.sites;
drop policy if exists "public update sites"   on public.sites;
drop policy if exists "public delete sites"   on public.sites;

create policy "public read sources"   on public.sources for select using (true);
create policy "public write sources"  on public.sources for insert with check (true);
create policy "public update sources" on public.sources for update using (true) with check (true);
create policy "public delete sources" on public.sources for delete using (true);

create policy "public read sites"     on public.sites   for select using (true);
create policy "public write sites"    on public.sites   for insert with check (true);
create policy "public update sites"   on public.sites   for update using (true) with check (true);
create policy "public delete sites"   on public.sites   for delete using (true);

insert into public.sources (name, color) values ('Americus', '#8B5A2B')
on conflict (name) do nothing;
update public.sites set source = 'Americus' where source = 'Google Sheets Americus';
delete from public.sources s
where s.name = 'Google Sheets Americus'
  and not exists (select 1 from public.sites t where t.source = s.name);

-- Sanity check ------------------------------------------------
select name, color from public.sources order by name;
