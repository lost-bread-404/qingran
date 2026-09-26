# 给在这个仓库里工作的 AI

先读 [docs/requirements.md](docs/requirements.md)。那是 Rosie 所有需求和决定的总表，她不想每次重复讲。

- 她提出新需求或推翻旧决定时，同一次改动里更新 `docs/requirements.md`，并在末尾「变更记录」加一行。
- 架构说明：`docs/brain.md`（当前 v5）。检验用的一天：`docs/day-example.md`。导入导出格式：`docs/state-format.md`。代码、prompt 和这几份文档要一致；改了其中一个，同一次改动里把其他的也改掉。
- 改动只做结构性的，不打针对某个现象的补丁。
- 改完直接上 production（push `main`），不要 over-engineer，不要写测试（测试已全部删掉，不要加回来）。
- 定时任务：cron-job.org 每 5 分钟调 `/api/cron/wake`；Vercel 每天 3 次调 `/api/cron/brain`。
