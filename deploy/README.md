# 自部署听力引擎（Modal + Qwen2.5-Omni-7B）

对外是 OpenAI-compatible：`POST /v1/chat/completions`，音频用 `input_audio`。

## 为什么选这个模型

| 模型 | License | 显存（可用精度） | 中文转写 | 结构化 JSON | 冷启动 |
|---|---|---|---|---|---|
| **Qwen2.5-Omni-7B（采用）** | Apache 2.0 | ~24GB BF16 / ~12GB AWQ，一张 L40S 够 | 中英口语好，能留语气词 | vLLM 原生 OpenAI + audio，instruction 稳 | 大约 30–60s |
| Qwen3-Omni-30B-A3B | Apache 2.0 | 短音频也要约 60–80GB，A100-80GB | 更强，接近 Gemini 级 | 最好 | 2–5 分钟，容易打满 4s 超时 |
| Step-Audio 2 mini | Apache 2.0 | ~20GB | **开源中文 CER 最好**（约 3.2） | 要 StepFun 的 vLLM fork，不是原版 OpenAI audio | 中等 |

清然这条链路要 **4 秒内出 JSON**、通话开始 warm-up、挂断后 scale to zero。Qwen2.5-Omni-7B 是质量和运维的交叉点：Apache 2.0、一张 48GB 卡、官方 vLLM 音频接口。质量不够再把 `QINGRAN_HEARING_MODEL` 换成 `Qwen/Qwen3-Omni-30B-A3B-Instruct` 并把 GPU 改成 `A100-80GB`。

## 为什么用 Modal 而不是 RunPod

- `scaledown_window` 直接对应「通话中保活、挂断后熄火」
- 不用自己推 Docker；Python 文件就是服务
- 冷启动和 GPU 快照比 RunPod Serverless 好控
- 计费按秒，适合一天只打几通电话

RunPod 更适合常驻 Pod。这里要的是通话级弹性，选 Modal。

## 部署步骤

1. 安装：`pip install modal && modal setup`
2. （可选）Hugging Face token：`modal secret create huggingface-secret HF_TOKEN=hf_...`
3. 部署：`modal deploy deploy/modal_hearing.py`
4. 记下打印出来的 URL，例如 `https://xxxx--qingran-hearing-serve.modal.run`
5. 在 Vercel 加环境变量（Production / Preview 都勾）：

| Name | Value |
|---|---|
| `SELFHOST_BASE_URL` | `https://<modal-url>/v1` |
| `SELFHOST_API_KEY` | `qingran`（或你改过的 `QINGRAN_HEARING_API_KEY`） |
| `SELFHOST_MODEL` | `qwen2.5-omni-7b` |

6. 清然设置 → 听力 → 选「自部署」。打通电话时会发 warm-up；通话中每 25 秒心跳；挂断后 90 秒无请求就 scale to zero。冷启动耗时写进 `qingran_hearing_turns.cold_start_ms`。

本地试：

```bash
curl "$SELFHOST_BASE_URL/models" -H "Authorization: Bearer $SELFHOST_API_KEY"
```
