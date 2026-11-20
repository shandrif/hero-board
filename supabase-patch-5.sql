-- Hero Board patch 5: confidential hero media (video + document pages) stored privately in Cloudflare R2
-- Files live in a private R2 bucket; the "hb-media" edge function hands out links that expire after an hour,
-- only to the admin, a signed-in store, or a valid staff link for that week. R2 deletes files after 7 days.
-- Safe to run more than once. Only touches Hero Board (hb_) objects.

-- media = [{ "kind": "video", "key": "w12/….mp4", "type": "video/mp4", "size": 10284469, "name": "…" },
--          { "kind": "page",  "key": "w12/….jpg", "page": 1, "pages": 2, "name": "…pdf" }, …]
alter table public.hb_products add column if not exists media jsonb not null default '[]'::jsonb;

-- Which media keys a viewer may open (called only by the hb-media edge function with the service role)
create or replace function public.hb_media_keys(p_store_token uuid, p_week_token uuid, p_link_key uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare sid int; w public.hb_weeks; s public.hb_stores;
begin
  if p_store_token is not null then
    sid := public.hb_session_store(p_store_token);
    if sid is null then raise exception 'SESSION_EXPIRED'; end if;
    select * into s from public.hb_stores where id = sid;
    w := public.hb_current_week();
  else
    select * into w from public.hb_weeks where share_token = p_week_token and published;
    select * into s from public.hb_stores where link_key = p_link_key;
    if w.id is null or s.id is null then raise exception 'LINK_INVALID'; end if;
  end if;
  return jsonb_build_object(
    'store', jsonb_build_object('code', s.code, 'name', s.name),
    'keys', coalesce((select jsonb_agg(m->>'key') from public.hb_products p, jsonb_array_elements(p.media) m where p.week_id = w.id), '[]'::jsonb));
end $$;
revoke all on function public.hb_media_keys(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.hb_media_keys(uuid, uuid, uuid) to service_role;

-- Store and staff pages: include each product's media list
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
    'staff', coalesce((select json_agg(x order by x.acked_at desc) from (select employee_id, staff_name, acked_at from public.hb_staff_acks where week_id = w.id and store_id = sid) x), '[]'::json)
  );
end $$;

create or replace function public.hb_staff_view(p_week_token uuid, p_key uuid) returns json
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
    'products', coalesce((select json_agg(p order by p.sort, p.id) from (select name, description, price, photo_url, sort, id, slot, media from public.hb_products where week_id = w.id) p), '[]'::json)
  );
end $$;
