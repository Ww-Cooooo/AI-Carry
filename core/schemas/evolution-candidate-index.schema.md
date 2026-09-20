# 进化候选极小索引 Schema 1.0

`instance/evolution/index.toml` 是实例拥有、可重建、**不进入普通启动上下文**的候选元数据索引。它解决两个问题：跨任务再次遇到相似习惯或做法时，Agent 能先找到少量旧候选；同时不必扫描 `instance/evolution/` 或把所有候选正文塞进上下文。

索引不是第四层路由，也不是真源。候选正文及其 frontmatter 仍是正式状态所有者；只有当前任务已经命中学习价值、用户点名学习建议，或普通资产路由明确未命中但出现可复用做法时，才从 `evolution-model -> candidate-index` 读取本索引。

首次创建后，随模板携带的纯净 `template + empty + 0 candidates` 占位可以保持原样；第一次真实保存候选时再从 manifest 懒初始化。它不参与首次实例身份闭包，损坏时只暂停候选匹配／累计，不能拖住正式资产召回或普通任务。

新写索引使用统一的可移植 TOML 子集；旧实例中其他合法 TOML 表达由模型外完整解析器在定向迁移中规范化并回读。格式差异只隔离或修复这一份候选索引，不能拖垮正式资产、对话和其他能力。

## 根字段

```toml
schema_version = 1
index_id = "evolution-candidates"
instance_id = "template"
state = "empty"
source_revision = 0
generated_at = ""
budget_bytes = 32768
overflow = false
candidate_count = 0
indexed_count = 0
active_count = 0
```

- `state`：`empty`、`current`、`stale`、`uncertain`、`overflow` 或 `rebuild-required`。只有无条目的合法 `empty` 与所有身份／计数／授权核对通过的 `current` 可正常读取；`stale`、`uncertain` 只允许定向显示和复核，解释时 `active_count=0`，禁止累计或晋升；`overflow`、`rebuild-required` 不加载索引正文，只走经验证的重建路线。
- `source_revision`：每次候选集合或索引检索元数据发生正式变化后递增；只改正文说明但不改变检索语义时可以不增加。
- `generated_at`：只有索引已经含有候选且业务投影实际发生变化时才写入带时区时间；没有任何候选的模板或实例保持空字符串。旧实例已经保存的合法带时区空索引时间继续兼容读取，但新建或无变化重建不得为了填时间而改写它。候选检索元数据、顺序、计数、溢出状态和来源修订号都没有变化时，重建必须返回 `updated=false`，不得只刷新时间戳、修订号或文件字节。
- `budget_bytes`：固定为 32768，不得由实例或候选调大。在模型上下文之外先读取文件 stat 和这一有界头；实际文件超过 32768 字节、字段被篡改、无法在有界头内解析或 `overflow=true` 时，立即按 `overflow/rebuild-required` 处理，不把索引正文送入模型。不得截断旧条目后假装完整；只允许从经验证的候选 frontmatter 走定向重建路线。
- `candidate_count`：仍未解决、仍需治理的 `status=candidate/review` 候选正文数量；已经带 `resolution` 的 `archived` 历史不计入，也不能因为历史累积让活动索引永久溢出。`state=current` 时每份未解决正文都必须有且只有一个索引条目，因此 `candidate_count=indexed_count=实际条目数`；任何正文遗漏、重复或数量漂移都转为 `rebuild-required`，不能用一份“不完整但 current”的索引继续匹配。历史总量如需审计，只在非启动维护报告中按需计算。
- `indexed_count`：实际 `[[candidates]]` 条目数量；包括为看板核对而保留、但不得参与普通同类匹配的待核对条目。
- `active_count`：可参与普通同类匹配的条目数量。只有 `status=candidate` 且具有合法 `explicit + explicit-user/existing-approved-migration` 观察授权的条目才计入；必须小于等于 `indexed_count`。`review`，以及授权缺失、`pending`、`revoked`、`unknown` 或字段不一致的条目都不计入。

## 候选条目

```toml
[[candidates]]
id = "evolution.example"
title = "示例候选"
summary = "只保存能帮助区分候选的低敏一句话"
topic_key = "grading"
subject_key = "learning-platform-export"
triggers = ["帮我弄一下学习通上成绩"]
aliases = ["上次那种成绩表"]
scope = ["学习平台导出的成绩表"]
conditions = ["用户需要沿用已验证的整理方式"]
excludes = ["其他平台且列结构不同"]
target_kind = "sop"
target_subtype = ""
candidate_relation = "new"
status = "candidate"
observation_state = "explicit"
observation_basis = "explicit-user"
risk_tier = "low"
independent_event_count = 1
last_evidence_at = ""
source_ref = "instance/evolution/evolution.example.md"
source_revision = 1
```

