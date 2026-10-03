-- 양방향 카드: 영→한(expression_to_meaning) + 한→영(meaning_to_expression)
-- - 단어마다 방향별 카드 2장, FSRS 상태는 카드별로 따로.
-- - 새 단어는 영→한부터. 한→영은 짝 카드를 처음 학습한 다음 날부터 제공(같은 날 답 노출 방지).
-- - 하루 신규 한도는 '단어' 기준(그 단어의 첫 카드 학습 시점). 짝 카드는 한도에 포함하지 않음.

alter table public.user_settings add column if not exists directions text not null default 'both';
do $$ begin
  alter table public.user_settings add constraint user_settings_directions_check
    check (directions in ('both', 'expression_to_meaning', 'meaning_to_expression'));
exception when duplicate_object then null; end $$;

-- 새 항목이 생기면 영→한 카드를 자동 생성 (한→영 카드는 기존 함수들이 생성)
create or replace function public.create_reverse_card() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into cards (user_id, item_id, prompt_type) values (new.user_id, new.id, 'expression_to_meaning')
  on conflict (item_id, prompt_type) do nothing;
  return new;
end $$;
drop trigger if exists items_create_reverse_card on public.items;
create trigger items_create_reverse_card after insert on public.items
  for each row execute function public.create_reverse_card();

-- 기존 항목에도 영→한 카드 추가
insert into public.cards (user_id, item_id, prompt_type)
select user_id, id, 'expression_to_meaning' from public.items
on conflict (item_id, prompt_type) do nothing;

create index if not exists cards_item on public.cards (item_id);

-- 사용자 설정의 첫 학습 방향
create or replace function public.first_direction(p_directions text) returns text
language sql immutable as $$
  select case when p_directions = 'meaning_to_expression' then 'meaning_to_expression' else 'expression_to_meaning' end
$$;

-- 오늘(사용자 시간대) 처음 학습을 시작한 단어 수
create or replace function public.words_started_between(p_user uuid, p_from timestamptz, p_to timestamptz) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from (
    select item_id, min(introduced_at) as first_at from cards
    where user_id = p_user and introduced_at is not null
    group by item_id
  ) t where first_at >= p_from and first_at < p_to
$$;

