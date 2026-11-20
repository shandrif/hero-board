-- Hero Board patch 7: store page Staff tab lists who confirmed each update (separate from hero weeks)
-- hb_store_home: each open update now also returns "staff" = [{employee_id, staff_name, acked_at}] for this store.
-- (Same function as patch 6, plus the "staff" list per update.) Safe to run more than once.
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
        'staff_n', (select count(*) from public.hb_update_staff_acks a where a.update_id = u.id and a.store_id = sid),
        'staff', coalesce((select json_agg(json_build_object('employee_id', a.employee_id, 'staff_name', a.staff_name, 'acked_at', a.acked_at) order by a.acked_at desc)
                  from public.hb_update_staff_acks a where a.update_id = u.id and a.store_id = sid), '[]'::json))
      order by u.published_at desc, u.id desc) from public.hb_open_updates(sid) u), '[]'::json)
  );
end $$;