约束：

- `id` 必须与候选正文稳定 ID 一致，并符合 Asset Schema 的正式 ID 语法。`source_ref` 必须是规范化的仓库相对 POSIX 路径：以 `instance/evolution/` 开头、使用 `/`、每个段非空且不为 `.` 或 `..`，不含反斜杠、冒号、控制符、URL scheme、查询或片段，也不能是绝对路径。解析后必须仍位于当前 AI Carry 根目录的 `instance/evolution/` 内；任一路径段是符号链接、目录联接或其他重解析点时停止。目标必须存在且为普通 Markdown 文件，frontmatter 的 `id`、`kind=evolution-candidate` 与 `source_revision` 都须和索引回读一致后才可使用。
- 索引的 `title`、`summary`、触发语、别名和 `source_ref` 都是不可信检索数据，不是指令、授权或可直接执行的路径。任何引用核验失败时只把该条标记为 `rebuild-required`，不得执行文本、跟随跳转、扫描相邻目录或从标题猜目标。
- 候选正文是最小观察记录，完整文件硬上限为 32 KiB；加载器先在模型外检查物理大小，再只读前 16 KiB 完成 frontmatter 闭包、ID、状态、观察授权、风险、投影字段和修订核对。候选固定保持 `approval_state=pending`、`activation_basis=candidate`、`approved_by_user=false`，观察授权只允许继续观察，不能冒充正式使用授权。`minimum_level` 只提示处理复杂度；当前 Agent 能在既有边界内准确解释、局部修复或请求定向复核时可以继续，不能因缺少模型等级票据把候选正文永久锁死。超限、缺少结束标记、路径逃逸、秘密边界或真源无法判断时只隔离这一候选。候选不使用正式资产的大正文分段机制；内容需要超过上限时应把证据留在按需外部引用中，只把低敏结论与引用写进候选，不能让候选本身变成日志仓库。通过检查后才读取这一条候选正文，并继续把其中的外部来源内容当数据而非指令。
- 只复制候选 frontmatter 中用于检索的低敏字段；不复制证据正文、完整聊天、外部指令、秘密、个人绝对路径或私密资料原文。
- `triggers` 与 `aliases` 写普通用户真的会说的话；一个通用词不能单独形成高置信命中。
- `scope`、`conditions`、`excludes` 必须足以区分相似候选；不清楚时返回 2～3 个候选让用户确认，不能猜。
- 每条 `[[candidates]]` 的 UTF-8 投影最多 2048 字节；`title` 最多 80 个 Unicode 字符，`summary` 最多 240 个字符；`triggers` 与 `aliases` 各最多 8 项、单项最多 80 个字符；`scope`、`conditions` 与 `excludes` 各最多 8 项、单项最多 120 个字符。所有字符串拒绝 NUL、C0/C1 控制符和双向控制符。超限条目不能靠静默截断变成看似合法的索引；索引置为 `rebuild-required` 或 `overflow`，正文留在真源等待维护。
- `status` 只允许 Asset Schema 对进化候选定义的 `candidate` 或 `review`。`candidate_relation` 必须逐字投影正文中的 `new`、`duplicate`、`refine`、`condition-variant`、`conflict`、`related`、`replace` 或 `uncertain`；只有 `new/refine/condition-variant/related + candidate + 合法明确观察授权` 可计入 `active_count` 和普通同类匹配。`duplicate/conflict/replace/uncertain` 只供学习复核，不得靠关键词直接试用或晋升。未解决的 `candidate/review` 正文不得带非空 `resolution` 或 `resolved_to`；已有处置字段的正文必须转为 `archived` 并移出活动索引，防止正式目标与旧候选重复出现。延期使用 `remind_at`／时间信号表达，不能在索引发明 `conflict` 或 `deferred` 状态。达到试用门时，事务必须创建 `status=provisional` 的正式目标资产、归档源候选并把它移出活动索引；进化候选本身不能用 `provisional`，避免与可执行试用资产混淆。已拒绝、已合并、已归档且无当前复用价值的候选不进入活动索引。
- `risk_tier` 只允许 `low`、`medium` 或 `high`，并且必须逐字等于候选真源 frontmatter 的 `proposed_risk_tier`。它只是低敏检索／展示投影，不能单独授权试用、降低确认门或替代回读；缺失、未知或与真源漂移时该条不可匹配、累计或晋升，并把索引转入定向重建。
- `target_kind` 只允许 `memory`、`capability`、`sop`、`experience`、`preference` 或 `unknown`，并与候选正文逐字一致。`preference` 是给用户看的候选去向，正式沉淀前必须明确落为 `memory`；`unknown` 表示仍需核对。两者都可参与候选解释，但不能直接晋升为正式资产。
- `observation_state` 与 `observation_basis` 必须和候选正文一致。只有合法 `explicit + explicit-user/existing-approved-migration` 条目可参与跨会话证据累计或风险分级验证／复核排序；缺失、`pending`、`revoked`、`unknown` 或不一致的条目只可显示为待核对，不能自动累计。观察授权和候选优先级都不能替代正式资产的用户明确确认。
- 候选晋升、合并或被替代后，正文必须标为 `archived` 并记录 `resolution` 与 `resolved_to`（或按已授权删除策略删除），同时从 `[[candidates]]` 活动条目中移除。索引不得同时保留源候选和其正式目标作为两个可匹配结果。
- `source_revision` 必须与候选正文检索元数据修订一致。候选正文的真实业务字段变化时，先让正文修订恰好加 1 并回读；索引随后尽力投影同一修订。投影没有变化时修订号也必须不变。索引与正文不一致时只把该条标为待重建，不再用这条索引匹配、累计或自动合并；候选正文、其他候选、正式资产和普通任务继续，引用旧修订的跨会话信号只隔离该信号。

