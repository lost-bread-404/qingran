# 清然

Rosie 的语音伴侣：按住说话或打电话，Eve 朗读，人设由她写。需求见 [docs/requirements.md](docs/requirements.md)，结构见 [docs/brain.md](docs/brain.md)，给 AI 的说明见 [CLAUDE.md](CLAUDE.md)。

第一次搭起来（域名、数据库、自动发布、iPhone）：[操作说明.md](操作说明.md)。

## 本地运行

```bash
npm install
npm run dev
```

默认在 `0.0.0.0:8080`。没有 `DATABASE_URL` 时用内置的 PGLite，跑同一套 `migrations/`。

## 说明

- 线上数据在 Neon 数据库里，不在 GitHub。换域名用设置 → 数据里的导出 / 导入（格式见 [docs/state-format.md](docs/state-format.md)）。
- 线上全站密码是 `APP_PASSWORD`（HMAC cookie `qr_session`，`src/lib/auth-lite`、`server/`）。本地 `npm run dev` 不走这层。
- 不要提交 `.env`、API 密钥或备份 json。
- 听力只走 xAI 和 Apple 本地识别。标注页：`/lab`。
