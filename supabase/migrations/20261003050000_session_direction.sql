-- 학습 시작 시 방향 선택: get_study_queue에 p_direction 추가
-- p_direction = null(섞어서): 기존 동작 (복습 전체, 새 단어는 영→한부터, 짝 카드는 다음 날부터)
-- p_direction = 'expression_to_meaning' | 'meaning_to_expression':
--   그 방향 복습만, 새 단어는 그 방향 카드로 시작, 그 방향의 짝 카드(어제까지 시작한 단어)도 제공.
-- 신규 한도는 방향과 관계없이 '단어' 기준으로 공유한다.

drop function if exists public.get_study_queue(timestamptz, int);

create or replace function public.get_study_queue(
  p_now timestamptz default now(), p_extra int default 0, p_direction text default null
) returns table (card_id uuid, kind text)
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  s user_settings%rowtype;
  v_start timestamptz;
  v_remaining int;
  v_personal int;
  v_first text;
  v_siblings boolean;
begin
  if p_direction is not null and p_direction not in ('expression_to_meaning', 'meaning_to_expression') then
    raise exception 'invalid direction' using errcode = '22023';
  end if;
  select * into s from user_settings where user_id = uid;
  if not found then
    s.daily_new_limit := 30; s.personal_new_limit := 3; s.timezone := 'Asia/Seoul'; s.directions := 'both';
  end if;
  v_start := public.user_day_start(uid, p_now);
  v_first := coalesce(p_direction, public.first_direction(s.directions));
  v_siblings := p_direction is not null or s.directions = 'both';

  v_remaining := case
    when s.new_paused_on = (p_now at time zone s.timezone)::date then 0
    else greatest(s.daily_new_limit - public.words_started_between(uid, v_start, v_start + interval '1 day'), 0)
  end + greatest(least(coalesce(p_extra, 0), 100), 0);
  v_personal := least(s.personal_new_limit, v_remaining);

  return query
  with due as (
    select c.id, c.due_at from cards c
    where c.user_id = uid and c.introduced_at is not null and c.suspended_at is null and c.due_at <= p_now
      and (p_direction is null or c.prompt_type = p_direction)
  ), started as (
    select c.item_id, min(c.introduced_at) as first_at from cards c
    where c.user_id = uid and c.introduced_at is not null group by c.item_id
  ), siblings as (
    select c.id, st.first_at from cards c join started st on st.item_id = c.item_id
    where v_siblings and c.user_id = uid and c.introduced_at is null and c.suspended_at is null
      and st.first_at < v_start
      and (p_direction is null or c.prompt_type = p_direction)
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

-- 오늘 요약에 방향별 복습 수 추가
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
    'due_by_direction', jsonb_build_object(
      'expression_to_meaning', (select count(*) from cards where user_id = uid and introduced_at is not null
                      and suspended_at is null and due_at <= p_now and prompt_type = 'expression_to_meaning'),
      'meaning_to_expression', (select count(*) from cards where user_id = uid and introduced_at is not null
                      and suspended_at is null and due_at <= p_now and prompt_type = 'meaning_to_expression')),
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

revoke execute on function public.get_study_queue(timestamptz, int, text) from public, anon;
grant execute on function public.get_study_queue(timestamptz, int, text), public.today_summary(timestamptz) to authenticated;
