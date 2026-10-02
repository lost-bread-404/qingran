# 给在这个仓库里工作的 AI

先读 [docs/requirements.md](docs/requirements.md)。那是 Rosie 现在有效的全部需求和决定，她不想每次重复讲。开头写了这份文档怎么维护。

- 她提出新需求或推翻旧决定时，同一次改动里改 `docs/requirements.md`（只留现在有效的），在 [docs/changelog.md](docs/changelog.md) 末尾加一行；被推翻的做法有教训的，写进 [docs/history.md](docs/history.md)。想加回以前去掉的东西之前，先看 history.md。
- Rosie 觉得清然哪里不对、要复盘优化时，先看 `docs/feedback.md`：她对清然的抱怨存在数据库的 `qr_feedback`，那份文档写了怎么查、怎么据此改数据和程序。
- 架构说明：`docs/brain.md`（当前 v6）。检验用的一天：`docs/day-example.md`。导入导出格式：`docs/state-format.md`。日志：`docs/observability.md`。代码、prompt 和这几份文档要一致；改了其中一个，同一次改动里把其他的也改掉。
- 改动只做结构性的，不打针对某个现象的补丁。不要 over-engineer，不要写测试。交付前让一个没参与写代码的 AI 独立查一遍 bug。
- 只有 `main`：改好直接上 production（`main` → Vercel → qingran.app，Neon 的 `production` 分支数据库）。其他分支不会部署（`vercel.json` 的 `ignoreCommand`）。数据库迁移放在 `migrations/`，部署时自动跑。
- 定时任务：cron-job.org 每 5 分钟调 `/api/cron/wake`；Vercel 每天 3 次调 `/api/cron/brain`。
- iPhone 外壳（`ios/`）改了要她用 Xcode 从 `main` 重新装。
