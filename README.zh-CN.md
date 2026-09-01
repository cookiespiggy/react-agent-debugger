<div align="center">

# ReactAgentDebugger

**别再猜你的 AI Agent 为什么失败了——直接重放它。**

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![OpenTelemetry](https://img.shields.io/badge/OTel-GenAI%20semconv%201.42.0-blueviolet)](https://opentelemetry.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/regression-3%20suites-brightgreen)](#测试)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

</div>

<p align="center">
  <strong><a href="./README.md">English</a></strong> · 简体中文
</p>

<p align="center">
  <img src="./docs/assets/hero.png" alt="ReactAgentDebugger —— 自动诊断、瀑布图与一键 Fork" width="100%">
</p>

---

你的 Agent 跑了 14 步、烧了 4 万 token，然后自信地给出了一个**错误**答案。

日志告诉你它**做了什么**；仪表盘告诉你它**何时**做的。但没人告诉你**为什么**——更没人能回答那个唯一能真正修 bug 的问题：

> *"如果那次工具调用成功了呢？"*

ReactAgentDebugger 以 OpenTelemetry GenAI 语义约定为数据源，给你一个真正可以调试的东西：结构化的时间线、自动诊断，以及**时间旅行**——在任意步骤 Fork，改一处，重跑一遍。

---

## 为什么不用现成的工具？

| | 日志 / `print()` | APM 仪表盘 | ReactAgentDebugger |
|---|---|---|---|
| 看清「推理 → 工具 → 观察」循环 | ✗ 纯文本 | 部分 | ✓ Agent 形状的瀑布图 |
| 直接命名失败模式 | ✗ 自己读 | ✗ 自己读 | ✓ 8 个自动检测器 |
| 从任意步骤重新运行 | ✗ | ✗ | ✓ **Fork & 重放** |
| 反事实实验（"如果没超时呢"） | ✗ | ✗ | ✓ **覆盖任意工具结果** |
| 证明改动真的有效 | ✗ | ✗ | ✓ 并排对比 *已修复 / 仍存在 / 新引入* |
| 跨 run 找系统性坏工具 | ✗ | ~ | ✓ 跨 run p50/p95 与错误率 |
| 厂商无关的数据源 | ✗ | 不一 | ✓ **OpenTelemetry GenAI semconv** |

它是**调试器**，不是仪表盘。仪表盘给你数据、把解读留给你；它直接命名问题、指向相关 span、让你做实验。

---

## 快速上手（60 秒，无需 API key）

```bash
git clone https://github.com/cookiespiggy/react-agent-debugger.git && cd react-agent-debugger
npm install

# 终端 1 —— 内置假 LLM，让重放零配置跑通
npm run mock:llm &

# 终端 2 —— 调试器，连到那个假 LLM
REPLAY_LLM_BASE_URL=http://localhost:4010/v1 REPLAY_LLM_API_KEY=mock npm run dev

# 终端 3 —— 生成带真实失败模式的示例数据
npm run mock
```

打开 **http://localhost:3000**。你会看到自带真实故障模式的轨迹——重试风暴、错误级联、上下文膨胀，全都可以拿来练手。

> 接入真实模型也一样简单：设置 `REPLAY_LLM_API_KEY`、停掉假 LLM 即可。示例数据永远不会被发送到任何地方。

---

## 它能做什么

### 1 · 贴合 Agent 真实结构的瀑布图

不是扁平的 span 列表——是能看清「推理 → 工具 → 观察」循环的瀑布图，展示每次调用的 token 明细（含推理 token）和**自身耗时**（总时长减子节点），一眼看出墙钟时间到底花在哪。

### 2 · 自动诊断 —— 8 个检测器

| 检测器 | 级别 | 触发条件 |
|---|---|---|
| `retry-storm` | critical | 同一工具连续失败 3 次以上 |
| `error-cascade` | critical | 一次失败引发连环失败——直接锁定**最具体的**首次失败，而不是症状性的根 span |
| `reasoning-gap` | warning | 推理模型未上报推理 token（真实成本被低估 5–20 倍） |
| `loop` | warning | 相同调用签名连续重复 |
| `context-growth` | warning | 输入 token 跨轮增长 ≥4 倍（成本平方级增长） |
| `instrumentation` | critical/warning | 检测到过时或冲突的 `gen_ai.*` 属性 |
| `token-hotspot` | info | 单次调用占总 token 的 ≥50% |
| `latency-hotspot` | info | 单个 span 占墙钟时间 ≥40% |

**误报按 bug 处理。** 会狼来了的调试器没人信，所以检测器刻意保守——例如 Claude 4.x 这类可选推理模型，只有请求里真正开启了 thinking 才会被标记，而不是因为它"理论上能推理"。

### 3 · Fork & 重放 —— 有意思的部分

点任意步骤 → **Fork**。调试器从 span 重建那一时刻的完整对话状态，然后让 Agent 继续向前跑：

- **工具结果保持记录值** → 确定性**复现**原始行为，确认这条 trace 可信。
- **覆盖某个工具的输出** → 跑一次**反事实**：*"如果 `crm_lookup` 返回成功而不是 429 呢？"*

用示例里的 `support-agent` 轨迹，在首次失败前 Fork：

| | 确定性重放 | 反事实（`crm_lookup` 成功） |
|---|---|---|
| 步骤 | 3 | **2** |
| 工具调用 | 2（重试循环） | **1** |
| Token | 3750 | **2050** |
| 结果 | *"无法完成…升级给人处理"* | **直接给出答案** |

这就是"重试风暴到底是 429 引起的，还是本来就会发生"的答案——不是猜测，是实验。

### 4 · 用对比证明改动真的有效

`/compare?a=<原始>&b=<重放>` 对两次运行做 diff：指标增量、span 序列，以及按三种状态区分的**诊断对比**：

- **Resolved（已修复）**——原轨迹有、改动后消失 ✓
- **Persisted（仍存在）**——你的改动没碰到它
- **Introduced（新引入）**——重放里新出现的副作用 ⚠

### 5 · 跨 run 聚合分析

`/analytics` 基于 `spans` 索引聚合所有已导入的运行：按工具和按模型的调用数、错误率、**p50/p95 延迟**、token 总量，最差在前。这是找到"那个总是很慢的工具"（而不是"慢过一次的工具"）的方式。

---

## 架构

```
  你的 Agent
      │  OTLP/HTTP（JSON 或 protobuf）
      ▼
  POST /api/v1/traces ──► 归一化 ──► 构建 TraceView ──► SQLite
                          (semconv     (树 · 自身耗时 ·   (traces + spans
                           coalesce)    子树聚合)          + raw_spans)
                                │
        ┌───────────────────────┼────────────────────────────┐
        ▼                       ▼                            ▼
  /traces/[traceId]         /analytics                   洞察引擎（8 检测器）
   瀑布图 · 诊断              跨 run p50/p95                    │
        │                                                       │
        └──► Fork ──► 重放引擎 ──► LLM ──► 新 spans ────────────┘
                     （通过 OTLP 自打点回写）
                                │
                                ▼
                       /compare?a=..&b=..
```

**关键设计决策：** 重放引擎不依赖你的 Agent 代码。它从 span 重建对话，驱动任意 OpenAI 兼容的 LLM，并通过同一个 OTLP 端点**给自己打点回写**——所以一次重放就是一条普通 trace。列表、瀑布图、洞察、对比全部免费复用。

---

## 接入你自己的 Agent

把任意 OpenTelemetry exporter 指向它即可。接收端监听规范路径 **`/v1/traces`**，标准环境变量不需要拼路径：

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
OTEL_SERVICE_NAME=my-agent \
python my_agent.py
```

```python
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider()
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint="http://localhost:3000/v1/traces"))
)
```

`/api/v1/traces` 是等价的别名路径。两者都接受 `application/x-protobuf`（SDK 默认）和 `application/json`，以及 `gzip`/`deflate` 压缩。可用 `curl http://localhost:3000/v1/traces` 探活。

