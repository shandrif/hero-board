-- Hero Board patch 4: weekly Span of Control sync
-- Keeps hb_stores.area_manager / rom (from "UPDATED Span of control (Store Level).xlsx", sheet "New")
-- and city / region (from "Master_Location_Mapping.xlsx") up to date.
-- The weekly scheduled task calls public.hb_sync_span(...) with rows extracted by scripts/span_sync.py.
-- Safe to run more than once. Only touches Hero Board (hb_) objects; reads trackit_* tables once to seed aliases.

-- Branch code like "B04", "B4", "b 4", "HM B117 - ..." -> "B4"
create or replace function public.hb_norm_code(t text) returns text language sql immutable as $$
  select case when m is null then null else 'B' || (m::int)::text end
  from (select substring(upper(coalesce(t, '')) from '(?:^|[^A-Z])B\s*0*([0-9]{1,3})(?![0-9])') as m) x
$$;

-- Store / branch name -> comparison key: drops "HM", the branch code, "Main Storage", punctuation
create or replace function public.hb_norm_name(t text) returns text language sql immutable as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(upper(coalesce(t, '')), '^\s*HM\s+', ''),
             '^\s*B\s*[0-9]{1,3}\s*[-,–]?\s*', ''),
           '\s*(MAIN\s*)?STORA?G?E?\s*$', ''),
         '[^A-Z0-9]', '', 'g')
$$;

-- Known names for each branch (any spelling seen in the span file, Trackit or Hero Board)
create table if not exists public.hb_branch_alias (
  alias text primary key,
  branch_code text not null,
  source text not null default '',
  created_at timestamptz not null default now()
);
alter table public.hb_branch_alias enable row level security;
drop policy if exists hb_admin_all on public.hb_branch_alias;
create policy hb_admin_all on public.hb_branch_alias for all to authenticated using (public.hb_is_admin()) with check (public.hb_is_admin());

insert into public.hb_branch_alias(alias, branch_code, source)
select distinct on (public.hb_norm_name(name)) public.hb_norm_name(name), public.hb_norm_code(branch_code), 'hero board'
  from public.hb_stores where public.hb_norm_code(branch_code) is not null and public.hb_norm_name(name) <> ''
on conflict (alias) do nothing;
insert into public.hb_branch_alias(alias, branch_code, source)
select distinct on (public.hb_norm_name(branch)) public.hb_norm_name(branch), public.hb_norm_code(code), 'trackit map'
  from public.trackit_store_map where public.hb_norm_code(code) is not null and public.hb_norm_name(branch) <> ''
on conflict (alias) do nothing;
insert into public.hb_branch_alias(alias, branch_code, source)
select distinct on (public.hb_norm_name(a.alias)) public.hb_norm_name(a.alias), public.hb_norm_code(b.code), 'trackit alias'
  from public.trackit_branch_aliases a join public.trackit_branches b on b.id = a.branch_id
 where public.hb_norm_code(b.code) is not null and public.hb_norm_name(a.alias) <> ''
on conflict (alias) do nothing;

-- One row per sync run (dry runs too)
create table if not exists public.hb_sync_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  applied boolean not null,
  summary jsonb not null
);
alter table public.hb_sync_runs enable row level security;
drop policy if exists hb_admin_read on public.hb_sync_runs;
create policy hb_admin_read on public.hb_sync_runs for select to authenticated using (public.hb_is_admin());

-- p_span:      [{ "branch": "B48 - MAAN PLAZA", "area_manager": "...", "rom": "..." }, ...]
-- p_locations: [{ "code": "B48", "city": "Riyadh", "region": "Riyadh" }, ...]   (optional)
-- p_apply:     false = report only, true = update hb_stores
create or replace function public.hb_sync_span(p_span jsonb, p_locations jsonb default '[]'::jsonb, p_apply boolean default false)
returns jsonb language plpgsql set search_path = public as $$
declare
  rec record; v_code text; v_name_code text; v_txt_code text; v_store public.hb_stores; v_am text; v_rom text;
  changes jsonb := '[]'; unmatched jsonb := '[]'; notes jsonb := '[]'; seen text[] := '{}'; v_summary jsonb;
  n_rows int := 0; n_matched int := 0;
begin
  if jsonb_typeof(p_span) <> 'array' or jsonb_array_length(p_span) < 30 then
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
    select * into v_store from public.hb_stores s where public.hb_norm_code(s.branch_code) = v_code limit 1;
    if v_code is null or v_store.id is null then
      unmatched := unmatched || jsonb_build_object('branch', rec.branch, 'reason', case when v_code is null then 'branch not recognised' else format('%s is not a Hero Board store', v_code) end);
      continue;
    end if;
    if v_code = any(seen) then
      notes := notes || jsonb_build_object('branch', rec.branch, 'note', format('%s appears more than once in the file; kept the first row', v_code));
      continue;
    end if;
    seen := seen || v_code; n_matched := n_matched + 1;
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
    if p_apply and public.hb_norm_name(rec.branch) <> '' then   -- remember this spelling for next time
      insert into public.hb_branch_alias(alias, branch_code, source) values (public.hb_norm_name(rec.branch), v_code, 'span file') on conflict (alias) do nothing;
    end if;
  end loop;

  -- city / region from the master location mapping (only non-empty values)
  for rec in select * from jsonb_to_recordset(coalesce(p_locations, '[]'::jsonb)) as x(code text, city text, region text) loop
    v_store := null;
    select * into v_store from public.hb_stores s where public.hb_norm_code(s.branch_code) = public.hb_norm_code(rec.code) limit 1;
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
       from public.hb_stores s where public.hb_norm_code(s.branch_code) is null or not (public.hb_norm_code(s.branch_code) = any(seen))), '[]'));
  insert into public.hb_sync_runs(applied, summary) values (p_apply, v_summary);
  return v_summary;
end $$;

-- Only the scheduled task (database owner) may run it; not callable from the website
revoke all on function public.hb_sync_span(jsonb, jsonb, boolean) from public, anon, authenticated;
