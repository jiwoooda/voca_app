-- 영어 표현 학습 앱 초기 스키마
-- 학습 항목(items) / 학습 카드(cards) / 복습 이벤트(review_events)를 분리한다.
-- 카드 상태 변경은 클라이언트가 직접 할 수 없고, 아래 함수로만 가능하다.

create extension if not exists pgcrypto;

-- ───────────────────────── 테이블 ─────────────────────────

create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  daily_new_limit int not null default 10 check (daily_new_limit between 0 and 500),
  personal_new_limit int not null default 3 check (personal_new_limit between 0 and 500),
  desired_retention numeric(4, 3) not null default 0.90 check (desired_retention between 0.70 and 0.99),
  timezone text not null default 'Asia/Seoul',
  updated_at timestamptz not null default now()
);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  kind text not null default 'imported' check (kind in ('personal', 'imported')),
  is_active boolean not null default true, -- '학습 중' 선택 (신규 카드 공급 대상)
  created_at timestamptz not null default now()
);
-- 사용자당 '내 표현' 모음집은 하나
create unique index collections_one_personal on public.collections (user_id) where kind = 'personal';

create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  collection_id uuid not null references public.collections (id) on delete cascade,
  expression text not null check (length(btrim(expression)) between 1 and 300),
  meaning text not null check (length(btrim(meaning)) between 1 and 1000),
  example text check (example is null or length(example) <= 2000),
  example_translation text check (example_translation is null or length(example_translation) <= 2000),
  note text check (note is null or length(note) <= 2000),
  source text check (source is null or length(source) <= 300),
  origin text not null check (origin in ('import', 'personal')),
  -- 중복 '후보' 검색용. 같은 값이라도 자동 병합하지 않는다.
  normalized_expression text generated always as (
    lower(regexp_replace(btrim(expression), '\s+', ' ', 'g'))
  ) stored,
  request_id uuid, -- 재전송으로 인한 중복 생성 방지
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, request_id)
);
create index items_user_norm on public.items (user_id, normalized_expression);
create index items_collection on public.items (collection_id);

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id uuid not null references public.items (id) on delete cascade,
  -- 'meaning_to_expression' = 한국어 뜻을 보고 영어 표현 떠올리기 (첫 버전 유일한 방식)
  prompt_type text not null default 'meaning_to_expression'
    check (prompt_type in ('meaning_to_expression', 'expression_to_meaning')),
  introduced_at timestamptz,        -- 처음 학습한 시각. null = 미학습
  suspended_at timestamptz,         -- 보류 시각. FSRS 단계와 별개
  due_at timestamptz not null default now(),
  -- ts-fsrs 5.4.2 Card 필드
  stability double precision not null default 0,
  difficulty double precision not null default 0,
  elapsed_days int not null default 0,     -- ts-fsrs에서 deprecated, 호환을 위해 보관
  scheduled_days int not null default 0,
  learning_steps int not null default 0,
  reps int not null default 0,
  lapses int not null default 0,
  state smallint not null default 0 check (state between 0 and 3), -- 0 New,1 Learning,2 Review,3 Relearning
  last_review_at timestamptz,
  version int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, prompt_type)
);
create index cards_due on public.cards (user_id, due_at) where introduced_at is not null and suspended_at is null;
create index cards_new on public.cards (user_id, created_at) where introduced_at is null and suspended_at is null;

create table public.review_events (
  id uuid primary key,              -- 클라이언트 request_id. 재전송 시 중복 생성 방지
  user_id uuid not null references auth.users (id) on delete cascade,
  card_id uuid not null references public.cards (id) on delete cascade,
  reviewed_at timestamptz not null, -- 서버가 결정한 평가 시각
  rating smallint not null check (rating between 1 and 4),
  before_state jsonb not null,
  after_state jsonb not null,
  is_introduction boolean not null, -- 이 평가로 처음 학습이 시작됐는지 (신규 학습 집계)
  card_version_after int not null,
  predicted_retrievability double precision, -- 계산 불가(새 카드)면 null
  response_ms int check (response_ms is null or response_ms between 0 and 3600000),
  scheduler_version text not null,
  parameters_snapshot jsonb not null,
  desired_retention numeric(4, 3) not null,
  reverted_at timestamptz
);
create index review_events_card on public.review_events (card_id, reviewed_at desc);
create index review_events_user_time on public.review_events (user_id, reviewed_at);

-- ───────────────────────── RLS ─────────────────────────
-- 읽기는 본인 행만. 쓰기는 아래 함수(security definer)로만.

alter table public.user_settings enable row level security;
alter table public.collections enable row level security;
alter table public.items enable row level security;
alter table public.cards enable row level security;
alter table public.review_events enable row level security;

create policy own_select on public.user_settings for select to authenticated using (user_id = auth.uid());
create policy own_select on public.collections for select to authenticated using (user_id = auth.uid());
create policy own_select on public.items for select to authenticated using (user_id = auth.uid());
create policy own_select on public.cards for select to authenticated using (user_id = auth.uid());
create policy own_select on public.review_events for select to authenticated using (user_id = auth.uid());

