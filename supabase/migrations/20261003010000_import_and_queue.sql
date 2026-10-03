-- CSV 가져오기 + 오늘 학습 목록(일일 신규 한도, 개인 표현 우선 배정)

-- 등록 순서 보존용 (같은 트랜잭션에서 만든 항목은 created_at이 같다)
alter table public.items add column if not exists seq bigint generated always as identity;
create index if not exists items_user_seq on public.items (user_id, seq);

-- '오늘 신규 학습 쉬기': 이 날짜(사용자 시간대)에는 신규 카드를 배정하지 않는다
alter table public.user_settings add column if not exists new_paused_on date;

-- 가져오기 요청 기록 (같은 request_id 재전송 시 결과만 반환)
create table if not exists public.import_requests (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  collection_id uuid references public.collections (id) on delete set null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.import_requests enable row level security;
drop policy if exists own_select on public.import_requests;
create policy own_select on public.import_requests for select to authenticated using (user_id = auth.uid());
revoke all on public.import_requests from anon, authenticated;
grant select on public.import_requests to authenticated;
grant select on public.import_requests to service_role;

-- 정규화 (items.normalized_expression 과 같은 규칙)
create or replace function public.normalize_expression(p text) returns text
language sql immutable as $$ select lower(regexp_replace(btrim(p), '\s+', ' ', 'g')) $$;

-- 여러 표현의 기존 중복 후보를 한 번에 조회 (CSV 미리보기용)
create or replace function public.find_existing_duplicates(p_expressions text[])
returns table (normalized text, expression text, meaning text, collection_name text)
language sql stable security definer set search_path = public as $$
  select i.normalized_expression, i.expression, i.meaning, c.name
  from items i join collections c on c.id = i.collection_id
  where i.user_id = public.require_user()
    and i.normalized_expression in (select public.normalize_expression(x) from unnest(p_expressions) x)
  order by i.seq
  limit 5000
$$;

-- CSV 가져오기: 새 모음집 + 항목 + 미학습 카드를 한 트랜잭션으로 생성.
-- p_rows: [{row, expression, meaning, example, example_translation, note, source}, ...]
-- 서버에서도 같은 검사를 하고, 통과하지 못한 행은 이유와 함께 돌려준다.
create or replace function public.import_items(p_request_id uuid, p_collection_name text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  v_prev jsonb;
  v_collection uuid;
  v_inserted int;
  v_errors jsonb;
  v_result jsonb;
begin
  if p_request_id is null then raise exception 'request_id_required' using errcode = '22023'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'rows_must_be_array' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'too_many_rows' using errcode = '22023'; end if;
  if coalesce(btrim(p_collection_name), '') = '' or length(btrim(p_collection_name)) > 100 then
    raise exception 'invalid_collection_name' using errcode = '22023';
  end if;

  -- 같은 요청 동시 실행 방지 + 재전송 처리
  perform pg_advisory_xact_lock(hashtext(p_request_id::text));
  select result into v_prev from import_requests where id = p_request_id and user_id = uid;
  if found then return v_prev || jsonb_build_object('duplicate_request', true); end if;

  perform public.ensure_user_setup();

  create temp table _rows on commit drop as
  select coalesce((r->>'row')::int, ord::int) as row_no,
         btrim(coalesce(r->>'expression', '')) as expression,
         btrim(coalesce(r->>'meaning', '')) as meaning,
         nullif(btrim(coalesce(r->>'example', '')), '') as example,
         nullif(btrim(coalesce(r->>'example_translation', '')), '') as example_translation,
         nullif(btrim(coalesce(r->>'note', '')), '') as note,
         nullif(btrim(coalesce(r->>'source', '')), '') as source,
         ord
  from jsonb_array_elements(p_rows) with ordinality as t(r, ord);

  alter table _rows add column error text;
  update _rows set error = case
    when expression = '' then 'expression 비어 있음'
    when meaning = '' then 'meaning 비어 있음'
    when length(expression) > 300 then 'expression 300자 초과'
    when length(meaning) > 1000 then 'meaning 1000자 초과'
    when length(coalesce(example, '')) > 2000 then 'example 2000자 초과'
    when length(coalesce(example_translation, '')) > 2000 then 'example_translation 2000자 초과'
    when length(coalesce(note, '')) > 2000 then 'note 2000자 초과'
    when length(coalesce(source, '')) > 300 then 'source 300자 초과'
  end;

  select coalesce(jsonb_agg(jsonb_build_object('row', row_no, 'reason', error) order by ord), '[]'::jsonb)
    into v_errors from _rows where error is not null;

  insert into collections (user_id, name, kind) values (uid, btrim(p_collection_name), 'imported')
    returning id into v_collection;

  with ins as (
    insert into items (user_id, collection_id, expression, meaning, example, example_translation, note, source, origin)
    select uid, v_collection, expression, meaning, example, example_translation, note, source, 'import'
    from _rows where error is null order by ord
    returning id
  ), c as (
    insert into cards (user_id, item_id) select uid, id from ins returning 1
  )
  select count(*) into v_inserted from c;

  v_result := jsonb_build_object('collection_id', v_collection, 'inserted', v_inserted, 'errors', v_errors);
  insert into import_requests (id, user_id, collection_id, result) values (p_request_id, uid, v_collection, v_result);
  return v_result;
end $$;

-- 오늘 신규 학습 쉬기 켜기/끄기
create or replace function public.set_new_paused_today(p_paused boolean, p_now timestamptz default now())
returns void
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  v_tz text;
begin
  perform public.ensure_user_setup();
  select timezone into v_tz from user_settings where user_id = uid;
  update user_settings
    set new_paused_on = case when p_paused then (p_now at time zone v_tz)::date else null end,
        updated_at = now()
  where user_id = uid;
end $$;

-- 오늘 학습 목록: 기한이 된 복습(기한 순) → 신규 카드(개인 표현 우선, 남은 한도만큼).
-- p_extra: 한도에 도달한 뒤 사용자가 명시적으로 고른 추가 신규 학습 수.
create or replace function public.get_study_queue(p_now timestamptz default now(), p_extra int default 0)
returns table (card_id uuid, kind text)
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  s user_settings%rowtype;
  v_start timestamptz;
  v_learned int;
  v_remaining int;
  v_personal int;
begin
  select * into s from user_settings where user_id = uid;
  if not found then
    s.daily_new_limit := 10; s.personal_new_limit := 3; s.timezone := 'Asia/Seoul';
  end if;
  v_start := public.user_day_start(uid, p_now);

  select count(*) into v_learned from review_events
  where user_id = uid and is_introduction and reverted_at is null
    and reviewed_at >= v_start and reviewed_at < v_start + interval '1 day';

  v_remaining := case
    when s.new_paused_on = (p_now at time zone s.timezone)::date then 0
    else greatest(s.daily_new_limit - v_learned, 0)
  end + greatest(least(coalesce(p_extra, 0), 100), 0);
  v_personal := least(s.personal_new_limit, v_remaining);

  return query
  with due as (
    select c.id, c.due_at from cards c
    where c.user_id = uid and c.introduced_at is not null and c.suspended_at is null and c.due_at <= p_now
  ), personal as (
    select c.id, i.seq from cards c join items i on i.id = c.item_id join collections col on col.id = i.collection_id
    where c.user_id = uid and c.introduced_at is null and c.suspended_at is null and col.kind = 'personal'
    order by i.seq limit v_personal
  ), other as (
    select c.id, col.created_at, i.seq from cards c join items i on i.id = c.item_id join collections col on col.id = i.collection_id
    where c.user_id = uid and c.introduced_at is null and c.suspended_at is null
      and col.kind = 'imported' and col.is_active
    order by col.created_at, i.seq
    limit greatest(v_remaining - (select count(*) from personal), 0)
  )
  select q.id, q.kind from (
    select d.id, 'review'::text as kind, 1 as grp, d.due_at as k1, 0::bigint as k2 from due d
    union all select p.id, 'new', 2, null, p.seq from personal p
    union all select o.id, 'new', 3, o.created_at, o.seq from other o
  ) q
  order by q.grp, q.k1 nulls last, q.k2;
end $$;

-- 오늘 요약에 목표·쉬기 상태 추가
create or replace function public.today_summary(p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  v_start timestamptz := public.user_day_start(uid, p_now);
  s user_settings%rowtype;
begin
  select * into s from user_settings where user_id = uid;
  return jsonb_build_object(
    'due_reviews', (select count(*) from cards where user_id = uid and introduced_at is not null
                      and suspended_at is null and due_at <= p_now),
    'overdue_reviews', (select count(*) from cards where user_id = uid and introduced_at is not null
                      and suspended_at is null and due_at < v_start),
    'new_learned_today', (select count(*) from review_events where user_id = uid and is_introduction
                      and reverted_at is null and reviewed_at >= v_start and reviewed_at < v_start + interval '1 day'),
    'daily_new_limit', coalesce(s.daily_new_limit, 10),
    'new_paused_today', coalesce(s.new_paused_on = (p_now at time zone coalesce(s.timezone, 'Asia/Seoul'))::date, false),
    'unlearned_total', (select count(*) from cards where user_id = uid and introduced_at is null and suspended_at is null),
    'next_due_at', (select min(due_at) from cards where user_id = uid and introduced_at is not null
                      and suspended_at is null and due_at > p_now),
    'day_start', v_start
  );
end $$;

revoke execute on function public.normalize_expression(text), public.find_existing_duplicates(text[]),
  public.import_items(uuid, text, jsonb), public.set_new_paused_today(boolean, timestamptz),
  public.get_study_queue(timestamptz, int) from public, anon;
grant execute on function public.find_existing_duplicates(text[]), public.import_items(uuid, text, jsonb),
  public.set_new_paused_today(boolean, timestamptz), public.get_study_queue(timestamptz, int),
  public.today_summary(timestamptz) to authenticated;
