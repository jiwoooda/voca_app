-- Supabase는 API 요청에서 WHERE 없는 UPDATE/DELETE를 막는다(safeupdate). import_items 수정.

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

  drop table if exists _rows;
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
  update _rows set error = case  -- Supabase safeupdate: WHERE 필수
    when expression = '' then 'expression 비어 있음'
    when meaning = '' then 'meaning 비어 있음'
    when length(expression) > 300 then 'expression 300자 초과'
    when length(meaning) > 1000 then 'meaning 1000자 초과'
    when length(coalesce(example, '')) > 2000 then 'example 2000자 초과'
    when length(coalesce(example_translation, '')) > 2000 then 'example_translation 2000자 초과'
    when length(coalesce(note, '')) > 2000 then 'note 2000자 초과'
    when length(coalesce(source, '')) > 300 then 'source 300자 초과'
  end
  where true;

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
