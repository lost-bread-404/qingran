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
- 不要提交 `.env`、API 密钥或备份 json。
