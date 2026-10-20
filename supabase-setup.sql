-- Hero Board — database setup (Supabase project: hm-fieldnote)
-- Run once in Supabase → SQL Editor. Adds only hb_ tables; does not touch Trackit.

create table if not exists public.hb_admins (user_id uuid primary key references auth.users(id) on delete cascade);
insert into public.hb_admins select id from auth.users where email = 'shandriff@gmail.com' on conflict do nothing;

create or replace function public.hb_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.hb_admins where user_id = auth.uid());
$$;

create table public.hb_stores (
  id serial primary key,
  code text unique not null,
  name text unique not null,
  pass_plain text not null,
  pass_hash text not null,
  total_staff int not null default 0,
  created_at timestamptz not null default now()
);
create table public.hb_store_sessions (
  token uuid primary key default gen_random_uuid(),
  store_id int not null references public.hb_stores(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '60 days'
);
create table public.hb_weeks (
  id serial primary key,
  title text not null,
  start_date date not null,
  end_date date not null,
  published boolean not null default false,
  published_at timestamptz,
  share_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create table public.hb_products (
  id serial primary key,
  week_id int not null references public.hb_weeks(id) on delete cascade,
  name text not null,
  description text not null default '',
  price numeric(10,2),
  photo_url text,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create table public.hb_store_acks (
  week_id int not null references public.hb_weeks(id) on delete cascade,
  store_id int not null references public.hb_stores(id) on delete cascade,
  acked_at timestamptz not null default now(),
  primary key (week_id, store_id)
);
create table public.hb_staff_acks (
  id serial primary key,
  week_id int not null references public.hb_weeks(id) on delete cascade,
  store_id int not null references public.hb_stores(id) on delete cascade,
  employee_id text not null,
  staff_name text not null,
  acked_at timestamptz not null default now(),
  unique (week_id, store_id, employee_id)
);
create index on public.hb_products(week_id);
create index on public.hb_staff_acks(week_id, store_id);
create index on public.hb_store_sessions(store_id);

alter table public.hb_admins enable row level security;
alter table public.hb_stores enable row level security;
alter table public.hb_store_sessions enable row level security;
alter table public.hb_weeks enable row level security;
alter table public.hb_products enable row level security;
alter table public.hb_store_acks enable row level security;
alter table public.hb_staff_acks enable row level security;

create policy hb_admins_self on public.hb_admins for select to authenticated using (user_id = auth.uid());
create policy hb_admin_all on public.hb_stores for all to authenticated using (public.hb_is_admin()) with check (public.hb_is_admin());
create policy hb_admin_all on public.hb_weeks for all to authenticated using (public.hb_is_admin()) with check (public.hb_is_admin());
create policy hb_admin_all on public.hb_products for all to authenticated using (public.hb_is_admin()) with check (public.hb_is_admin());
create policy hb_admin_all on public.hb_store_acks for all to authenticated using (public.hb_is_admin()) with check (public.hb_is_admin());
create policy hb_admin_all on public.hb_staff_acks for all to authenticated using (public.hb_is_admin()) with check (public.hb_is_admin());

create or replace function public.hb_gen_pass() returns text language plpgsql volatile set search_path = public, extensions as $$
declare chars text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; b bytea := gen_random_bytes(6); r text := ''; i int;
begin
  for i in 0..5 loop r := r || substr(chars, (get_byte(b,i) % length(chars)) + 1, 1); end loop;
  return r;
end $$;

create or replace function public.hb_session_store(p_token uuid) returns int
language sql stable security definer set search_path = public as $$
  select store_id from public.hb_store_sessions where token = p_token and expires_at > now();
$$;

create or replace function public.hb_current_week() returns public.hb_weeks
language sql stable security definer set search_path = public as $$
  select * from public.hb_weeks where published order by published_at desc nulls last, id desc limit 1;
$$;

create or replace function public.hb_admin_create_stores(p_names text[])
returns table(code text, name text, password text, created boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare n text; nxt int; pw text; c text;
begin
  if not public.hb_is_admin() then raise exception 'Not allowed'; end if;
  select coalesce(max(substring(s.code from 3)::int), 0) into nxt from public.hb_stores s where s.code ~ '^HM[0-9]+$';
  foreach n in array p_names loop
    n := btrim(regexp_replace(coalesce(n,''), '\s+', ' ', 'g'));
    continue when n = '';
    if exists (select 1 from public.hb_stores s where lower(s.name) = lower(n)) then
      return query select s.code, s.name, s.pass_plain, false from public.hb_stores s where lower(s.name) = lower(n);
      continue;
    end if;
    nxt := nxt + 1; c := 'HM' || lpad(nxt::text, 3, '0'); pw := public.hb_gen_pass();
    insert into public.hb_stores(code, name, pass_plain, pass_hash) values (c, n, pw, crypt(pw, gen_salt('bf')));
    return query select c, n, pw, true;
  end loop;
end $$;

create or replace function public.hb_admin_reset_password(p_store_id int) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare pw text := public.hb_gen_pass();
begin
  if not public.hb_is_admin() then raise exception 'Not allowed'; end if;
  update public.hb_stores set pass_plain = pw, pass_hash = crypt(pw, gen_salt('bf')) where id = p_store_id;
  delete from public.hb_store_sessions where store_id = p_store_id;
  return pw;
end $$;

create or replace function public.hb_store_login(p_code text, p_password text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare s public.hb_stores; t uuid;
begin
  select * into s from public.hb_stores where upper(code) = upper(btrim(p_code));
  if s.id is null or s.pass_hash <> crypt(upper(btrim(p_password)), s.pass_hash) then
    raise exception 'Wrong Store ID or password';
  end if;
  delete from public.hb_store_sessions where expires_at < now();
  insert into public.hb_store_sessions(store_id) values (s.id) returning token into t;
  return json_build_object('token', t, 'code', s.code, 'name', s.name);
end $$;

create or replace function public.hb_store_logout(p_token uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.hb_store_sessions where token = p_token;
$$;

create or replace function public.hb_store_home(p_token uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare sid int := public.hb_session_store(p_token); s public.hb_stores; w public.hb_weeks;
begin
  if sid is null then raise exception 'SESSION_EXPIRED'; end if;
  select * into s from public.hb_stores where id = sid;
  w := public.hb_current_week();
  return json_build_object(
    'store', json_build_object('id', s.id, 'code', s.code, 'name', s.name, 'total_staff', s.total_staff),
    'week', case when w.id is null then null else json_build_object('id', w.id, 'title', w.title, 'start_date', w.start_date, 'end_date', w.end_date, 'published_at', w.published_at, 'share_token', w.share_token) end,
    'products', coalesce((select json_agg(p order by p.sort, p.id) from (select id, name, description, price, photo_url, sort from public.hb_products where week_id = w.id) p), '[]'::json),
    'ack', (select acked_at from public.hb_store_acks where week_id = w.id and store_id = sid),
    'staff', coalesce((select json_agg(x order by x.acked_at desc) from (select employee_id, staff_name, acked_at from public.hb_staff_acks where week_id = w.id and store_id = sid) x), '[]'::json)
  );
end $$;

create or replace function public.hb_store_ack(p_token uuid, p_week_id int) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare sid int := public.hb_session_store(p_token); t timestamptz;
begin
  if sid is null then raise exception 'SESSION_EXPIRED'; end if;
  if not exists (select 1 from public.hb_weeks where id = p_week_id and published) then raise exception 'Week not found'; end if;
  insert into public.hb_store_acks(week_id, store_id) values (p_week_id, sid) on conflict do nothing;
  select acked_at into t from public.hb_store_acks where week_id = p_week_id and store_id = sid;
  return t;
end $$;

create or replace function public.hb_store_set_staff(p_token uuid, p_total int) returns void
language plpgsql security definer set search_path = public as $$
declare sid int := public.hb_session_store(p_token);
begin
  if sid is null then raise exception 'SESSION_EXPIRED'; end if;
  if p_total < 0 or p_total > 500 then raise exception 'Invalid number'; end if;
  update public.hb_stores set total_staff = p_total where id = sid;
end $$;

create or replace function public.hb_staff_view(p_week_token uuid, p_store_code text) returns json
language plpgsql stable security definer set search_path = public as $$
declare w public.hb_weeks; s public.hb_stores;
begin
  select * into w from public.hb_weeks where share_token = p_week_token and published;
  select * into s from public.hb_stores where upper(code) = upper(p_store_code);
  if w.id is null or s.id is null then raise exception 'LINK_INVALID'; end if;
  return json_build_object(
    'store', json_build_object('code', s.code, 'name', s.name),
    'week', json_build_object('title', w.title, 'start_date', w.start_date, 'end_date', w.end_date),
    'is_current', w.id = (public.hb_current_week()).id,
    'products', coalesce((select json_agg(p order by p.sort, p.id) from (select name, description, price, photo_url, sort, id from public.hb_products where week_id = w.id) p), '[]'::json)
  );
end $$;

create or replace function public.hb_staff_ack(p_week_token uuid, p_store_code text, p_employee_id text, p_name text) returns json
language plpgsql security definer set search_path = public as $$
declare w public.hb_weeks; s public.hb_stores; e text := upper(btrim(p_employee_id)); n text := btrim(p_name); existing public.hb_staff_acks;
begin
  select * into w from public.hb_weeks where share_token = p_week_token and published;
  select * into s from public.hb_stores where upper(code) = upper(p_store_code);
  if w.id is null or s.id is null then raise exception 'LINK_INVALID'; end if;
  if w.id <> (public.hb_current_week()).id then raise exception 'LINK_OLD'; end if;
  if length(e) < 1 or length(e) > 30 or length(n) < 2 or length(n) > 80 then raise exception 'Please enter your name and Employee ID'; end if;
  select * into existing from public.hb_staff_acks where week_id = w.id and store_id = s.id and employee_id = e;
  if existing.id is not null then
    return json_build_object('already', true, 'acked_at', existing.acked_at, 'name', existing.staff_name);
  end if;
  insert into public.hb_staff_acks(week_id, store_id, employee_id, staff_name) values (w.id, s.id, e, n) returning * into existing;
  return json_build_object('already', false, 'acked_at', existing.acked_at, 'name', existing.staff_name);
end $$;

revoke all on function public.hb_admin_create_stores(text[]) from public, anon;
revoke all on function public.hb_admin_reset_password(int) from public, anon;
revoke all on function public.hb_gen_pass() from public, anon, authenticated;
revoke all on function public.hb_session_store(uuid) from public, anon, authenticated;
revoke all on function public.hb_current_week() from public, anon, authenticated;
grant execute on function public.hb_admin_create_stores(text[]) to authenticated;
grant execute on function public.hb_admin_reset_password(int) to authenticated;
grant execute on function public.hb_store_login(text,text), public.hb_store_logout(uuid), public.hb_store_home(uuid), public.hb_store_ack(uuid,int), public.hb_store_set_staff(uuid,int), public.hb_staff_view(uuid,text), public.hb_staff_ack(uuid,text,text,text) to anon, authenticated;

insert into storage.buckets (id, name, public) values ('hb-photos', 'hb-photos', true) on conflict do nothing;
create policy hb_photos_admin_write on storage.objects for insert to authenticated with check (bucket_id = 'hb-photos' and public.hb_is_admin());
create policy hb_photos_admin_update on storage.objects for update to authenticated using (bucket_id = 'hb-photos' and public.hb_is_admin());
create policy hb_photos_admin_delete on storage.objects for delete to authenticated using (bucket_id = 'hb-photos' and public.hb_is_admin());
