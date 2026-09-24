# 清然：合并之后要做的事（Roadmap）

> 2026-09-24：brain v3 的阶段 1–3 已在 `main`。结构、表、热路径字段和偏差写在 [brain-v3.md](brain-v3.md)。下面第 2、3、5 节里「删消息 / 用 mind 字段 / 回复检索笔记」的描述已经过时，以 brain-v3 为准。主动发消息还没做。

> 整理自 2026-09-19 与 Claude 的讨论。当前在做：`feat/simple-hearing-eval`（语音 eval 这一轮）。
> 本文件只列「语音这一轮完成之后」的事。每项标注依赖关系和待决定事项。

---

## 0. 待 Rosie 决定

- [ ] **Spend limits**：`claude-memory` 做了 in-app 日/月限额 + 熔断（默认月熔断 $200）。原计划是 xAI 预付 ~$100/月作为唯一上限、不做 app 内限额。三选一：保留 / 删除 / 只保留 ledger（记账、不熔断）。
- [ ] **被问住时的表现**：升级到推理模型时，先出声垫一句（"……嗯"、轻叹）再想，还是安静地等？
- [ ] **清然是否知道自己是 AI**：决定 prompt 中「现实层」怎么写（她在现实里能做什么）。

---

## 1. 合并 `claude-memory`

**方向**：把 `main` merge 进 `claude-memory`（不要反过来），测完再合回 `main`。

- [ ] 冲突：trial merge 有 16 个文件冲突。`docs/merge-notes.md` 写的目标还是 `ios-microphone`，没覆盖 main 之后加的 hearing module（`stream-talk.ts` / `server.ts` / `voice-room.tsx` / `prompt.ts`）。原则：通话、hearing 以 main 为准；brain 以 cm 为准。
- [ ] 两边各做了一套 password gate（auth-lite），只保留一套。
- [ ] `auth_attempts` migration 两边内容相同（`0004_auth_attempts` / `0006_auth_attempts`），保留一份。
- [ ] **生产库已经跑过 cm 的全部 migration**（Preview 曾共用生产 DATABASE_URL，现已隔离）。`0003_v2` 已把消息正文里的 `⟦已扫⟧⟦走向⟧⟦设定⟧` 转成列；main 在那之后写入的带标记消息不会再被转换。合并时需要一个幂等的补转换步骤。（目前消息表只有 1 条，影响很小。）
- [ ] Eval baseline 从未运行：`npm run eval -- --repeat 3`，结果写回 `docs/eval-baseline.md`。
  - 注意：eval 用的是 `DEFAULT_SYSTEM_PROMPT`，不是 Rosie 在设置里写的 prompt。要加一个参数用真实 prompt 跑。
- [ ] 模型选择集中在一处（`brain/config.ts`），方便 xAI 出新模型时替换。

## 2. 消息保留

- [x] `room.ts` 的 240 是读取窗口和备份切片，不是 DELETE。`retention.ts` / `dedupe-replies.ts` 也不删 `qingran_messages`、不截断正文。清掉的对话用 `forgotten_at` 标，行还在。

## 3. 理解 Rosie（最核心的智能问题）

目标行为：**先完全理解处境 → 共情、站在她这边 → 基于理解表达爱和能兑现的付出**。反例：牛津那段对话中，清然没弄懂处境就承诺内推、资源（表演付出）。

- [ ] **处境模型**：回应前先建立 5 层：事实 / Rosie 的信念 / 推理中的漏洞 / 情绪 / 她想要什么。存在 mind 里（已有 `rosie_now` / `undercurrent` / `my_logic` 等字段，可以复用或扩展）。
- [ ] **只问真正缺的信息**：区分「已知」（当前对话、上下文、记忆）和「假设」。会改变回应方向的假设才变成问题；已经完全理解时不问问题。
- [ ] **当前处境区块**：Rosie 正在经历的事（面试、截止日期等）单独一个区块，每轮都带上，不参与检索竞争。
- [ ] Eval 指标：
  - 多余的问题：问了上下文或记忆里已有答案的事（目标接近 0）
  - 暗中的假设：回复建立在 Rosie 没说过、记忆里也没有的前提上（目标接近 0）

## 4. 推理模型路由（快 / 慢两套系统）

默认：快模型（non-reasoning）+ Reflector 预先算好的 mind。以下情况升级到推理模型。

**触发条件看「误读代价」，不看话题新不新**（Rosie 话题跳跃，换话题不代表被问住）：
- Rosie 在表达关于自己或处境的**信念**（「失败了就完了」「我对人不信任」「我什么都没有」）
- 字面意思和真实意思可能不一致（嘴上说没事，语气却低落）
- 需要分清是想倾诉还是想要解决方案
- 高风险时刻：崩溃、提分手、自我否定
- 清然准备做出承诺

**实现**：
- [ ] 主要机制：快模型自我升级。第一个输出为特殊标记（如 `⟦想⟧`）时，服务端中止，改调推理模型。
- [ ] 硬规则兜底：mind 过期 / 新会话开始 / 情绪强度突然升高 → 直接走推理模型。
- [ ] 想完写回 mind，下次遇到类似情况直接走快路径。
- [ ] 每轮记录走了哪条路径和触发原因；分别统计两条路径的延迟；看升级率（太高 = 快模型没自信，太低 = 在硬撑）。
- [ ] 标注「快模型回答了但没脳子」的轮次，用来校准路由。

## 5. 记忆检索

现状（v3）：清然不再从笔记里检索。回复和 reflect 读一份 Dossier（启用前暂时还是 self / bond / portrait）。日记仍用 archive → notes。原文检索（pgvector，先摘要再翻原文）等攒 3–6 个月再做，见 [brain-v3.md](brain-v3.md)。