Span 遵循 **OpenTelemetry GenAI 语义约定**（钉定 semconv v1.42.0）：

```
gen_ai.operation.name   = chat | execute_tool | invoke_agent | …
gen_ai.provider.name    = openai
gen_ai.request.model    = gpt-4.1
gen_ai.tool.name        = crm_lookup          # 用于 execute_tool
gen_ai.usage.input_tokens / output_tokens / reasoning.output_tokens
error.type              = 429                 # 标准 OTel 属性
```

已接入的 SDK（OpenAI Agents SDK、LangChain/LangGraph 经 OpenInference 或 OpenLLMetry 等）通常开箱即用。`gen_ai.*` 属性名同时在野外流传着三代命名——归一化层**只做 coalesce、绝不求和**，发现冲突或过时命名时会报警。

---

## 配置

| 环境变量 | 是否必需 | 说明 |
|---|---|---|
| `REPLAY_LLM_API_KEY` | 重放时需要 | 仅浏览轨迹不需要 |
| `REPLAY_LLM_BASE_URL` | 否 | 默认 `https://api.openai.com/v1`；任意 OpenAI 兼容端点 |
| `REPLAY_LLM_MODEL` | 否 | 回退到 span 上记录的模型 |

一切都在本地：轨迹存放在 `./data/traces.db`（SQLite）。

