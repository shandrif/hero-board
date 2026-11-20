-- Hero Board patch 9: pre-go-live hardening (from the full review). Safe to run more than once.

-- 1) Staff confirmation: one thing at a time, clean employee IDs, no errors on double taps,
--    clear errors when the week changed / the update closed, and a note when an ID was used under another name.
create or replace function public.hb_staff_confirm(p_key uuid, p_employee_id text, p_name text, p_week_id int, p_update_ids int[])
returns json language plpgsql security definer set search_path = public as $$
declare s public.hb_stores; w public.hb_weeks; e text; n text; uid int; ids int[]; done int[] := '{}'; week_done boolean := false; ex text; other_name text;
begin
  ids := array(select distinct x from unnest(coalesce(p_update_ids, '{}')) x where x is not null);
  if p_week_id is not null and coalesce(array_length(ids, 1), 0) > 0 then raise exception 'RELOAD'; end if;   -- hero products and updates are always confirmed separately
  if coalesce(array_length(ids, 1), 0) > 20 then raise exception 'Too many updates'; end if;
  select * into s from public.hb_stores where link_key = p_key;
  if s.id is null then raise exception 'LINK_INVALID'; end if;
  -- employee ID: Arabic digits -> 0-9, keep only letters and digits, upper case ("e-12 3" = "E123" = "e١٢٣")
  e := upper(regexp_replace(translate(coalesce(p_employee_id, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^A-Za-z0-9]', '', 'g'));
  n := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  if length(e) < 1 or length(e) > 20 or length(n) < 2 or length(n) > 80 then raise exception 'Please enter your name and Employee ID'; end if;
  perform pg_advisory_xact_lock(hashtext('hb_staff_confirm'), s.id);   -- one confirmation at a time per store (keeps the caps exact)
  w := public.hb_current_week();
  if p_week_id is not null then
    if w.id is distinct from p_week_id then raise exception 'WEEK_CHANGED'; end if;
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
  if coalesce(array_length(ids, 1), 0) > 0 and coalesce(array_length(done, 1), 0) = 0 then raise exception 'UPDATE_CLOSED'; end if;
  return json_build_object('name', n, 'employee_id', e, 'acked_at', now(), 'code', s.code, 'week', week_done, 'updates', to_json(done), 'other_name', other_name);
end $$;

-- 2) Managers can only acknowledge the week stores can currently see
create or replace function public.hb_store_ack(p_token uuid, p_week_id integer) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare sid int := public.hb_session_store(p_token); t timestamptz;
begin
  if sid is null then raise exception 'SESSION_EXPIRED'; end if;
  if p_week_id is distinct from (public.hb_current_week()).id then raise exception 'WEEK_CHANGED'; end if;
  insert into public.hb_store_acks(week_id, store_id) values (p_week_id, sid) on conflict do nothing;
  select acked_at into t from public.hb_store_acks where week_id = p_week_id and store_id = sid;
  return t;
end $$;

-- 3) Store login: lock the store row so parallel guesses can't slip past the 5-tries limit
create or replace function public.hb_store_login(p_code text, p_password text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare s public.hb_stores; t uuid;
begin
  select * into s from public.hb_stores where upper(code) = upper(btrim(p_code)) for update;
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

-- 4) Staff links can't open media of managers-only updates
create or replace function public.hb_media_keys(p_store_token uuid, p_week_token uuid, p_link_key uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare sid int; w public.hb_weeks; s public.hb_stores; is_mgr boolean := p_store_token is not null;
begin
  if is_mgr then
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
        select m->>'key' from public.hb_open_updates(s.id) u, jsonb_array_elements(u.media) m where is_mgr or u.require_staff) x), '[]'::jsonb));
end $$;
revoke all on function public.hb_media_keys(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.hb_media_keys(uuid, uuid, uuid) to service_role;

-- 5) Publish times come from the database clock, never the admin's computer
alter table public.hb_updates drop constraint if exists hb_updates_pub_chk;
alter table public.hb_updates add constraint hb_updates_pub_chk check (not published or (published_at is not null and closes_at is not null));
create or replace function public.hb_set_pub_ts() returns trigger language plpgsql set search_path = public as $$
begin
  if new.published and not coalesce(old.published, false) then
    if tg_table_name = 'hb_weeks' then new.published_at := coalesce(old.published_at, now());   -- re-publishing keeps the first time
    else new.published_at := now(); new.closes_at := now() + interval '7 days'; end if;
  end if;
  return new;