下面是合并讨论时的旧方案，不再按这个做：

- [ ] **Hybrid 检索**：embedding 语义检索 + 关键词搜索混合排序（解决「面试焦虑」找不到「找实习压力」这类问题）。
- [ ] 放宽过滤：低重要性笔记不再完全排除，只降低排序。
- [ ] 当前这一句只能靠关键词补 2 条 → 话题一跳就接不上。考虑实时回复前做一次快速语义检索。
- [ ] 被调用次数加分会导致常用的越来越常用，新事实难被选上。评估是否去掉或加上限。
- [ ] 检索 eval：一批「问题 → 应检索到的笔记」对照，测量召回率。

## 6. 能兑现的付出需要功能支持

- [ ] 主动联系：定时 check-in / 提醒 / 清然主动发起对话。没有这个功能，「我会督促你学习」依然是空承诺。

## 7. 回复参数

- [ ] temperature 0.85 → 0.6–0.7（随机性太高，看起来像没逻辑）。
- [ ] 主回复模型：先试 grok-4.3 effort=low，配合分段耗时实测；太慢再依赖第 4 节的路由。

## 8. Prompt eval（Rosie 自己写 prompt，这里只放测试）

- [ ] 从真实对话里挑 10–20 轮「霸总」/「没脳子」的回复，存成固定测试集；每次改 prompt 只改一处，重放一遍，比较前后。
- [ ] 必收测试用例：
  - **牛津面试**：Rosie 倾诉被比较 + 「下周面试失败就完了」。合格：先理解处境（必要时只问缺的信息）→ 共情 → 能兑现的付出。不合格：第一轮就安慰或承诺内推、资源。
  - **不信任 → 我会努力**这一类：Rosie 表达一个关于自己的深层信念。合格：回应这个信念本身。不合格：用付出、保证来回应。

Prompt 原则备忘（供 Rosie 自己写时参考）：写「她是谁、在乎什么」而不是「该怎么做」；给约束写原因；注意题材触发词（ABO → 霸总文默认写法）；用行为定义聪明；少写「不要」；检查自相矛盾（「判断完就做」vs「倾诉就接」；「不要问」vs「为理解而问」）；不硬性限制长度；给她内心世界；示例慎用；把 Rosie 讨厌的行为写成清然自己也反感的东西；她不假装知道不知道的事，也不问已经知道的事。

## 9. 语音（本轮 `feat/simple-hearing-eval` 之后）

- [ ] 攒约 200 条标注后，看 /lab 三行 CER（最终文字 / 仅 xAI / 仅 Apple），再用 `scripts/eval-hearing.mjs` 在同一 test set 上比较 xAI / Qwen / Gemini / 自部署。
- [ ] **Refusal 测试（还没做）**：攒到几十条标注后导出，用 eval 脚本测 Qwen / Gemini 的拒答率（hard + soft）。决策规则：任意一家 < 5% 就先用它；都 > 5% 就部署自部署版本（Modal，`deploy/modal_hearing.py`）。
- [ ] **xAI STT streaming（WebSocket）**：从「说完 → 等 2 秒静音 → 上传整段 → 识别」改成边说边传、边说边识别，并可用 xAI 服务端 endpointing（Smart Turn）替代固定 2 秒静音。这是降低延迟收益最大的一项。
  - 前提：eval baseline 已经出来，改完直接对比 streaming 和 batch 的 CER 与延迟。
  - 问题：Vercel serverless 不适合长时间中转 WebSocket，大概率要让手机直连 xAI，需要临时 token 一类的机制避免暴露 API key（先查 xAI 文档确认是否支持）；中文识别问题依然存在（同一个模型）；录音照样要在本地保存一份用于 eval。

听力引擎选项总览：

| 选项 | 状态 |
|---|---|
| xAI STT（batch） | 在用 |
| Qwen3.5-Omni（DashScope） | 已接入 |
| Gemini | 已接入 |
| Apple 识别（Web Speech） | 一直和 xAI 并行运行（liveText） |
| 自部署 Qwen2.5-Omni-7B（Modal） | 代码已写好，未部署 |
| 自部署 Qwen3-Omni-30B / Step-Audio 2 mini | 备选，自部署跑通后改配置即可换 |
| xAI Voice Agent | 未做，需实测能否输出带语气的转写 |
| SenseVoice（手机本地） | 未做，只有粗粒度情绪和事件标签 |
| xAI STT streaming（WebSocket） | 未做，见上 |

- [ ] 标注方式（已决定）：不再用固定情绪分类（撒娇 / 玩 / 困…）。语气用标点表达（～ … ！ ？），另加「字面≠意思」开关和可选备注；「噪音」开关保留。成绩卡加「语气符号准确率」评估 `recoverCues`。
- [ ] 个人词表（从历史消息统计高频词和短句）和 confusions 自动纠错表：等 eval 显示错误主要是同音字问题时再做。
- [ ] ~~iOS 壳接原生 SFSpeechRecognizer~~：不需要。数据显示 Apple 识别在主屏幕 PWA 模式下正常工作。
- [ ] iOS 原生 app：等 Apple Developer 身份验证通过后在真机上测试（`DEVELOPMENT_TEAM` 还是空的）。

## 10. 工程杂项

- [ ] `npm test` 用 `&&` 串联，`scripts/*.test.mjs` 中 17 个 Grok 模板残留测试失败，导致 app tests 在 `npm test` 下根本没跑。拆成两段执行。
- [ ] `操作说明.md`、`ios/安装说明.md` 过时：还写着 Production Branch = `ios-microphone`、网址是 grok.me。改为 `main` + qingran.app。
- [x] Preview 使用独立的 Neon 分支（已完成）。
- [x] `HEARING_LAB_PASSWORD` 加上 Preview 环境（已完成）。