---

## 项目结构

```
src/
  app/            路由：/ · /traces/[traceId] · /compare · /analytics · /api/v1/traces · /v1/traces · /api/fork
  components/     瀑布图 · span 检查器 · Fork 面板
  lib/
    otlp/         线上类型 + 手写 protobuf 解码器（拒绝乱码）
    genai/        semconv 注册表 + 归一化（coalesce、数据质量告警）
    trace/        建树 · ingest · 洞察 · diff · 聚合
    replay/       上下文重建 + 重放引擎
    db/           SQLite：traces · spans · raw_spans
scripts/
  mock-agent      生成合成失败轨迹
  mock-llm        零成本假 LLM，用于重放
  test-*.ts       回归套件（见下）
```

---

## 测试

三套回归，都不需要外部服务：

```bash
npm run typecheck      # tsc --noEmit
npm run test:insights  # 8 种故障模式：真阳性 + 误报防护
npm run test:protobuf  # OTLP protobuf 解码器往返 + 乱码拒绝
npm run test:replay    # fork → 重放 → 对比 端到端（需 dev + mock:llm 运行）
```

`test:insights` 把手写 OTLP span 喂给**真实管线**（`normalizeSpan → buildTraceView → analyzeTrace`），同时断言两个方向：正确的检测器触发，**以及**无关/健康的轨迹保持安静。它还包含一个我们曾经发布过的误报的回归防护（非推理模型被标记为推理模型）。

---

## 已知限制

说得直白一点，因为一个不可信的调试工具比没有更糟：

- **OTel GenAI 不携带工具参数 schema**——重放时工具拿到宽松 schema，由模型推断参数。这是规范本身的缺口，不是这里缺功能。
- **Fork 点之后才首次使用的工具没有记录定义**，重放只能重建轨迹中早前出现过的工具。
- **反事实的保真度取决于你给的替代值**。工具能证明*控制流是否会改变*，但不能证明你伪造的输出是否真实。
- **它是本地、单进程的调试器**（SQLite、无鉴权）。它不是生产监控平台——跑在自己机器或内网即可。

---

## 路线图

- 把跨 run 聚合发现的「系统性慢 / 高错误率工具」带入单轨迹洞察
- 按 `conversation.id` 分组，调试多轮会话
- 各框架的接入指南

---

## 贡献

欢迎 Issue 和 PR。如果你新增检测器，请在同一个 PR 里给 `scripts/test-insights.ts` 补一个故障用例——**并且补一个证明它在健康轨迹上不会误报的用例**。

## License

[MIT](./LICENSE) —— 随便用。
