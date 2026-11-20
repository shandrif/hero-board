-- Hero Board patch 6: Updates (announcements with optional confidential video / document)
-- Separate from hero weeks. Each update can target all stores or chosen regions / area managers / ROMs / stores,
-- stays open 7 days, and is acknowledged by store managers and (optionally) staff.
-- Staff use ONE link per store (staff.html?k=<link_key>) that shows this week's heroes plus open updates.
-- Safe to run more than once. Only touches Hero Board (hb_) objects.

create table if not exists public.hb_updates (
  id serial primary key,
  title text not null,
  message text not null default '',
  media jsonb not null default '[]'::jsonb,
  target_kind text not null default 'all' check (target_kind in ('all', 'region', 'city', 'area_manager', 'rom', 'stores')),
  target_values text[] not null default '{}',
  require_staff boolean not null default true,
  published boolean not null default false,
  published_at timestamptz,
  closes_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.hb_update_store_acks (
  update_id int not null references public.hb_updates(id) on delete cascade,
  store_id int not null references public.hb_stores(id) on delete cascade,
  acked_at timestamptz not null default now(),
  primary key (update_id, store_id)
);
create table if not exists public.hb_update_staff_acks (
  id serial primary key,
  update_id int not null references public.hb_updates(id) on delete cascade,
  store_id int not null references public.hb_stores(id) on delete cascade,
  employee_id text not null,
  staff_name text not null,
  acked_at timestamptz not null default now(),
  unique (update_id, store_id, employee_id)
);
create index if not exists hb_update_staff_acks_us on public.hb_update_staff_acks(update_id, store_id);

alter table public.hb_updates enable row level security;
alter table public.hb_update_store_acks enable row level security;
alter table public.hb_update_staff_acks enable row level security;
drop policy if exists hb_admin_all on public.hb_updates;
drop policy if exists hb_admin_all on public.hb_update_store_acks;
drop policy if exists hb_admin_all on public.hb_update_staff_acks;
create policy hb_admin_all on public.hb_updates for all to authenticated using (public.hb_is_admin()) with check (public.hb_is_admin());
create policy hb_admin_all on public.hb_update_store_acks for all to authenticated using (public.hb_is_admin()) with check (public.hb_is_admin());
create policy hb_admin_all on public.hb_update_staff_acks for all to authenticated using (public.hb_is_admin()) with check (public.hb_is_admin());

-- Does an update apply to a store?
create or replace function public.hb_update_targets(u public.hb_updates, s public.hb_stores) returns boolean
language sql stable set search_path = public as $$
  select case u.target_kind
    when 'all' then true
    when 'region' then s.region = any(u.target_values)
    when 'city' then s.city = any(u.target_values)
    when 'area_manager' then s.area_manager = any(u.target_values)
    when 'rom' then s.rom = any(u.target_values)
    when 'stores' then s.code = any(u.target_values)
    else false end
$$;

-- Open updates for one store (published, not yet closed, targeted at it), newest first
create or replace function public.hb_open_updates(p_store_id int) returns setof public.hb_updates
language sql stable security definer set search_path = public as $$
  select u.* from public.hb_updates u, public.hb_stores s
   where s.id = p_store_id and u.published and u.closes_at > now() and public.hb_update_targets(u, s)
   order by u.published_at desc, u.id desc
$$;
revoke all on function public.hb_open_updates(int) from public, anon, authenticated;

-- Store home: + updates
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
    'products', coalesce((select json_agg(p order by p.sort, p.id) from (select id, name, description, price, photo_url, sort, slot, media from public.hb_products where week_id = w.id) p), '[]'::json),
    'ack', (select acked_at from public.hb_store_acks where week_id = w.id and store_id = sid),
    'staff', coalesce((select json_agg(x order by x.acked_at desc) from (select employee_id, staff_name, acked_at from public.hb_staff_acks where week_id = w.id and store_id = sid) x), '[]'::json),
    'updates', coalesce((select json_agg(json_build_object(
        'id', u.id, 'title', u.title, 'message', u.message, 'media', u.media, 'require_staff', u.require_staff,
        'published_at', u.published_at, 'closes_at', u.closes_at,
        'ack', (select acked_at from public.hb_update_store_acks a where a.update_id = u.id and a.store_id = sid),
        'staff_n', (select count(*) from public.hb_update_staff_acks a where a.update_id = u.id and a.store_id = sid))
      order by u.published_at desc, u.id desc) from public.hb_open_updates(sid) u), '[]'::json)
  );
end $$;

-- Store manager acknowledges an update
create or replace function public.hb_store_ack_update(p_token uuid, p_update_id int) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare sid int := public.hb_session_store(p_token); t timestamptz;
begin
  if sid is null then raise exception 'SESSION_EXPIRED'; end if;
  if not exists (select 1 from public.hb_open_updates(sid) u where u.id = p_update_id) then raise exception 'This update is closed or not for your store'; end if;
  insert into public.hb_update_store_acks(update_id, store_id) values (p_update_id, sid) on conflict do nothing;
  select acked_at into t from public.hb_update_store_acks where update_id = p_update_id and store_id = sid;
  return t;
