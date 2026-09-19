# 清然

Rosie 的语音聊天工具：按住说话 / 电话免提，Eve 朗读，长期记忆，可编辑 system prompt。

**你要做的全部步骤（域名、数据库、自动发布、iPhone）：[操作说明.md](操作说明.md)**

## 本地运行

```bash
npm install
npm run dev
```

默认在 `0.0.0.0:8080`。

## 说明

- 线上记忆在你自己的 Neon 数据库里，不在 GitHub。换域名用设置里的「备份」导出/导入。
- 线上全站密码是 `APP_PASSWORD`（HMAC cookie `qr_session`）。本地 `npm run dev` 不走这层。
- 不要提交 `.env`、API 密钥或备份 json。
- 听力引擎：设置 → 听力。标注模式开着时每一句都存 clip。标注页：`/lab`。
- **xAI STT 官方不支持中文。** `/v1/stt` 的 `language` 格式化语言列表是 en / fr / de / ja 等，没有 zh。代码不再传未文档化的 `prompt` 字段，显式使用 `model=grok-voice-transcribe-2.0`，只传固定 `STT_KEYTERMS`（不再把 system prompt 抽出来的人名喂给 STT），`filler_words=true`，`vad_threshold` 默认 0.3（可用 `XAI_VAD_THRESHOLD` 覆盖）。
- 自部署 GPU：见 [deploy/README.md](deploy/README.md)。
- 评测：

```bash
node --experimental-strip-types scripts/eval-hearing.mjs path/to/export.json --split test --out hearing-eval.csv
```
