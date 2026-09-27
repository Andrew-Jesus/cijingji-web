-- ============================================================================
-- 0002_owned_ids.sql · 用户层两张表的编号带上主人
-- ============================================================================
-- 起因（洞五）：`daily_plans.id` 原来只由日期决定（`plan:2026-09-25`），
-- `user_examples.id` 只由词 + 兴趣决定（`ex:w:apple:篮球`）。
-- 而这两列在**本地和云端都是主键**。同一台设备上两个账号各有"今天的任务单"时，
-- 两条 id 一模一样 → 推上云撞主键 → **整批 upsert 被拒** → 同步静默失败
-- （用户看到的只是"同步没生效"，没有任何报错）。
--
-- 改法：把 `user_id` 拼进编号。
--     plan:<user_id>:<日期>          （原来是 plan:<日期>）
--     ex:<user_id>:<词>:<兴趣>        （原来是 ex:<词>:<兴趣>）
--
-- 唯一约束**不用改** —— 它们本来就是按人建的：
--     daily_plans   unique (user_id, plan_date)
--     user_examples unique (user_id, word_id, interest_tag)
-- 也正因为有这两条约束，改写 id 时**不可能撞主键**：
-- 同一个人同一天（同一个词+兴趣）本来就只有一行。
--
-- 幂等：`where` 里排除了已经是新格式的行，重复执行无副作用。
-- 原子：整段包在一个事务里，中途出错整体回滚。
--
-- 与本地那一侧对应：`cijingji-web/lib/db/local.ts` 的 Dexie v3 升级事务做了同一件事，
-- 编号规则共用 `cijingji-web/lib/db/ids.ts` 一处定义。
-- ============================================================================

begin;

-- 已经是新格式的行不动（形如 plan:<uuid>:<日期>）
update public.daily_plans
   set id = 'plan:' || user_id::text || ':' || plan_date::text
 where id !~ '^plan:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:';

update public.user_examples
   set id = 'ex:' || user_id::text || ':' || word_id || ':' || interest_tag
 where id !~ '^ex:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:';

commit;

-- 核对（可选，跑完看一眼对不对）：
--   select id, plan_date, status from public.daily_plans order by plan_date desc limit 5;
--   select id, word_id, interest_tag from public.user_examples limit 5;
