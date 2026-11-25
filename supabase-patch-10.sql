-- Hero Board patch 10: staff can confirm only after their store manager has acknowledged.
-- The staff link is the same every week, so an old shared link used to let staff confirm a new
-- week (or update) before the manager had seen it. Now:
--   hb_staff_page   returns mgr_ack for the week and for each update
--   hb_staff_confirm refuses with MANAGER_FIRST until the manager has acknowledged
-- Safe to run more than once.

create or replace function public.hb_staff_page(p_key uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare s public.hb_stores; w public.hb_weeks;
begin
  select * into s from public.hb_stores where link_key = p_key;
  if s.id is null then raise exception 'LINK_INVALID'; end if;
  w := public.hb_current_week();
  return json_build_object(
    'store', json_build_object('code', s.code, 'name', s.name),
    'week', case when w.id is null then null else json_build_object('id', w.id, 'title', w.title, 'start_date', w.start_date, 'end_date', w.end_date,
      'mgr_ack', exists (select 1 from public.hb_store_acks a where a.week_id = w.id and a.store_id = s.id)) end,
    'products', coalesce((select json_agg(p order by p.sort, p.id) from (select name, description, price, photo_url, sort, id, slot, media from public.hb_products where week_id = w.id) p), '[]'::json),
    'updates', coalesce((select json_agg(json_build_object('id', u.id, 'title', u.title, 'message', u.message, 'media', u.media, 'published_at', u.published_at, 'closes_at', u.closes_at,
        'mgr_ack', exists (select 1 from public.hb_update_store_acks a where a.update_id = u.id and a.store_id = s.id))
      order by u.published_at desc, u.id desc) from public.hb_open_updates(s.id) u where u.require_staff), '[]'::json)
  );
end $$;

create or replace function public.hb_staff_confirm(p_key uuid, p_employee_id text, p_name text, p_week_id int, p_update_ids int[])
returns json language plpgsql security definer set search_path = public as $$
declare s public.hb_stores; w public.hb_weeks; e text; n text; uid int; ids int[]; done int[] := '{}'; week_done boolean := false; ex text; other_name text; blocked boolean := false;
begin
  ids := array(select distinct x from unnest(coalesce(p_update_ids, '{}')) x where x is not null);
  if p_week_id is not null and coalesce(array_length(ids, 1), 0) > 0 then raise exception 'RELOAD'; end if;
  if coalesce(array_length(ids, 1), 0) > 20 then raise exception 'Too many updates'; end if;
  select * into s from public.hb_stores where link_key = p_key;
  if s.id is null then raise exception 'LINK_INVALID'; end if;
  e := upper(regexp_replace(translate(coalesce(p_employee_id, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^A-Za-z0-9]', '', 'g'));
  n := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  if length(e) < 1 or length(e) > 20 or length(n) < 2 or length(n) > 80 then raise exception 'Please enter your name and Employee ID'; end if;
  perform pg_advisory_xact_lock(hashtext('hb_staff_confirm'), s.id);
  w := public.hb_current_week();
  if p_week_id is not null then
    if w.id is distinct from p_week_id then raise exception 'WEEK_CHANGED'; end if;
    if not exists (select 1 from public.hb_store_acks a where a.week_id = w.id and a.store_id = s.id) then raise exception 'MANAGER_FIRST'; end if;
    select staff_name into ex from public.hb_staff_acks where week_id = w.id and store_id = s.id and employee_id = e;
    if ex is null then
      if (select count(*) from public.hb_staff_acks where week_id = w.id and store_id = s.id) >= 300 then raise exception 'Too many sign-offs for this store'; end if;
      insert into public.hb_staff_acks(week_id, store_id, employee_id, staff_name) values (w.id, s.id, e, n) on conflict do nothing;
    elsif lower(ex) <> lower(n) then other_name := ex;
    end if;
    week_done := true;
  end if;
  foreach uid in array ids loop
    if exists (select 1 from public.hb_open_updates(s.id) u where u.id = uid and u.require_staff) then
      if not exists (select 1 from public.hb_update_store_acks a where a.update_id = uid and a.store_id = s.id) then blocked := true; continue; end if;
      select staff_name into ex from public.hb_update_staff_acks where update_id = uid and store_id = s.id and employee_id = e;
      if ex is null then
        if (select count(*) from public.hb_update_staff_acks where update_id = uid and store_id = s.id) < 300 then
          insert into public.hb_update_staff_acks(update_id, store_id, employee_id, staff_name) values (uid, s.id, e, n) on conflict do nothing;
          done := done || uid;
        end if;
      else
        done := done || uid;
        if lower(ex) <> lower(n) then other_name := ex; end if;
      end if;
    end if;
  end loop;
  if coalesce(array_length(ids, 1), 0) > 0 and coalesce(array_length(done, 1), 0) = 0 then
    raise exception '%', case when blocked then 'MANAGER_FIRST' else 'UPDATE_CLOSED' end;
  end if;
  return json_build_object('name', n, 'employee_id', e, 'acked_at', now(), 'code', s.code, 'week', week_done, 'updates', to_json(done), 'other_name', other_name);
end $$;

revoke all on function public.hb_staff_page(uuid) from public;
revoke all on function public.hb_staff_confirm(uuid, text, text, int, int[]) from public;
grant execute on function public.hb_staff_page(uuid) to anon, authenticated;
grant execute on function public.hb_staff_confirm(uuid, text, text, int, int[]) to anon, authenticated;