end $$;
drop trigger if exists hb_weeks_pub on public.hb_weeks;
drop trigger if exists hb_updates_pub on public.hb_updates;
create trigger hb_weeks_pub before update on public.hb_weeks for each row execute function public.hb_set_pub_ts();
create trigger hb_updates_pub before update on public.hb_updates for each row execute function public.hb_set_pub_ts();

-- 6) Admin: give a store a new staff link (old links stop working, e.g. after a leaver)
create or replace function public.hb_admin_rotate_link(p_store_id int) returns uuid
language plpgsql security definer set search_path = public as $$
declare k uuid := gen_random_uuid();
begin
  if not public.hb_is_admin() then raise exception 'Not allowed'; end if;
  update public.hb_stores set link_key = k where id = p_store_id;
  if not found then raise exception 'Store not found'; end if;
  return k;
end $$;
revoke all on function public.hb_admin_rotate_link(int) from public, anon;
grant execute on function public.hb_admin_rotate_link(int) to authenticated;

-- 7) Old confirmation functions (replaced by hb_staff_page / hb_staff_confirm)
drop function if exists public.hb_staff_ack(uuid, uuid, text, text);
drop function if exists public.hb_staff_view(uuid, uuid);

-- 8) Defence in depth: anonymous visitors use only the functions above, never the tables directly
revoke all on public.hb_admins, public.hb_stores, public.hb_store_sessions, public.hb_weeks, public.hb_products,
  public.hb_store_acks, public.hb_staff_acks, public.hb_updates, public.hb_update_store_acks, public.hb_update_staff_acks,
  public.hb_branch_alias, public.hb_sync_runs from anon;
revoke all on function public.hb_admin_update_counts(int[]) from public, anon;
grant execute on function public.hb_admin_update_counts(int[]) to authenticated;
revoke all on function public.hb_update_targets(public.hb_updates, public.hb_stores) from public, anon;
revoke all on function public.hb_norm_code(text), public.hb_norm_name(text) from public, anon;
alter function public.hb_norm_code(text) set search_path = pg_catalog;
alter function public.hb_norm_name(text) set search_path = pg_catalog;

-- 9) Indexes for deletes and session clean-up
create index if not exists hb_store_acks_store on public.hb_store_acks(store_id);
create index if not exists hb_staff_acks_store on public.hb_staff_acks(store_id);
create index if not exists hb_update_store_acks_store on public.hb_update_store_acks(store_id);
create index if not exists hb_update_staff_acks_store on public.hb_update_staff_acks(store_id);
create index if not exists hb_store_sessions_exp on public.hb_store_sessions(expires_at);
create index if not exists hb_updates_open on public.hb_updates(closes_at) where published;

-- 10) Weekly sync safety: null/odd input refused, aliases learned only when the file's code agrees,
--     a file matching under 80% of stores changes nothing, "STORE" stripped only as a separate word.
create or replace function public.hb_norm_name(t text) returns text language sql immutable set search_path = pg_catalog as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(upper(coalesce(t, '')), '^\s*HM\s+', ''),
             '^\s*B\s*[0-9]{1,3}\s*[-,–]?\s*', ''),
           '\s+(MAIN\s*)?STORA?G?E?\s*$', ''),
         '[^A-Z0-9]', '', 'g')
$$;
revoke all on function public.hb_norm_name(text) from public, anon;
create or replace function public.hb_sync_span(p_span jsonb, p_locations jsonb default '[]'::jsonb, p_apply boolean default false)
returns jsonb language plpgsql set search_path = public as $$
declare
  rec record; v_code text; v_name_code text; v_txt_code text; v_store public.hb_stores; v_am text; v_rom text;
  changes jsonb := '[]'; unmatched jsonb := '[]'; notes jsonb := '[]'; seen text[] := '{}'; v_summary jsonb;
  n_rows int := 0; n_matched int := 0;
