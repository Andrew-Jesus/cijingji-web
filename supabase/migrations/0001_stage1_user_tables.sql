-- ============================================================================
-- 词径记 · 阶段 1：用户层 5 张表
-- ============================================================================
-- 怎么用：整段复制 → Supabase 后台 → 左侧 SQL Editor → New query → 粘贴 → Run
--         全部语句都带 if not exists / 先 drop policy，**重复执行不会报错**。
--
-- 依据：`词径记-阶段1-实施方案-v1.md` §5.1 / §5.2
--
-- 阶段 1 只建这 5 张（用户层）。内容层（词库）7 张表**故意不建**，理由见 §5.3：
--   词库是只读的、所有用户一样的、每台设备自己导一次就行；
--   而且现在库里是「人教版八上」的格式样张，真正要用的外研社版还没做 ——
--   现在建表导数据，等外研社版出来还要重导一遍。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles —— 用户画像
-- ---------------------------------------------------------------------------
-- 主键就是 auth.users.id，所以**不需要单独的 user_id 字段**（下面的 RLS 也照这个写）。
create table if not exists public.profiles (
  id                      uuid primary key references auth.users(id) on delete cascade,
  nickname                text,
  study_code              text,
  goal                    text not null default 'zhongkao',
  goal_deadline           date,
  daily_minutes           int  not null default 15,
  interests               text[] not null default '{}',
  level_self_report       smallint,
  theme                   text,
  timezone                text not null default 'Asia/Shanghai',
  created_at              timestamptz not null default now(),
  -- updated_at 是**合并判据**：同步时"谁后写谁算"，没有它就判不出来。
  -- 规格书里没有这个字段，是本实施方案新增的（§12 偏差表第 7 条）。
  updated_at              timestamptz not null default now(),
  -- null = 还没走完引导。界面据它跳转，**不靠别的字段去猜**。
  onboarding_completed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- 2. daily_plans —— 每日任务单
-- ---------------------------------------------------------------------------
create table if not exists public.daily_plans (
  -- 主键沿用本地 id（形如 plan:2026-09-25）。
  -- 为什么不用云端生成的 uuid：两边 id 相同，推送才能用 upsert 做成幂等的
  -- （重复推同一份不会有副作用）。若云端另生成 id，就得回填到本地，复杂且易错。
  id                text primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  plan_date         date not null,
  status            text not null default 'pending'
                      check (status in ('pending','in_progress','done','skipped')),
  -- items[] 的形状（代码里叫 DailyPlanItem）：
  --   { word_id, sense_id, mode, priority_score, lemma?, meaning_zh?, unit_code?, confidence? }
  -- 后四个是**渲染快照**：计划是历史记录，明天词库改了，昨天那张单子应该还是昨天那个样子。
  -- 注意这不是"把课程标签冗余进 words"（那是被硬约束禁止的），冗余的是"当天排的那份单子"。
  items             jsonb not null default '[]'::jsonb,
  brief             text,
  estimated_minutes int  not null default 0,
  generated_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- 一天只有一张单子
  unique (user_id, plan_date)
);

-- ---------------------------------------------------------------------------
-- 3. review_logs —— 每次作答明细（归因的原料，字段一定要记全）
-- ---------------------------------------------------------------------------
create table if not exists public.review_logs (
  -- 客户端生成的 uuid。**必须是 uuid 而不是自增序号**：
  -- 两台设备离线各记各的，自增序号一定会撞，撞了就会丢记录。
  id               text primary key,
  user_id          uuid not null references auth.users(id) on delete cascade,
  word_id          text not null,
  session_id       text not null,
  mode             text not null,
  is_correct       boolean not null,
  -- 下面四个字段是整张表的价值所在。只记对错的话，这张表就只是一堆 0/1，
  -- 做不了错因归因，也解释不了"为什么今天答得慢"。
  latency_ms       int  not null default 0,   -- 反应耗时
  hesitation_count int  not null default 0,   -- 犹豫次数（改选项 + 清空重输）
  error_type       text,                      -- meaning / spelling / confusion
  rating           smallint,                  -- 三级反馈 1/2/3，直接照 FSRS 的 1/2/3/4 排
  created_at       timestamptz not null default now()
);
create index if not exists review_logs_user_created_idx
  on public.review_logs (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. user_examples —— 个性化例句（per-user，成本主要来源但量级很小）
-- ---------------------------------------------------------------------------
create table if not exists public.user_examples (
  -- ex:<word_id>:<interest_tag>，确定性键 → 同一个词同一个兴趣只存一条
  id              text primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  word_id         text not null,
  sentence        text not null,
  gloss           text not null,
  -- 缓存键**必须含 interest_tag**：换了兴趣域就要重新生成。
  -- 这正是验收标准「例句真的用了我的兴趣」的检查点。
  interest_tag    text not null,
  -- false = 模板兜底句。**界面必须如实标注，不许冒充 AI 生成。**
  is_ai_generated boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (user_id, word_id, interest_tag)
);

-- ---------------------------------------------------------------------------
-- 5. ai_usage —— AI 调用记账（必须有，否则账单必失控）
-- ---------------------------------------------------------------------------
create table if not exists public.ai_usage (
  id            text primary key,
  -- 可空：共享资产生成时没有用户。**不许因为拿不到 user_id 就跳过记账。**
  user_id       uuid references auth.users(id) on delete set null,
  task          text not null,          -- example_personalized / mnemonic / diagnose / plan …
  model         text not null,
  -- 三个 token 必须分开记 —— 缓存命中率是"省钱设计有没有生效"的唯一仪表盘。
  input_tokens  int  not null default 0,
  output_tokens int  not null default 0,
  cached_tokens int  not null default 0,
  cost_cny      numeric(12,6) not null default 0,
  -- false = 价格表里查不到这个模型，那个 0 的含义是"不知道"而不是"免费"。
  -- 没有这个字段，汇总时会把"没计价"算成"白嫖"，账单看起来比实际便宜 ——
  -- 记账一旦开始骗人，整套记账就没有意义了。
  priced        boolean not null default false,
  -- 计价时是否高峰时段（DeepSeek 高峰价 = 空闲价 × 2）。不记就解释不了"为什么这次贵"。
  peak          boolean not null default false,
  latency_ms    int  not null default 0,
  -- **失败也要记**（tokens 取不到就记 0）。只记成功会让"AI 老在失败"从账面上消失。
  ok            boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists ai_usage_user_created_idx
  on public.ai_usage (user_id, created_at desc);
create index if not exists ai_usage_created_idx
  on public.ai_usage (created_at desc);

-- ============================================================================
-- 行级安全（RLS）—— 必须开，否则任何人拿到 anon key 就能读全库
-- ============================================================================
-- anon key 本来就是设计成公开的（它会被打进浏览器包），
-- 所以**数据安全的唯一防线就是这里**。
-- ============================================================================

alter table public.profiles      enable row level security;
alter table public.daily_plans   enable row level security;
alter table public.review_logs   enable row level security;
alter table public.user_examples enable row level security;
alter table public.ai_usage      enable row level security;

-- 先删后建，保证这段可以重复执行
drop policy if exists "own row"        on public.profiles;
drop policy if exists "own rows"       on public.daily_plans;
drop policy if exists "own rows"       on public.review_logs;
drop policy if exists "own rows"       on public.user_examples;
drop policy if exists "read own usage" on public.ai_usage;

-- 前四张：只准读写自己的行。
-- ⚠️ 注意 profiles 的判断列叫 id（它就是 auth.users.id），其余表叫 user_id。
--
-- ⚠️ `(select auth.uid())` 外面那层 select 不是多余的：
--    Postgres 会把它当常量只算一次；直接写 auth.uid() = user_id 会**每一行都算一次**，
--    行数多了明显变慢。这是 Supabase 官方推荐的写法，别顺手"简化"掉。
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

-- ============================================================================
-- 建完自查（可选，跑一下心里有数）
-- ============================================================================
-- 下面这句应该列出 5 张表、每张的 rls_enabled 都是 true：
--
--   select tablename, rowsecurity as rls_enabled
--   from pg_tables where schemaname = 'public' order by tablename;
--
-- 下面这句应该列出 5 条策略：
--
--   select tablename, policyname, cmd from pg_policies
--   where schemaname = 'public' order by tablename;
