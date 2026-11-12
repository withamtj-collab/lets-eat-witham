-- Witham Dinners: Step 1 database setup
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.

-- ========== TABLES ==========

-- Family members (linked to Supabase logins)
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  role text not null default 'member' check (role in ('admin','member'))
);

create table weeks (
  id bigint generated always as identity primary key,
  start_date date not null unique,          -- Monday of the planning week
  closes_at timestamptz not null,           -- Sunday 5 PM
  status text not null default 'open' check (status in ('open','closed','finalized'))
);

create table recipes (
  id bigint generated always as identity primary key,
  name text not null,
  type text not null default 'homemade' check (type in ('homemade','prepackaged')),
  store text,
  cook_method text,
  prep_min int,
  cook_min int,
  total_min int generated always as (coalesce(prep_min,0) + coalesce(cook_min,0)) stored,
  is_quick boolean generated always as (coalesce(prep_min,0) + coalesce(cook_min,0) <= 30) stored,
  time_estimated boolean default false,
  servings int default 5,
  instructions text,
  tags text[] default '{}',
  source_url text,
  photo_url text,
  priority boolean default false,
  protein_g numeric, carbs_g numeric, fat_g numeric, calories numeric,
  macros_estimated boolean default false,
  created_at timestamptz default now()
);

create table recipe_ingredients (
  id bigint generated always as identity primary key,
  recipe_id bigint references recipes on delete cascade,
  ingredient text not null,
  quantity numeric,
  unit text,
  section text check (section in ('produce','dairy','meat','pantry','frozen','bakery','other'))
);

create table options (
  id bigint generated always as identity primary key,
  name text not null,
  category text not null check (category in ('dine_in','takeout','restaurant')),
  recipe_id bigint references recipes on delete set null
);

create table votes (
  id bigint generated always as identity primary key,
  week_id bigint references weeks on delete cascade,
  user_id uuid references profiles on delete cascade default auth.uid(),
  category text not null check (category in ('dine_in','takeout','restaurant')),
  option_id bigint references options on delete cascade,
  write_in text,
  unique (week_id, user_id, category),      -- one pick per category
  check (option_id is not null or write_in is not null)
);

create table requests (
  id bigint generated always as identity primary key,
  week_id bigint references weeks on delete cascade,
  user_id uuid references profiles on delete cascade default auth.uid(),
  day date,
  type text check (type in ('celebration','guest','dietary','craving')),
  text text not null
);

create table plan_days (
  id bigint generated always as identity primary key,
  week_id bigint references weeks on delete cascade,
  date date not null,
  calendar_flag text default 'home' check (calendar_flag in ('home','tight','away')),
  meal_kind text check (meal_kind in ('recipe','takeout','restaurant','leftovers','fend')),
  recipe_id bigint references recipes,
  option_id bigint references options on delete set null,
  note text,
  unique (week_id, date)
);

create table meal_credits (
  id bigint generated always as identity primary key,
  plan_day_id bigint references plan_days on delete cascade,
  user_id uuid references profiles on delete cascade,
  source text check (source in ('vote','request'))
);

create table pantry_items (
  id bigint generated always as identity primary key,
  ingredient text not null unique,
  on_hand boolean default false,
  is_staple boolean default false
);

create table shopping_items (
  id bigint generated always as identity primary key,
  week_id bigint references weeks on delete cascade,
  ingredient text not null,
  quantity numeric,
  unit text,
  section text,
  checked boolean default false
);

-- ========== HELPERS ==========

-- True when the signed-in person is an admin (Tim or Erica)
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- True while a week's poll is still open (before Sunday 5 PM)
create or replace function week_is_open(w bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from weeks where id = w and status = 'open' and now() < closes_at);
$$;

-- Every new login gets a member profile automatically
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ========== PRIVACY RULES ==========

alter table profiles enable row level security;
alter table weeks enable row level security;
alter table recipes enable row level security;
alter table recipe_ingredients enable row level security;
alter table options enable row level security;
alter table votes enable row level security;
alter table requests enable row level security;
alter table plan_days enable row level security;
alter table meal_credits enable row level security;
alter table pantry_items enable row level security;
alter table shopping_items enable row level security;

-- Shared lists: everyone signed in can read; only admins change them
create policy read_all on profiles for select to authenticated using (true);
create policy read_all on weeks for select to authenticated using (true);
create policy read_all on recipes for select to authenticated using (true);
create policy read_all on recipe_ingredients for select to authenticated using (true);
create policy read_all on options for select to authenticated using (true);
create policy read_all on plan_days for select to authenticated using (true);

create policy admin_all on profiles for all to authenticated using (is_admin()) with check (is_admin());
create policy admin_all on weeks for all to authenticated using (is_admin()) with check (is_admin());
create policy admin_all on recipes for all to authenticated using (is_admin()) with check (is_admin());
create policy admin_all on recipe_ingredients for all to authenticated using (is_admin()) with check (is_admin());
create policy admin_all on options for all to authenticated using (is_admin()) with check (is_admin());
create policy admin_all on plan_days for all to authenticated using (is_admin()) with check (is_admin());

-- Admin-only: fairness history, pantry, shopping list
create policy admin_all on meal_credits for all to authenticated using (is_admin()) with check (is_admin());
create policy admin_all on pantry_items for all to authenticated using (is_admin()) with check (is_admin());
create policy admin_all on shopping_items for all to authenticated using (is_admin()) with check (is_admin());

-- Votes and requests: members see and change only their own, and only while the poll is open.
-- Admins see everyone's.
create policy own_read on votes for select to authenticated using (user_id = auth.uid() or is_admin());
create policy own_insert on votes for insert to authenticated with check (user_id = auth.uid() and week_is_open(week_id));
create policy own_update on votes for update to authenticated
  using (user_id = auth.uid() and week_is_open(week_id))
  with check (user_id = auth.uid() and week_is_open(week_id));
create policy own_delete on votes for delete to authenticated using (user_id = auth.uid() and week_is_open(week_id));

create policy own_read on requests for select to authenticated using (user_id = auth.uid() or is_admin());
create policy own_insert on requests for insert to authenticated with check (user_id = auth.uid() and week_is_open(week_id));
create policy own_update on requests for update to authenticated
  using (user_id = auth.uid() and week_is_open(week_id))
  with check (user_id = auth.uid() and week_is_open(week_id));
create policy own_delete on requests for delete to authenticated using (user_id = auth.uid() and week_is_open(week_id));

-- ========== AFTER ADDING THE FIVE LOGINS ==========
-- Run this separately once the logins exist (Authentication → Users → Add user).
-- Replace the two emails with the ones you and Erica actually use:
--
-- update profiles set role = 'admin'
-- where id in (select id from auth.users where email in ('withamtj@gmail.com', 'ERICA-EMAIL-HERE'));
