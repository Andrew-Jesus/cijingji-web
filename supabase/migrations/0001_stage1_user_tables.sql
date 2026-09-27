-- ============================================================================
-- 词径记 · 阶段 1 · 用户层 5 张表 + RLS
-- ============================================================================
--
-- 这份文件是**唯一真源**：《词径记-阶段1-实施方案-v1.md》§5.1 / §5.2 与它逐字一致。
-- 用法：整段复制 → Supabase 控制台 → SQL Editor → Run。
-- 重复跑是安全的（create table if not exists / create index if not exists），
-- 但 `create policy` 没有 if not exists —— 第二次跑会报 "policy already exists" 的错，
-- **那个错可以忽略**，它只说明策略已经在了、不需要再来一遍。
--
-- 阶段 1 只建这 5 张用户层表；内容层（词库）7 张表阶段 1 不上云，见实施方案 §5.3。
--
-- ⚠️ 两条改不得的写法（§5.2）：
--   ① `(select auth.uid())` 外面那层 select 不是多余的 —— Postgres 会把它当常量
--      只算一次；直接写 `auth.uid() = user_id` 会**每一行都算一次**，行数多了明显变慢。
--   ② `for all` 含 insert/update/delete，但只对 `authenticated` 角色生效 ——
--      未登录（anon）连不上，这正是我们要的。
-- ============================================================================


-- ============================================================
-- 一、建表
-- ============================================================

-- ---------- 1. profiles 用户画像 ----------
-- 主键 id 直接就是 auth.users.id（一个人只有一份画像，不需要另起一个 id）
create table if not exists public.profiles (
  id                     uuid primary key references auth.users(id) on delete cascade,
  nickname               text,
  study_code             text,
  goal                   text not null default 'zhongkao',
  goal_deadline          date,
  daily_minutes          int  not null default 15,
  interests              text[] not null default '{}',
  level_self_report      smallint,
  theme                  text,
  timezone               text not null default 'Asia/Shanghai',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  onboarding_completed_at timestamptz
);

-- ---------- 2. daily_plans 每日任务单 ----------
-- id 沿用本地那份（形如 plan:<user_id>:2026-09-25）—— 两边 id 相同，upsert 才能幂等（§7.2）
-- 注意：编号里**必须带 user_id**，格式在 0002_owned_ids.sql 里定的（原来是纯日期 → 两个账号撞主键）
create table if not exists public.daily_plans (
  id                text primary key,          -- 沿用本地 id：plan:<user_id>:2026-09-25
  user_id           uuid not null references auth.users(id) on delete cascade,
  plan_date         date not null,
  status            text not null default 'pending'
                      check (status in ('pending','in_progress','done','skipped')),
  items             jsonb not null default '[]'::jsonb,
  brief             text,
  estimated_minutes int  not null default 0,
  generated_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, plan_date)
);

-- ---------- 3. review_logs 作答明细 ----------
create table if not exists public.review_logs (
  id               text primary key,           -- 客户端生成（时间戳+序号+随机尾巴），不是 uuid
  user_id          uuid not null references auth.users(id) on delete cascade,
  word_id          text not null,
  session_id       text not null,
  mode             text not null,
  is_correct       boolean not null,
  latency_ms       int  not null default 0,
  hesitation_count int  not null default 0,
  error_type       text,
  rating           smallint,
  created_at       timestamptz not null default now()
);
create index if not exists review_logs_user_created_idx
  on public.review_logs (user_id, created_at desc);

-- ---------- 4. user_examples 个性化例句 ----------
create table if not exists public.user_examples (
  id              text primary key,            -- ex:<user_id>:<word_id>:<interest_tag>
  user_id         uuid not null references auth.users(id) on delete cascade,
  word_id         text not null,
  sentence        text not null,
  gloss           text not null,
  interest_tag    text not null,
  is_ai_generated boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (user_id, word_id, interest_tag)
);

-- ---------- 5. ai_usage 记账 ----------
create table if not exists public.ai_usage (
  id            text primary key,
  user_id       uuid references auth.users(id) on delete set null,  -- 可空：共享资产生成时无用户
  task          text not null,
  model         text not null,
  input_tokens  int  not null default 0,
  output_tokens int  not null default 0,
  cached_tokens int  not null default 0,
  cost_cny      numeric(12,6) not null default 0,
  priced        boolean not null default false,
  peak          boolean not null default false,
  latency_ms    int  not null default 0,
  ok            boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists ai_usage_user_created_idx
  on public.ai_usage (user_id, created_at desc);


-- ============================================================
-- 二、RLS（必须开，否则任何人拿到 anon key 就能读全库）
-- ============================================================

alter table public.profiles      enable row level security;
alter table public.daily_plans   enable row level security;
alter table public.review_logs   enable row level security;
alter table public.user_examples enable row level security;
alter table public.ai_usage      enable row level security;

-- 前四张：只准读写自己的行。
-- 注意 profiles 的主键叫 id（它就是 auth.users.id），其余表叫 user_id —— 别抄错。
create policy "own row" on public.profiles
  for all to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy "own rows" on public.daily_plans
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own rows" on public.review_logs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own rows" on public.user_examples
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ai_usage：**只给读，不给写**。
-- 记账只能由服务端网关用 service_role 写（service_role 绕过 RLS）。
-- 不给写权限的理由：否则用户可以自己往表里插 cost_cny = 0，账单就假了。
create policy "read own usage" on public.ai_usage
  for select to authenticated
  using ((select auth.uid()) = user_id);
