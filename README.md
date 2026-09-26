# 清然

Rosie 的语音聊天工具：按住说话 / 电话免提，Eve 朗读，可编辑 system prompt。她记得的事是一份有字数上限的文档，原文在消息表里只追加、不删除。需求见 [docs/requirements.md](docs/requirements.md)，结构见 [docs/brain.md](docs/brain.md)。

**你要做的全部步骤（域名、数据库、自动发布、iPhone）：[操作说明.md](操作说明.md)**

## 本地运行

```bash
npm install
npm run dev
```

默认在 `0.0.0.0:8080`。

## 说明

- 线上记忆在你自己的 Neon 数据库里，不在 GitHub。换域名用设置 → 数据里的导出/导入（格式见 [docs/state-format.md](docs/state-format.md)）。
- 线上全站密码是 `APP_PASSWORD`（HMAC cookie `qr_session`）。本地 `npm run dev` 不走这层。
- 不要提交 `.env`、API 密钥或备份 json。
- 听力：设置 → 听力，只走 xAI 和 Apple。标注模式开着时每一句都存 clip。标注页：`/lab`。
- **xAI STT 官方不支持中文。** `/v1/stt` 的 `language` 格式化语言列表是 en / fr / de / ja 等，没有 zh。代码不再传未文档化的 `prompt` 字段，显式使用 `model=grok-voice-transcribe-2.0`，只传 `hearing/config.ts` 里的固定 `STT_KEYTERMS`（姐姐 / 清然 / 小猫 / Rosie + 单字语气词；不再喂「林泽」、叠语气词、system prompt 抽词或 ABO 词表），`filler_words=true`，`vad_threshold` 默认 0.3（可用 `XAI_VAD_THRESHOLD` 覆盖）。
- 自部署 GPU：见 [deploy/README.md](deploy/README.md)。
- 评测：

```bash
node --experimental-strip-types scripts/eval-hearing.mjs path/to/export.json --split test --out hearing-eval.csv
```