end $$;

-- Staff page (one link per store): this week's heroes + open updates that need staff confirmation
create or replace function public.hb_staff_page(p_key uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare s public.hb_stores; w public.hb_weeks;
begin
  select * into s from public.hb_stores where link_key = p_key;
  if s.id is null then raise exception 'LINK_INVALID'; end if;
  w := public.hb_current_week();
  return json_build_object(
    'store', json_build_object('code', s.code, 'name', s.name),
    'week', case when w.id is null then null else json_build_object('id', w.id, 'title', w.title, 'start_date', w.start_date, 'end_date', w.end_date) end,
    'products', coalesce((select json_agg(p order by p.sort, p.id) from (select name, description, price, photo_url, sort, id, slot, media from public.hb_products where week_id = w.id) p), '[]'::json),
    'updates', coalesce((select json_agg(json_build_object('id', u.id, 'title', u.title, 'message', u.message, 'media', u.media, 'published_at', u.published_at, 'closes_at', u.closes_at)
      order by u.published_at desc, u.id desc) from public.hb_open_updates(s.id) u where u.require_staff), '[]'::json)
  );
end $$;

-- Staff confirms this week's heroes and/or open updates in one go
create or replace function public.hb_staff_confirm(p_key uuid, p_employee_id text, p_name text, p_week_id int, p_update_ids int[])
returns json language plpgsql security definer set search_path = public as $$
declare s public.hb_stores; w public.hb_weeks; e text := upper(btrim(coalesce(p_employee_id, ''))); n text := btrim(coalesce(p_name, ''));
  uid int; done int[] := '{}'; week_done boolean := false; nm text := null;
begin
  select * into s from public.hb_stores where link_key = p_key;
  if s.id is null then raise exception 'LINK_INVALID'; end if;
  if length(e) < 1 or length(e) > 30 or length(n) < 2 or length(n) > 80 then raise exception 'Please enter your name and Employee ID'; end if;
  w := public.hb_current_week();
  if p_week_id is not null and w.id = p_week_id then
    if not exists (select 1 from public.hb_staff_acks where week_id = w.id and store_id = s.id and employee_id = e) then
      if (select count(*) from public.hb_staff_acks where week_id = w.id and store_id = s.id) >= 300 then raise exception 'Too many sign-offs for this store'; end if;
      insert into public.hb_staff_acks(week_id, store_id, employee_id, staff_name) values (w.id, s.id, e, n);
    end if;
    week_done := true;
  end if;
  foreach uid in array coalesce(p_update_ids, '{}') loop
    if exists (select 1 from public.hb_open_updates(s.id) u where u.id = uid and u.require_staff) then
      if (select count(*) from public.hb_update_staff_acks where update_id = uid and store_id = s.id) < 300 then
        insert into public.hb_update_staff_acks(update_id, store_id, employee_id, staff_name) values (uid, s.id, e, n) on conflict do nothing;
      end if;
      done := done || uid;
    end if;
  end loop;
  return json_build_object('name', n, 'employee_id', e, 'acked_at', now(), 'code', s.code, 'week', week_done, 'updates', to_json(done));
end $$;

-- Admin: staff counts per update and store
create or replace function public.hb_admin_update_counts(p_update_ids int[]) returns table(update_id int, store_id int, n int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.hb_is_admin() then raise exception 'Not allowed'; end if;
  return query select a.update_id, a.store_id, count(*)::int from public.hb_update_staff_acks a where a.update_id = any(p_update_ids) group by a.update_id, a.store_id;
end $$;

-- Media access: current week's hero media + open updates for this store (store session or store link)
create or replace function public.hb_media_keys(p_store_token uuid, p_week_token uuid, p_link_key uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare sid int; w public.hb_weeks; s public.hb_stores;
begin
  if p_store_token is not null then
    sid := public.hb_session_store(p_store_token);
    if sid is null then raise exception 'SESSION_EXPIRED'; end if;
    select * into s from public.hb_stores where id = sid;
  else
    select * into s from public.hb_stores where link_key = p_link_key;
    if s.id is null then raise exception 'LINK_INVALID'; end if;
  end if;
  w := public.hb_current_week();
  return jsonb_build_object(
    'store', jsonb_build_object('code', s.code, 'name', s.name),
    'keys', coalesce((select jsonb_agg(k) from (
        select m->>'key' k from public.hb_products p, jsonb_array_elements(p.media) m where p.week_id = w.id
        union all
        select m->>'key' from public.hb_open_updates(s.id) u, jsonb_array_elements(u.media) m) x), '[]'::jsonb));
end $$;
revoke all on function public.hb_media_keys(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.hb_media_keys(uuid, uuid, uuid) to service_role;