revoke all on public.user_settings, public.collections, public.items, public.cards, public.review_events from anon, authenticated;
grant select on public.user_settings, public.collections, public.items, public.cards, public.review_events to authenticated;
-- Edge Function(service_role)은 카드·설정 조회에 필요. '새 테이블 자동 노출'을 꺼도 동작하도록 명시.
grant select on public.user_settings, public.collections, public.items, public.cards, public.review_events to service_role;

-- ───────────────────────── 공통 ─────────────────────────

create or replace function public.require_user() returns uuid
language plpgsql stable as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  return uid;
end $$;

-- 로그인 직후 호출. 설정과 '내 표현' 모음집을 보장한다 (여러 번 호출해도 안전).
create or replace function public.ensure_user_setup() returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := public.require_user();
begin
  insert into user_settings (user_id) values (uid) on conflict do nothing;
  insert into collections (user_id, name, kind) values (uid, '내 표현', 'personal')
    on conflict (user_id) where kind = 'personal' do nothing;
end $$;

-- 사용자 시간대 기준 '오늘' 시작 시각 (UTC timestamptz)
create or replace function public.user_day_start(p_user uuid, p_now timestamptz) returns timestamptz
language sql stable security definer set search_path = public as $$
  select (date_trunc('day', p_now at time zone tz) at time zone tz)
  from (select coalesce((select timezone from user_settings where user_id = p_user), 'Asia/Seoul') as tz) s
$$;

-- ───────────────────────── 등록 ─────────────────────────

-- 중복 후보 (자동 병합하지 않음, 화면에 보여주기만 함)
create or replace function public.find_duplicate_candidates(p_expression text)
returns table (item_id uuid, expression text, meaning text, collection_name text)
language sql stable security definer set search_path = public as $$
  select i.id, i.expression, i.meaning, c.name
  from items i join collections c on c.id = i.collection_id
  where i.user_id = public.require_user()
    and i.normalized_expression = lower(regexp_replace(btrim(p_expression), '\s+', ' ', 'g'))
  order by i.created_at
  limit 20
$$;

-- 개인 표현 추가: 항목 + 미학습 카드를 한 트랜잭션으로 생성
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
begin
  if p_request_id is null then raise exception 'request_id_required' using errcode = '22023'; end if;
  if coalesce(btrim(p_expression), '') = '' then raise exception 'expression_required' using errcode = '22023'; end if;
  if coalesce(btrim(p_meaning), '') = '' then raise exception 'meaning_required' using errcode = '22023'; end if;

  -- 같은 요청이 이미 처리됐으면 그 결과를 돌려준다
  select id into v_item from items where user_id = uid and request_id = p_request_id;
  if found then
    select c.id into v_item from cards c where c.item_id = v_item;
    return v_item;
  end if;

  perform public.ensure_user_setup();
  select id into v_collection from collections where user_id = uid and kind = 'personal';

  insert into items (user_id, collection_id, expression, meaning, example, example_translation, note, source, origin, request_id)
  values (uid, v_collection, btrim(p_expression), btrim(p_meaning),
          nullif(btrim(p_example), ''), nullif(btrim(p_example_translation), ''),
          nullif(btrim(p_note), ''), nullif(btrim(p_source), ''), 'personal', p_request_id)
  returning id into v_item;

  insert into cards (user_id, item_id) values (uid, v_item) returning id into v_item;
  return v_item; -- card id
end $$;

-- ───────────────────────── 복습 저장 ─────────────────────────
-- FSRS 계산은 Edge Function(ts-fsrs)이 서버 시각으로 수행하고,
-- 이 함수는 버전 확인 + 행 잠금 + 카드 갱신 + 이벤트 기록을 하나의 트랜잭션으로 처리한다.
-- service_role 전용 (브라우저에서 직접 호출 불가).
create or replace function public.apply_review(
  p_user_id uuid, p_card_id uuid, p_request_id uuid, p_expected_version int,
  p_rating smallint, p_reviewed_at timestamptz,
  p_before jsonb, p_after jsonb,
  p_predicted_retrievability double precision, p_response_ms int,
  p_scheduler_version text, p_parameters jsonb, p_desired_retention numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_card cards%rowtype;
  v_event review_events%rowtype;
  v_intro boolean;
begin
  select * into v_card from cards where id = p_card_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;

  -- 이미 처리된 요청이면 같은 결과를 반환 (이벤트 추가 없음)
  select * into v_event from review_events where id = p_request_id;
  if found then
    if v_event.user_id <> p_user_id or v_event.card_id <> p_card_id then
      return jsonb_build_object('status', 'request_id_conflict');
    end if;
    return jsonb_build_object('status', 'duplicate', 'card', to_jsonb(v_card), 'event_id', v_event.id);
  end if;

  if v_card.version <> p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'card', to_jsonb(v_card));
  end if;
  if v_card.suspended_at is not null then
    return jsonb_build_object('status', 'suspended', 'card', to_jsonb(v_card));
  end if;

  v_intro := v_card.introduced_at is null;

  update cards set
    introduced_at  = coalesce(introduced_at, p_reviewed_at),
    due_at         = (p_after->>'due')::timestamptz,
    stability      = (p_after->>'stability')::double precision,
    difficulty     = (p_after->>'difficulty')::double precision,
    elapsed_days   = (p_after->>'elapsed_days')::int,
    scheduled_days = (p_after->>'scheduled_days')::int,
    learning_steps = (p_after->>'learning_steps')::int,
    reps           = (p_after->>'reps')::int,
    lapses         = (p_after->>'lapses')::int,
    state          = (p_after->>'state')::smallint,
    last_review_at = (p_after->>'last_review')::timestamptz,
    version        = version + 1,
    updated_at     = now()
  where id = p_card_id
  returning * into v_card;

  insert into review_events (id, user_id, card_id, reviewed_at, rating, before_state, after_state,
    is_introduction, card_version_after, predicted_retrievability, response_ms,
    scheduler_version, parameters_snapshot, desired_retention)
  values (p_request_id, p_user_id, p_card_id, p_reviewed_at, p_rating, p_before, p_after,
    v_intro, v_card.version, p_predicted_retrievability, p_response_ms,
    p_scheduler_version, p_parameters, p_desired_retention);

  return jsonb_build_object('status', 'ok', 'card', to_jsonb(v_card), 'event_id', p_request_id);
