---
description: "面向纯文本模型路由的持久图片描述执行器：所选路由无法接收图片、需要由视觉链代为描述时，说明应如何配置。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-image-describe

[English](README.md) | 中文

## 概述

纯文本模型路由不再丢失图片内容。本插件通过你配置的视觉路由链描述每一张保留的图片：一轮带来的批次在循环提交之前于准入时描述，其余在表层的出现位置在下一个请求边界描述。每条描述都是持久的，记录在图片块上或作为 `image/describe` 决定，它所服务的请求携带这段文本来代替图片——跨步骤、恢复和回放都是如此。一个附件只描述一次，它的所有出现位置共享同一段文本。失败、停滞或空回答的路由让位给下一条；整条链没有回答时保留确定性占位文本。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

凡是所选模型路由只接受文本、而另一条配置的路由能看懂图片的组合，都应挂载本插件。它是可选项：随附的 `dsh` 基础配置没有挂载它。

### 何时选择它

当图片必须继续为纯文本选择提供信息时选择它——确定性占位文本只注明附件，不携带内容。当支持图片的路由可能超出图片预算时，同时挂载 [compaction-image-offload](../compaction-image-offload/README.zh.md)；两个执行器标记的出现位置互不重叠。没有可用的视觉路由时本插件不追加任何内容，挂载是安全的，只是不起作用。

### 最小可用组合

`visionRoutes` 条目按尝试顺序命名链路；下面的路由对只是形态模板，不是已知模型。

```yaml
- name: '@deepseek-ai/dsh-compaction-image-describe'
  config:
    visionRoutes:
      - provider: <provider>
        model: <vision-model>
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `visionRoutes` | 必填 | 按尝试顺序排列的描述链：每条一个 `provider`/`model` 对，至少一条 |
| `routeStrategy` | `chain` | `chain` 保持配置顺序；`same-provider` 把所选路由自己的提供方的路由排到最前 |
| `describePrompt` | [模型体验](#model-experience)一节引用的指令 | 随每张被描述的图片一并发送 |
| `maxDescriptionChars` | `2048` | 单条描述的字符数上限 |
| `describeTimeoutMs` | `45000` | 单条描述的每路由预算，超时后让位给下一条路由 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compaction-image-describe)是每个受支持字段的详尽来源。

### 你可以观察到什么

当一轮带来的批次含有保留图片且代理配置的路由只接受文本时，链路路由上的描述调用先于该轮的首个请求，提交的用户消息把每条描述记在图片块自身上。未经描述就到达表层的出现位置在下一个请求边界补齐：一条 `image/describe` 事件通过消息事件序号和图片序号指定每个被描述的出现位置。两种路径下描述都成为派生请求的一部分。描述调用本身是链路路由上一次普通的模型请求。

### 失败与恢复

本插件跳过已经描述或省略的图片，每个附件只描述一次——准入时的批次与表层遍历都是如此。每条路由有一次以 `describeTimeoutMs` 为上限的尝试；失败的结束、空回答、超出预算的停滞或无法解析的路由都让位给下一条。整条链没有回答时不做任何改动，这些出现位置保留确定性占位文本，下一个请求再次尝试。准入和遍历都查询每个模型声明的输入模态，绝不向声明不支持图片的路由发送图片。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本包拥有事件声明、目标校验、不可变的图片描述投影、链路排序、准入描述和逐请求遍历。它在接受 image/describe 事件前向 Session 注册 `imageDescribeProjection`。相同的浏览器安全处理器通过 `./projection` 导出，供独立回放使用，当前格式目录为离线读取器装配该处理器。缺少注册时拒绝实时恢复，卸载已经使用的处理器后拒绝继续派生消息。token 计量把记录的描述并入省略标记所用的同一套表层计价。

`agent/pre-step` 监听器在下游决定之后运行，当代理配置的路由——或在创建时把路由留给请求 waterfall、尚无已记录请求的情况下最后一次记录的路由——声明纯文本输入时，描述被准入批次中的保留图片，并返回每个被描述图片块携带其描述的决定。`agent/request` 监听器先解析调用配置，再检查解析出的路由声明的输入模态，遍历表层补齐准入未覆盖的出现位置。视觉清单延迟重建，并在每次 `llm/adapters-updated` 事件后丢弃；注册表未声明为视觉能力的配置路由会记录一条警告，且每次请求仍会尝试。

纯投影在 Session 提交事件前拒绝无效、重复、已省略或被遮蔽的目标，执行器不维护独立可变的描述状态。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [已确认的图片描述持久化变更](../../../docs/persistence-changes/2026-10-14-image-description.zh.md)——可选的 `ImageBlock.description` 字段及其兼容性确认。
- [dsh-llm](../../llm/llm/README.zh.md)——`ImageBlock.description`、`isRetainedImage` 与优先使用描述的纯文本投影。
- [compaction-image-offload](../compaction-image-offload/README.zh.md)——在支持图片的路由上省略超预算图片的兄弟执行器。
- [compaction seam](../compaction/README.zh.md)——相邻的摘要和文本剪枝操作。

-----

<a id="model-experience"></a>
## 模型体验

### 已描述的请求图片

#### 模型看到的内容

每个被描述的出现位置以注明附件和所记录描述的文本（`describedImageText`）到达纯文本路由；没有记录描述的出现位置保留确定性纯文本占位（`textOnlyImageText`）。一轮带来的图片在准入时描述，因此该轮的首个请求已携带其描述。描述跨请求、恢复和回放持续生效。描述请求本身在下方的逐字指令旁携带原始图片。

##### 逐字描述指令

```markdown
Describe this image completely and precisely for a text-only model that will never see it. Transcribe every piece of visible text verbatim, then name the layout, objects, people, colors, and any UI elements, diagrams, or annotations.
```

#### Token 影响

被描述的出现位置花费描述文本而不是占位文本。token meter 为每个节点定价时应用日志记录的描述，路由计价在纯文本和支持图片的路由上都按描述文本计价。仅针对引用的启发式计数不计入描述元数据。

#### KV Cache 影响

描述在出现位置上替换占位文本，提供方缓存复用因此止于第一张图片被描述的消息；对被准入的批次而言就是该轮带来的那条消息。后续请求保持相同文本，前缀保持稳定。描述调用本身是一次独立的模型请求，先于它所服务的请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **准入查询代理配置的路由**——它先于请求 waterfall 解析最终路由运行，因此把路由改写为支持图片的监听器仍会收到描述文本而不是该批次的图片字节。路由由 waterfall 提供（创建时未设 `provider`/`model` 且尚无已记录请求）的代理跳过准入，回落到请求边界遍历。
- **描述是永久的**——记录的描述不会回退，也不会重新描述，与省略标记一致；一条糟糕的描述在会话生命周期内保持不变。
- **只有声明纯文本输入的路由才触发描述**——未列出的模态把图片字节直接传给适配器；模态声明错误的路由不会被纠正。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本开发备注是非权威的工作背景：给维护者的备注和未决问题。已交付的行为与被接受的理由见上文各节、包代码和链接的持久化变更记录。

- 本包所实现的那场 GitHub discussion 的两个部分一起交付：准入在 pre-step 描述带来的批次，请求边界遍历补齐经其他路径到达表层的出现位置。一个后续工作：挂载描述插件后放宽已安装客户端对纯文本选择的图片上传限制，让 GUI 不再在 harness 决策之前就要求用户换模型。

</details>
