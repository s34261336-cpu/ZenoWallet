-- Минимальная миграция для уже установленной арены.
-- Выполнить один раз ПОСЛЕ supabase/arena.sql.
-- Таблицы заново создавать не нужно.

create or replace function public.arena_change_zenotoken(
  p_user_id bigint,
  p_delta bigint
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_users_state jsonb;
  v_user_state jsonb;
  v_user_key text := p_user_id::text;
  v_current bigint;
  v_next bigint;
begin
  if p_user_id is null or p_user_id <= 0 then
    raise exception 'Некорректный пользователь';
  end if;

  select state_value
    into v_users_state
    from public.bot_state
   where state_key = 'users'
   for update;

  if not found or v_users_state is null
     or jsonb_typeof(v_users_state) <> 'object' then
    raise exception 'Supabase bot_state row state_key=users was not found or is invalid';
  end if;

  v_user_state := coalesce(v_users_state -> v_user_key, '{}'::jsonb);
  if coalesce(v_user_state ->> 'zenotoken', '') ~ '^[0-9]+$' then
    v_current := (v_user_state ->> 'zenotoken')::bigint;
  else
    v_current := 0;
  end if;

  v_next := v_current + coalesce(p_delta, 0);
  if v_next < 0 then
    raise exception 'Недостаточно ZenoToken для этой ставки';
  end if;

  v_users_state := jsonb_set(
    v_users_state,
    array[v_user_key, 'zenotoken']::text[],
    v_next::text::jsonb,
    true
  );

  update public.bot_state
     set state_value = v_users_state
   where state_key = 'users';

  insert into public.wallet (user_id, earn_balance, zeno_balance)
  values (p_user_id, 0, v_next)
  on conflict (user_id) do update
    set zeno_balance = excluded.zeno_balance,
        updated_at = now();

  return v_next;
end;
$$;

create or replace function public.arena_resolve_round(p_round_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_round public.arena_rounds%rowtype;
  v_winner public.arena_entries%rowtype;
  v_pool bigint;
  v_roll numeric;
  v_payout bigint;
begin
  select *
    into v_round
    from public.arena_rounds
   where id = p_round_id
   for update;

  if not found or v_round.status <> 'open' then
    return;
  end if;

  if v_round.closes_at > clock_timestamp() then
    raise exception 'Приём ставок ещё открыт';
  end if;

  select coalesce(sum(stake), 0)
    into v_pool
    from public.arena_entries
   where round_id = v_round.id;

  if v_pool <= 0 then
    raise exception 'В раунде нет участников';
  end if;

  v_roll := random() * v_pool;

  select candidate.*
    into v_winner
    from (
      select entry.*,
             sum(entry.stake) over (order by entry.id) as running_stake
        from public.arena_entries as entry
       where entry.round_id = v_round.id
    ) as candidate
   where v_roll < candidate.running_stake
   order by candidate.id
   limit 1;

  if not found then
    raise exception 'Не удалось определить победителя арены';
  end if;

  v_payout := floor(v_pool * 0.90)::bigint;

  update public.arena_entries
     set is_winner = (id = v_winner.id),
         payout = case when id = v_winner.id then v_payout else 0 end
   where round_id = v_round.id;

  if v_winner.is_bot then
    update public.arena_bot_profiles
       set bankroll = bankroll + v_payout
     where id = v_winner.bot_id;
  else
    perform public.arena_change_zenotoken(v_winner.user_id, v_payout);
  end if;

  update public.arena_rounds
     set status = 'finished',
         finished_at = clock_timestamp(),
         total_pot = v_pool,
         winner_entry_id = v_winner.id,
         payout = v_payout
   where id = v_round.id;
end;
$$;

create or replace function public.arena_join(
  p_user_id bigint,
  p_bet bigint,
  p_display_name text default 'Игрок'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_round public.arena_rounds%rowtype;
  v_entry public.arena_entries%rowtype;
  v_participant_count integer;
  v_zeno_balance bigint;
  v_name text;
  v_avatar text;
  v_arena jsonb;
  v_earn_balance bigint;
begin
  if p_user_id is null or p_user_id <= 0 then
    raise exception 'Некорректный пользователь';
  end if;

  if p_bet is null or p_bet < 1 or p_bet > 10000 then
    raise exception 'Ставка должна быть от 1 до 10000 ZenoToken';
  end if;

  perform pg_advisory_xact_lock(816184092026);

  select *
    into v_round
    from public.arena_rounds
   where status = 'open'
   order by id desc
   limit 1
   for update;

  if not found or v_round.closes_at <= clock_timestamp() then
    raise exception 'Приём ставок закрыт — дождись следующего раунда';
  end if;

  select *
    into v_entry
    from public.arena_entries
   where round_id = v_round.id
     and user_id = p_user_id
     and not is_bot
   for update;

  if not found then
    select count(*)
      into v_participant_count
      from public.arena_entries
     where round_id = v_round.id;

    if v_participant_count >= 8 then
      raise exception 'Слишком много участников в раунде';
    end if;
  end if;

  v_zeno_balance := public.arena_change_zenotoken(p_user_id, -p_bet);

  v_name := left(coalesce(nullif(trim(p_display_name), ''), 'Игрок'), 48);
  v_avatar := upper(left(v_name, 1));

  if v_entry.id is null then
    insert into public.arena_entries (
      round_id, user_id, display_name, avatar, is_bot, stake
    )
    values (
      v_round.id, p_user_id, v_name, v_avatar, false, p_bet
    )
    returning * into v_entry;
  else
    update public.arena_entries
       set stake = stake + p_bet,
           display_name = v_name,
           avatar = v_avatar
     where id = v_entry.id
     returning * into v_entry;
  end if;

  update public.arena_rounds
     set total_pot = total_pot + p_bet
   where id = v_round.id;

  select earn_balance
    into v_earn_balance
    from public.wallet
   where user_id = p_user_id;

  v_arena := public.arena_get_state(p_user_id, v_name);

  return jsonb_build_object(
    'balance', v_zeno_balance,
    'zenoBalance', v_zeno_balance,
    'earnBalance', coalesce(v_earn_balance, 0),
    'arena', v_arena
  );
end;
$$;

revoke all on function public.arena_change_zenotoken(bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.arena_resolve_round(bigint)
  from public, anon, authenticated;
revoke all on function public.arena_join(bigint, bigint, text)
  from public, anon, authenticated;

grant execute on function public.arena_change_zenotoken(bigint, bigint)
  to service_role;
grant execute on function public.arena_resolve_round(bigint)
  to service_role;
grant execute on function public.arena_join(bigint, bigint, text)
  to service_role;