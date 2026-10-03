-- 설정 변경 함수 + 하루 신규 기본값 30

alter table public.user_settings alter column daily_new_limit set default 30;
-- 아직 기본값(10)을 쓰고 있는 사용자는 30으로
update public.user_settings set daily_new_limit = 30, updated_at = now() where daily_new_limit = 10;

-- 목표 회상률 변경은 이후 평가부터 적용된다 (기존 카드 일정은 바꾸지 않음)
create or replace function public.update_my_settings(
  p_daily_new_limit int, p_personal_new_limit int, p_desired_retention numeric
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
  perform public.ensure_user_setup();
  update user_settings set daily_new_limit = p_daily_new_limit, personal_new_limit = p_personal_new_limit,
    desired_retention = p_desired_retention, updated_at = now()
  where user_id = uid returning * into s;
  return to_jsonb(s);
end $$;

-- 모음집 '학습 중' 켜기/끄기 (신규 카드 공급 대상)
create or replace function public.set_collection_active(p_collection_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update collections set is_active = p_active
  where id = p_collection_id and user_id = public.require_user();
  if not found then raise exception 'collection_not_found' using errcode = '22023'; end if;
end $$;

revoke execute on function public.update_my_settings(int, int, numeric), public.set_collection_active(uuid, boolean) from public, anon;
grant execute on function public.update_my_settings(int, int, numeric), public.set_collection_active(uuid, boolean) to authenticated;
