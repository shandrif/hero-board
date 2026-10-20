-- Hero Board patch 1: per-store staff links, login lockout, lighter admin refresh

alter table public.hb_stores
  add column if not exists link_key uuid not null default gen_random_uuid(),
  add column if not exists fail_count int not null default 0,
  add column if not exists locked_until timestamptz;
create unique index if not exists hb_stores_link_key on public.hb_stores(link_key);

-- Login: returns {error} instead of raising, so failed tries are counted. 5 wrong tries = 15 min lock.
drop function if exists public.hb_store_login(text, text);
create function public.hb_store_login(p_code text, p_password text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare s public.hb_stores; t uuid;
begin
  select * into s from public.hb_stores where upper(code) = upper(btrim(p_code));
  if s.id is null then return json_build_object('error', 'Wrong Store ID or password'); end if;
  if s.locked_until > now() then
    return json_build_object('error', 'Too many wrong tries. Please wait ' || ceil(extract(epoch from s.locked_until - now()) / 60) || ' min or ask the admin.');
  end if;
  if s.pass_hash <> crypt(upper(btrim(p_password)), s.pass_hash) then
    update public.hb_stores set
      locked_until = case when fail_count + 1 >= 5 then now() + interval '15 minutes' else null end,
      fail_count = case when fail_count + 1 >= 5 then 0 else fail_count + 1 end
      where id = s.id;
    return json_build_object('error', 'Wrong Store ID or password');
  end if;
  update public.hb_stores set fail_count = 0, locked_until = null where id = s.id;
  delete from public.hb_store_sessions where expires_at < now();
  insert into public.hb_store_sessions(store_id) values (s.id) returning token into t;
  return json_build_object('token', t, 'code', s.code, 'name', s.name);
end $$;

create or replace function public.hb_admin_reset_password(p_store_id int) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare pw text := public.hb_gen_pass();
begin
  if not public.hb_is_admin() then raise exception 'Not allowed'; end if;
  update public.hb_stores set pass_plain = pw, pass_hash = crypt(pw, gen_salt('bf')), fail_count = 0, locked_until = null where id = p_store_id;
  delete from public.hb_store_sessions where store_id = p_store_id;
  return pw;
end $$;

-- Store home now includes the store's private staff-link key
create or replace function public.hb_store_home(p_token uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare sid int := public.hb_session_store(p_token); s public.hb_stores; w public.hb_weeks;
begin
  if sid is null then raise exception 'SESSION_EXPIRED'; end if;
  select * into s from public.hb_stores where id = sid;
  w := public.hb_current_week();
  return json_build_object(
    'store', json_build_object('id', s.id, 'code', s.code, 'name', s.name, 'total_staff', s.total_staff, 'link_key', s.link_key),
    'week', case when w.id is null then null else json_build_object('id', w.id, 'title', w.title, 'start_date', w.start_date, 'end_date', w.end_date, 'published_at', w.published_at, 'share_token', w.share_token) end,
    'products', coalesce((select json_agg(p order by p.sort, p.id) from (select id, name, description, price, photo_url, sort from public.hb_products where week_id = w.id) p), '[]'::json),
    'ack', (select acked_at from public.hb_store_acks where week_id = w.id and store_id = sid),
    'staff', coalesce((select json_agg(x order by x.acked_at desc) from (select employee_id, staff_name, acked_at from public.hb_staff_acks where week_id = w.id and store_id = sid) x), '[]'::json)
  );
end $$;

-- Staff link = week token + the store's private key (store codes can no longer be swapped in the link)
drop function if exists public.hb_staff_view(uuid, text);
drop function if exists public.hb_staff_ack(uuid, text, text, text);
create function public.hb_staff_view(p_week_token uuid, p_key uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare w public.hb_weeks; s public.hb_stores;
begin
  select * into w from public.hb_weeks where share_token = p_week_token and published;
  select * into s from public.hb_stores where link_key = p_key;
  if w.id is null or s.id is null then raise exception 'LINK_INVALID'; end if;
  return json_build_object(
    'store', json_build_object('code', s.code, 'name', s.name),
    'week', json_build_object('title', w.title, 'start_date', w.start_date, 'end_date', w.end_date),
    'is_current', w.id = (public.hb_current_week()).id,
    'products', coalesce((select json_agg(p order by p.sort, p.id) from (select name, description, price, photo_url, sort, id from public.hb_products where week_id = w.id) p), '[]'::json)
  );
end $$;
create function public.hb_staff_ack(p_week_token uuid, p_key uuid, p_employee_id text, p_name text) returns json
language plpgsql security definer set search_path = public as $$
declare w public.hb_weeks; s public.hb_stores; e text := upper(btrim(p_employee_id)); n text := btrim(p_name); existing public.hb_staff_acks;
begin
  select * into w from public.hb_weeks where share_token = p_week_token and published;
  select * into s from public.hb_stores where link_key = p_key;
  if w.id is null or s.id is null then raise exception 'LINK_INVALID'; end if;
  if w.id <> (public.hb_current_week()).id then raise exception 'LINK_OLD'; end if;
  if length(e) < 1 or length(e) > 30 or length(n) < 2 or length(n) > 80 then raise exception 'Please enter your name and Employee ID'; end if;
  select * into existing from public.hb_staff_acks where week_id = w.id and store_id = s.id and employee_id = e;
  if existing.id is not null then
    return json_build_object('already', true, 'acked_at', existing.acked_at, 'name', existing.staff_name, 'code', s.code);
  end if;
  if (select count(*) from public.hb_staff_acks where week_id = w.id and store_id = s.id) >= 300 then raise exception 'Too many sign-offs for this store'; end if;
  insert into public.hb_staff_acks(week_id, store_id, employee_id, staff_name) values (w.id, s.id, e, n) returning * into existing;
  return json_build_object('already', false, 'acked_at', existing.acked_at, 'name', existing.staff_name, 'code', s.code);
end $$;

-- Admin: small per-store staff counts (instead of downloading every staff row on each refresh)
create or replace function public.hb_admin_staff_counts(p_week_ids int[])
returns table(week_id int, store_id int, n int) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.hb_is_admin() then raise exception 'Not allowed'; end if;
  return query select a.week_id, a.store_id, count(*)::int from public.hb_staff_acks a where a.week_id = any(p_week_ids) group by a.week_id, a.store_id;
end $$;

revoke all on function public.hb_admin_staff_counts(int[]) from public, anon;
grant execute on function public.hb_admin_staff_counts(int[]) to authenticated;
revoke all on function public.hb_store_login(text,text) from public;
revoke all on function public.hb_staff_view(uuid,uuid) from public;
revoke all on function public.hb_staff_ack(uuid,uuid,text,text) from public;
grant execute on function public.hb_store_login(text,text), public.hb_staff_view(uuid,uuid), public.hb_staff_ack(uuid,uuid,text,text) to anon, authenticated;
revoke execute on function public.hb_is_admin() from anon, public;
grant execute on function public.hb_is_admin() to authenticated;