begin
  if p_span is null or jsonb_typeof(p_span) <> 'array' or jsonb_array_length(p_span) < 30 then
    raise exception 'REFUSED: span has % rows; expected the full store list', coalesce(jsonb_array_length(p_span), 0);
  end if;

  for rec in select * from jsonb_to_recordset(p_span) as x(branch text, area_manager text, rom text) loop
    n_rows := n_rows + 1;
    v_txt_code := public.hb_norm_code(rec.branch);
    v_name_code := null;
    select branch_code into v_name_code from public.hb_branch_alias where alias = public.hb_norm_name(rec.branch);
    v_code := coalesce(v_name_code, v_txt_code);           -- the name wins over a mistyped code
    if v_name_code is not null and v_txt_code is not null and v_name_code <> v_txt_code then
      notes := notes || jsonb_build_object('branch', rec.branch, 'note', format('code in file is %s but the name belongs to %s; used %s', v_txt_code, v_name_code, v_name_code));
    end if;
    v_store := null;
    select * into v_store from public.hb_stores s where coalesce(public.hb_norm_code(s.branch_code), public.hb_norm_code(s.name)) = v_code limit 1;
    if v_code is null or v_store.id is null then
      unmatched := unmatched || jsonb_build_object('branch', rec.branch, 'reason', case when v_code is null then 'branch not recognised' else format('%s is not a Hero Board store', v_code) end);
      continue;
    end if;
    if v_code = any(seen) then
      notes := notes || jsonb_build_object('branch', rec.branch, 'note', format('%s appears more than once in the file; kept the first row', v_code));
      continue;
    end if;
    seen := seen || v_code; n_matched := n_matched + 1;
    if p_apply and coalesce(v_store.branch_code, '') = '' then
      update public.hb_stores set branch_code = v_code where id = v_store.id;
      changes := changes || jsonb_build_object('store', v_store.code, 'name', v_store.name, 'field', 'branch_code', 'from', '', 'to', v_code);
    end if;
    v_am := upper(regexp_replace(btrim(coalesce(rec.area_manager, '')), '\s+', ' ', 'g'));
    v_rom := upper(regexp_replace(btrim(coalesce(rec.rom, '')), '\s+', ' ', 'g'));
    if v_am <> '' and v_am is distinct from v_store.area_manager then
      changes := changes || jsonb_build_object('store', v_store.code, 'name', v_store.name, 'field', 'area_manager', 'from', v_store.area_manager, 'to', v_am);
      if p_apply then update public.hb_stores set area_manager = v_am where id = v_store.id; end if;
    end if;
    if v_rom <> '' and v_rom is distinct from v_store.rom then
      changes := changes || jsonb_build_object('store', v_store.code, 'name', v_store.name, 'field', 'rom', 'from', v_store.rom, 'to', v_rom);
      if p_apply then update public.hb_stores set rom = v_rom where id = v_store.id; end if;
    end if;
    -- learn a new spelling only when the code written in the file agrees with the match (never lock in a typo)
    if p_apply and public.hb_norm_name(rec.branch) <> '' and v_txt_code is not null and v_txt_code = v_code then
      insert into public.hb_branch_alias(alias, branch_code, source) values (public.hb_norm_name(rec.branch), v_code, 'span file') on conflict (alias) do nothing;
    end if;
  end loop;

  -- city / region from the master location mapping (only non-empty values)
  for rec in select * from jsonb_to_recordset(coalesce(p_locations, '[]'::jsonb)) as x(code text, city text, region text) loop
    v_store := null;
    select * into v_store from public.hb_stores s where coalesce(public.hb_norm_code(s.branch_code), public.hb_norm_code(s.name)) = public.hb_norm_code(rec.code) limit 1;
    if v_store.id is null then continue; end if;
    if btrim(coalesce(rec.city, '')) <> '' and btrim(rec.city) is distinct from v_store.city then
      changes := changes || jsonb_build_object('store', v_store.code, 'name', v_store.name, 'field', 'city', 'from', v_store.city, 'to', btrim(rec.city));
      if p_apply then update public.hb_stores set city = btrim(rec.city) where id = v_store.id; end if;
    end if;
    if btrim(coalesce(rec.region, '')) <> '' and btrim(rec.region) is distinct from v_store.region then
      changes := changes || jsonb_build_object('store', v_store.code, 'name', v_store.name, 'field', 'region', 'from', v_store.region, 'to', btrim(rec.region));
      if p_apply then update public.hb_stores set region = btrim(rec.region) where id = v_store.id; end if;
    end if;
  end loop;

  v_summary := jsonb_build_object(
    'applied', p_apply, 'span_rows', n_rows, 'stores_matched', n_matched,
    'changes', changes, 'not_matched', unmatched, 'notes', notes,
    'stores_not_in_span', coalesce((select jsonb_agg(jsonb_build_object('store', s.code, 'name', s.name) order by s.code)
       from public.hb_stores s where coalesce(public.hb_norm_code(s.branch_code), public.hb_norm_code(s.name)) is null or not (coalesce(public.hb_norm_code(s.branch_code), public.hb_norm_code(s.name)) = any(seen))), '[]'));
  if p_apply and n_matched < 0.8 * (select count(*) from public.hb_stores) then
    raise exception 'REFUSED: only % of % stores matched the file; nothing was changed', n_matched, (select count(*) from public.hb_stores);
  end if;
  insert into public.hb_sync_runs(applied, summary) values (p_apply, v_summary);
  return v_summary;
end $$;

revoke all on function public.hb_sync_span(jsonb, jsonb, boolean) from public, anon, authenticated;