-- 개인 표현 추가: 설정의 첫 방향 카드 id 반환 ('지금 학습'용)
create or replace function public.add_personal_item(
  p_request_id uuid, p_expression text, p_meaning text,
  p_example text default null, p_example_translation text default null,
  p_note text default null, p_source text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  v_collection uuid;
  v_item uuid;
  v_first text;
  v_card uuid;
begin
  if p_request_id is null then raise exception 'request_id_required' using errcode = '22023'; end if;
  if coalesce(btrim(p_expression), '') = '' then raise exception 'expression_required' using errcode = '22023'; end if;
  if coalesce(btrim(p_meaning), '') = '' then raise exception 'meaning_required' using errcode = '22023'; end if;

  perform public.ensure_user_setup();
  select public.first_direction(directions) into v_first from user_settings where user_id = uid;

  select id into v_item from items where user_id = uid and request_id = p_request_id;
  if not found then
    select id into v_collection from collections where user_id = uid and kind = 'personal';
    insert into items (user_id, collection_id, expression, meaning, example, example_translation, note, source, origin, request_id)
    values (uid, v_collection, btrim(p_expression), btrim(p_meaning),
            nullif(btrim(p_example), ''), nullif(btrim(p_example_translation), ''),
            nullif(btrim(p_note), ''), nullif(btrim(p_source), ''), 'personal', p_request_id)
    returning id into v_item;
    insert into cards (user_id, item_id, prompt_type) values (uid, v_item, 'meaning_to_expression')
      on conflict (item_id, prompt_type) do nothing;
  end if;

  select id into v_card from cards where item_id = v_item and prompt_type = v_first;
  return v_card;
end $$;

-- 오늘 학습 목록
-- 순서: 기한이 된 복습 → 어제까지 시작한 단어의 한→영 카드 → 새 단어(개인 표현 우선, 남은 한도만큼)
create or replace function public.get_study_queue(p_now timestamptz default now(), p_extra int default 0)
returns table (card_id uuid, kind text)
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  s user_settings%rowtype;
  v_start timestamptz;
  v_remaining int;
  v_personal int;
  v_first text;
begin
  select * into s from user_settings where user_id = uid;
  if not found then
    s.daily_new_limit := 30; s.personal_new_limit := 3; s.timezone := 'Asia/Seoul'; s.directions := 'both';
  end if;
  v_start := public.user_day_start(uid, p_now);
  v_first := public.first_direction(s.directions);

  v_remaining := case
    when s.new_paused_on = (p_now at time zone s.timezone)::date then 0
    else greatest(s.daily_new_limit - public.words_started_between(uid, v_start, v_start + interval '1 day'), 0)
  end + greatest(least(coalesce(p_extra, 0), 100), 0);
  v_personal := least(s.personal_new_limit, v_remaining);

  return query
  with due as (
    select c.id, c.due_at from cards c
    where c.user_id = uid and c.introduced_at is not null and c.suspended_at is null and c.due_at <= p_now
  ), started as (
    select c.item_id, min(c.introduced_at) as first_at from cards c
    where c.user_id = uid and c.introduced_at is not null group by c.item_id
  ), siblings as (
    select c.id, st.first_at from cards c join started st on st.item_id = c.item_id
    where s.directions = 'both' and c.user_id = uid and c.introduced_at is null and c.suspended_at is null
      and st.first_at < v_start
    order by st.first_at
    limit 500
  ), fresh as (
    select c.id, i.seq, col.kind as col_kind, col.is_active, col.created_at as col_created
    from cards c join items i on i.id = c.item_id join collections col on col.id = i.collection_id
    where c.user_id = uid and c.introduced_at is null and c.suspended_at is null and c.prompt_type = v_first
      and not exists (select 1 from started st where st.item_id = c.item_id)
  ), personal as (
    select f.id, f.seq from fresh f where f.col_kind = 'personal' order by f.seq limit v_personal
  ), other as (
    select f.id, f.col_created, f.seq from fresh f where f.col_kind = 'imported' and f.is_active
    order by f.col_created, f.seq
    limit greatest(v_remaining - (select count(*) from personal), 0)
  )
  select q.id, q.kind from (
    select d.id, 'review'::text as kind, 1 as grp, d.due_at as k1, 0::bigint as k2 from due d
    union all select sb.id, 'new', 2, sb.first_at, 0 from siblings sb
    union all select p.id, 'new', 3, null, p.seq from personal p
    union all select o.id, 'new', 4, o.col_created, o.seq from other o
  ) q
  order by q.grp, q.k1 nulls last, q.k2;
end $$;

-- 오늘 요약 (신규 = 단어 기준)
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
    'new_learned_today', public.words_started_between(uid, v_start, v_start + interval '1 day'),
    'daily_new_limit', coalesce(s.daily_new_limit, 30),
    'new_paused_today', coalesce(s.new_paused_on = (p_now at time zone coalesce(s.timezone, 'Asia/Seoul'))::date, false),
    'unlearned_total', (select count(*) from items i where i.user_id = uid
                      and not exists (select 1 from cards c where c.item_id = i.id and c.introduced_at is not null)),
    'next_due_at', (select min(due_at) from cards where user_id = uid and introduced_at is not null
                      and suspended_at is null and due_at > p_now),
    'day_start', v_start
  );
end $$;

-- 설정: 학습 방향 추가
create or replace function public.update_my_settings(
  p_daily_new_limit int, p_personal_new_limit int, p_desired_retention numeric, p_directions text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  s user_settings%rowtype;
begin
  if p_daily_new_limit is null or p_daily_new_limit not between 0 and 500 then
    raise exception 'daily_new_limit must be 0..500' using errcode = '22023'; end if;
  if p_personal_new_limit is null or p_personal_new_limit not between 0 and 500 then
    raise exception 'personal_new_limit must be 0..500' using errcode = '22023'; end if;
  if p_desired_retention is null or p_desired_retention not between 0.70 and 0.99 then
    raise exception 'desired_retention must be 0.70..0.99' using errcode = '22023'; end if;
  if p_directions is not null and p_directions not in ('both', 'expression_to_meaning', 'meaning_to_expression') then
    raise exception 'invalid directions' using errcode = '22023'; end if;
  perform public.ensure_user_setup();
  update user_settings set daily_new_limit = p_daily_new_limit, personal_new_limit = p_personal_new_limit,
    desired_retention = p_desired_retention, directions = coalesce(p_directions, directions), updated_at = now()
  where user_id = uid returning * into s;
  return to_jsonb(s);
end $$;

drop function if exists public.update_my_settings(int, int, numeric);

revoke execute on function public.create_reverse_card(), public.first_direction(text),
  public.words_started_between(uuid, timestamptz, timestamptz),
  public.update_my_settings(int, int, numeric, text) from public, anon;
grant execute on function public.update_my_settings(int, int, numeric, text),
  public.add_personal_item(uuid, text, text, text, text, text, text),
  public.get_study_queue(timestamptz, int), public.today_summary(timestamptz) to authenticated;
