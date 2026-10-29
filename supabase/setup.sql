-- Shiba's Playground: accounts. Paste this whole file into Supabase -> SQL Editor -> New query -> Run. Safe to run twice.
-- Users live in Supabase's own auth.users table (email + password + email code). This adds the public profile with the unique username.

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null,
  created_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[A-Za-z0-9_.-]{3,20}$')
);

-- one username per person, ignoring upper/lower case ("Shiba" and "shiba" are the same name)
create unique index if not exists profiles_username_lower_key on public.profiles (lower(username));

-- Row level security: everybody may read usernames (leaderboards), nobody can write from the browser. Profiles are created by the trigger below.
alter table public.profiles enable row level security;
drop policy if exists "usernames are public" on public.profiles;
create policy "usernames are public" on public.profiles for select using (true);

-- Sign-ups that never entered their email code free their username again after 1 hour.
create or replace function public.free_stale_username(name text) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  delete from auth.users u
   using public.profiles p
   where p.id = u.id
     and lower(p.username) = lower(name)
     and u.email_confirmed_at is null
     and p.created_at < now() - interval '1 hour';
end $$;

-- Is this username free? The sign-up form calls this while you type.
create or replace function public.username_available(name text) returns boolean
language sql stable security definer set search_path = public, auth as $$
  select name ~ '^[A-Za-z0-9_.-]{3,20}$'
     and not exists (
       select 1 from public.profiles p
       join auth.users u on u.id = p.id
       where lower(p.username) = lower(name)
         and (u.email_confirmed_at is not null or p.created_at >= now() - interval '1 hour'));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- When somebody registers, create their profile from the username sent with the sign-up. A taken or invalid name rejects the sign-up.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, auth as $$
declare uname text := new.raw_user_meta_data ->> 'username';
begin
  if uname is null or uname !~ '^[A-Za-z0-9_.-]{3,20}$' then
    raise exception 'invalid_username' using errcode = 'P0001';
  end if;
  perform public.free_stale_username(uname);
  begin
    insert into public.profiles (id, username) values (new.id, uname);
  exception when unique_violation then
    raise exception 'username_taken' using errcode = 'P0001';
  end;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Account deletion (right to erasure): a logged-in user can delete their own account. The profile goes with it.
create or replace function public.delete_my_account() returns void
language sql security definer set search_path = public, auth as $$
  delete from auth.users where id = auth.uid();
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