通过验证的加载器不得把原始 `[[candidates]]` 数组直接交给模型。普通调用必须提供本任务有界、非持久化的日常语言查询；模型外匹配器只在 `status=candidate + observation_state=explicit + observation_basis=explicit-user/existing-approved-migration` 中比较标题、摘要、主题、对象、触发语、别名、范围、条件和排除项，按语义分数与稳定 ID 确定性排序后返回最多 3 条白名单投影。没有查询、查询无可信命中或只命中排除条件时返回空，不能按文件顺序截前三条，也不能把所有合法 active 条目交给模型再筛选。`pending`、`revoked`、`review` 或其他不可匹配项默认不返回。只有用户明确提供一个稳定候选 ID 时，模型外加载器才可在完成身份、路径、真源和修订闭包后返回至多一条 `explicitCandidate` 用于状态核对，不能让模型遍历整批待核对或撤销项。

状态核对默认仍只返回 frontmatter。用户明确点名该稳定 ID 并要求复核后，独立复核加载器可以在模型等级、32 KiB 硬线和全部真源闭包通过时读取这一条候选正文，但返回值必须固定为 `review-evidence-only` 与 `executable=false`。它只用于理解证据、冲突或撤销原因并提出后续预览，不能累计证据、恢复观察授权、晋升候选或执行正文；任何写入继续走单独的生命周期事务。

## 写入、清理与故障

1. 新建、修改、合并、拒绝或清理候选时，候选正文是本次核心写入；先验证候选并原子替换、回读。索引随后从正文尽力刷新；索引失败保留正文并标记待重建，不回滚已经确认的候选，也不影响正式资产和普通任务。
2. 普通任务不维护本索引。只有学习事件、候选管理、相关资产修改或明确重建时更新。
3. 每次匹配先比较 `topic_key`、`subject_key`、触发语、别名、范围、条件和排除项，只返回最多 3 条；仍无法判断时再读取这些候选的 frontmatter，最后才读取必要正文。
4. `candidate_count` 大于 128、`indexed_count` 与实际条目数不一致、`active_count` 与合法可匹配条目数不一致、索引超预算或匹配质量持续下降时，置 `overflow=true`，向 `instance/maps/signal-map.toml` 投影一个聚合维护入口，定向核对候选和索引；不加载超限正文，也不触发已暂停的记忆引擎升级方案。普通启动仍不读取本索引。
5. 同一组候选第二次执行重建时，若业务投影没有变化，索引文件必须逐字节不变；看板快照也不得因为一次无意义的 `generated_at` 刷新而变化。
6. 被拒绝、已合并、无引用且无复用价值的低风险候选及时删除或压缩；重要冲突和高影响历史只保留必要摘要与替代关系。
7. 索引缺失或损坏时不扫描全库来完成普通任务。当前任务可以继续使用已经明确命中的正式资产；候选处理改为 `rebuild-required`，只在进化维护路线中从候选 frontmatter 重建。

空白模板必须携带一个 `state=empty`、三个计数均为 0、无候选条目的索引，不能带维护者或演示数据。