end $$;

-- ───────────────────────── 평가 취소 ─────────────────────────
-- 직전 상태로 복구. 이벤트는 삭제하지 않고 reverted_at만 기록.
create or replace function public.revert_review(p_event_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  v_event review_events%rowtype;
  v_card cards%rowtype;
  b jsonb;
begin
  select * into v_event from review_events where id = p_event_id and user_id = uid;
  if not found then return jsonb_build_object('status', 'not_found'); end if;

  select * into v_card from cards where id = v_event.card_id for update;
  -- 잠금 후 이벤트 다시 확인
  select * into v_event from review_events where id = p_event_id for update;
  if v_event.reverted_at is not null then
    return jsonb_build_object('status', 'already_reverted', 'card', to_jsonb(v_card));
  end if;
  -- 이후 다른 평가(또는 취소)가 있었다면 거절
  if v_card.version <> v_event.card_version_after then
    return jsonb_build_object('status', 'version_conflict', 'card', to_jsonb(v_card));
  end if;

  b := v_event.before_state;
  update cards set
    introduced_at  = case when v_event.is_introduction then null else introduced_at end,
    due_at         = (b->>'due')::timestamptz,
    stability      = (b->>'stability')::double precision,
    difficulty     = (b->>'difficulty')::double precision,
    elapsed_days   = (b->>'elapsed_days')::int,
    scheduled_days = (b->>'scheduled_days')::int,
    learning_steps = (b->>'learning_steps')::int,
    reps           = (b->>'reps')::int,
    lapses         = (b->>'lapses')::int,
    state          = (b->>'state')::smallint,
    last_review_at = (b->>'last_review')::timestamptz,
    version        = version + 1,
    updated_at     = now()
  where id = v_card.id
  returning * into v_card;

  update review_events set reverted_at = now() where id = p_event_id;
  return jsonb_build_object('status', 'ok', 'card', to_jsonb(v_card));
end $$;

-- ───────────────────────── 오늘 요약 ─────────────────────────
create or replace function public.today_summary(p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  v_start timestamptz := public.user_day_start(uid, p_now);
begin
  return jsonb_build_object(
    'due_reviews', (select count(*) from cards where user_id = uid and introduced_at is not null
                      and suspended_at is null and due_at <= p_now),
    'overdue_reviews', (select count(*) from cards where user_id = uid and introduced_at is not null
                      and suspended_at is null and due_at < v_start),
    'new_learned_today', (select count(*) from review_events where user_id = uid and is_introduction
                      and reverted_at is null and reviewed_at >= v_start and reviewed_at < v_start + interval '1 day'),
    'unlearned_total', (select count(*) from cards where user_id = uid and introduced_at is null and suspended_at is null),
    'next_due_at', (select min(due_at) from cards where user_id = uid and introduced_at is not null
                      and suspended_at is null and due_at > p_now),
    'day_start', v_start
  );
end $$;

-- ───────────────────────── 권한 ─────────────────────────
revoke execute on all functions in schema public from public, anon;
grant execute on function public.ensure_user_setup(), public.find_duplicate_candidates(text),
  public.add_personal_item(uuid, text, text, text, text, text, text),
  public.revert_review(uuid), public.today_summary(timestamptz) to authenticated;
revoke execute on function public.apply_review(uuid, uuid, uuid, int, smallint, timestamptz, jsonb, jsonb,
  double precision, int, text, jsonb, numeric) from authenticated;
grant execute on function public.apply_review(uuid, uuid, uuid, int, smallint, timestamptz, jsonb, jsonb,
  double precision, int, text, jsonb, numeric) to service_role;
