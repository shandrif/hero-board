-- Hero Board patch 3: Morning / Evening hero layout for new weeks
-- New weeks hold four heroes: Morning drink + food, Evening drink + sweet.
-- Existing published weeks (e.g. week 45) keep their current simple list and are not changed.
-- Safe to run more than once. Only touches Hero Board (hb_) objects.

-- 1) Weeks: which layout a week uses. Existing weeks stay 'list'; every week created from now on is 'daypart'.
alter table public.hb_weeks add column if not exists layout text not null default 'list';
alter table public.hb_weeks alter column layout set default 'daypart';
do $$ begin
  alter table public.hb_weeks add constraint hb_weeks_layout_check check (layout in ('list', 'daypart'));
exception when duplicate_object then null; end $$;

-- Draft weeks that have no products yet (e.g. week 46) switch to the new layout.
update public.hb_weeks w set layout = 'daypart'
 where not w.published and w.layout <> 'daypart'
   and not exists (select 1 from public.hb_products p where p.week_id = w.id);

-- 2) Products: which slot a hero fills ('' = old-style list product).
alter table public.hb_products add column if not exists slot text not null default '';
do $$ begin
  alter table public.hb_products add constraint hb_products_slot_check check (slot in ('', 'am_drink', 'am_food', 'pm_drink', 'pm_sweet'));
exception when duplicate_object then null; end $$;
create unique index if not exists hb_products_week_slot on public.hb_products(week_id, slot) where slot <> '';

-- 3) Store and staff pages: include the slot with each product (same functions as before, plus "slot").
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
    'products', coalesce((select json_agg(p order by p.sort, p.id) from (select id, name, description, price, photo_url, sort, slot from public.hb_products where week_id = w.id) p), '[]'::json),
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
    'products', coalesce((select json_agg(p order by p.sort, p.id) from (select name, description, price, photo_url, sort, id, slot from public.hb_products where week_id = w.id) p), '[]'::json)
  );
end $$;
