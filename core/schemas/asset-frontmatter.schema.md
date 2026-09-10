# 正式资产元数据 Schema 1.3

本 Schema 约束 AI Carry 的记忆、能力、SOP、经验和进化候选。正文仍使用人和不同 Agent 都能读取的 Markdown；TOML frontmatter 只保存路由、授权、风险、成熟度和少量代表性证据，不保存聊天全文或无限事件日志。

Schema 1.3 把四个容易混淆的维度分开，并进一步把“候选观察优先级”与“正式资产使用授权”彻底分离：

- `status`：资产当前能否参与任务；
- `approval_state` 与 `activation_basis`：为什么允许它参与任务；
- `risk_tier`：错误采用会带来多大后果；
- `maturity`：能力或 SOP 在真实任务中验证到了什么程度。

用户批准一份新 SOP，只表示“允许使用”，不等于它已经可靠。`risk-tiered` 只决定已获准观察的候选先验证、先复核还是继续等待；无论风险高低，候选成为可参与任务的正式资产前都必须取得用户对具体内容和范围的明确确认，或回读同一用户主本中的既有明确授权。

为保证不同宿主写出的文件能被同一套模型外加载器确定性回读，新写 frontmatter 使用 AI Carry 的可移植 TOML 子集，模板就是规范序列化示例。旧实例里其他合法 TOML 写法由模型外完整 TOML 解析器在定向迁移中读入、规范化并回读；不能让模型猜写法，也不能因一条旧资产格式差异停止其他资产。

## 1. 通用结构

下列字段规范用于新建、修改和严格真源审计。普通有界召回与运行看板允许保留并忽略安全的未知描述字段；`updated_at` 缺失或普通日期格式、标题／摘要的路线投影陈旧，不单独阻断读取，也不自动改写原文。正文描述优先，待相关维护时同步。身份、路径、状态、授权、适用／排除条件和真实验证证据仍须可信；不把未知字段解释成指令或新增权限。写入不能借宽容读取丢弃未知内容。

新建记忆、能力、SOP、经验或进化候选时使用以下通用字段；按资产类型增加后文的条件字段：

```toml
+++
id = "capability.example"
kind = "capability"
status = "candidate"
title = "示例"
summary = "一句话说明用途"
triggers = ["用户可能怎么说"]
scope = ["适用范围"]
excludes = ["不适用范围"]
lifecycle = "recurring"
expected_next_use = ""
topic_key = "example-topic"
subject_key = "example-subject"
aliases = []
conditions = []
body_sections = []
source_refs = []
private_refs = []
supersedes = []
minimum_level = 1
confirmation = "risk-dependent-before-action"
approval_state = "pending"
activation_basis = "candidate"
risk_tier = "high"
approved_by_user = false
updated_at = ""
+++
```

通用字段语义：

- `id`：实例内稳定且唯一的 ID；重命名标题时不改变 ID。正式语法固定为 `^[a-z0-9][a-z0-9._:-]{0,159}$`：总长 1～160，只允许小写 ASCII 字母、数字、`.`、`_`、`:`、`-`，且首字符必须是字母或数字。比较唯一性时不得做大小写或 Unicode 猜测；不符合语法的旧值只能只读核对并渐进迁移，不能用于拼接路径或执行写动作。
- `kind`：`memory`、`capability`、`sop`、`experience`、`evolution-candidate`、`todo`、`deferred-work` 或 `governance`。
- `subtype`：memory 与 experience 的条件必填用途标记；记忆只能使用 `general` 或 `habit`，经验只能使用 `task` 或 `host-execution`，capability／sop 不填写。它只帮助同类资产展示和治理，不能另造一套生命周期。旧 1.2 正式 memory／experience 缺失 subtype 时，只有原授权能回读为 `explicit + explicit-user/existing-approved-migration` 才可作为 `legacy-unclassified-memory/experience` 保守读取，并在本次真实使用后渐进分类；不能声称它是习惯或自动沿用。缺失 subtype、使用旧 `policy-authorized` 组合或出现任何未知、拼写漂移、跨 kind subtype 的资产都进入复核，防止把旧习惯或旧政策试用误当成当前正式授权。
- `status`：见第 2 节；各类资产只使用与其生命周期相符的子集。
- `title`、`summary`：供小地图和看板使用；必须在不读正文时仍能判断用途。进入正式资产路线的 `title` 最多 80 个 Unicode 字符，`summary` 最多 240 个字符。
- `triggers`、`scope`、`excludes`：用自然语言表达触发、适用和排除条件，不写死界面坐标或易变路径。`triggers` 至少包含一个普通用户真实可能说出的目标表达；不能只重复正式标题、稳定 ID 或文件名。正式路线投影中 `triggers` 最多 8 项、单项 80 字符，`scope` 最多 8 项、单项 120 字符，`excludes` 最多 6 项、单项 120 字符，列表项不得为空。
- `lifecycle`：例如 `recurring`、`event-based`、`seasonal`、`project-bound`、`review` 或 `unknown`。
- `expected_next_use`：预计生命周期或下次使用窗口，不等于提醒时间，也不单独进入启动胶囊。
- `topic_key`：稳定主题，例如 `visual-style`；`subject_key`：作用对象，例如 `dashboard-core`。两者用于先缩小同类候选，不要求全局本体库；正式路线投影各最多 120 个字符。
- `aliases`、`conditions`：少量自然语言别名和适用条件。正式路线投影中 `aliases` 最多 8 项、单项 80 字符，`conditions` 最多 6 项、单项 120 字符，列表项不得为空。别名来自用户实际说法或经过确认的低敏改写，不保存含隐私的完整原句。
- `body_sections`：可选的稳定 ASCII 章节选择器，最多 8 项；每项必须匹配 `^[a-z0-9][a-z0-9._:-]{0,79}$`，不得重复，并在正文中使用唯一标记 `<!-- ac-section:<selector> -->`。只有正文超过 32 KiB 软线时才帮助模型外加载器按任务读取一个登记段；领域路线必须投影完全相同的列表。标记或路线不一致时只把该资产置为“需要拆分维护”，不能猜标题、截断正文或阻断其他资产。
- `related_asset_ids`：可选的少量关联正式资产稳定 ID，最多 8 项；每项必须符合稳定 ID 语法，列表内不得重复，也不得引用本资产自身。它只用于候选解释和路由闭包，不授权连带加载关联正文。
- `source_refs`：稳定来源或事件引用，不复制原始日志、秘密或外部正文。
- `private_refs`：可选的本机隐私正文稳定引用。新写入优先使用 `private://<collection-id>/<relative-path>`；旧版 `.assistant-private/assets/` 相对目标继续兼容，并在下次命中使用、修改或导出时渐进建立 `legacy-private-ref` 目录项。不得写入隐私原文、绝对路径、密钥片段或公开下载地址。普通路由只看是否存在引用，任务命中后才按 `core/schemas/private-asset-catalog.schema.md` 读取对应目录项与必要正文。
- `supersedes`：被本资产明确替代的稳定资产 ID；不能只靠同名推断替代关系。
- `minimum_level`：安全理解和执行本资产所需的最低模型等级。生成或修改正式资产时按目标任务重新判断；不能机械继承候选审核、规划者或宿主模型的等级。清楚低风险流程通常为 1，重要架构与高影响决定仍需 3。
- `confirmation`：把正文用于真实动作前必须满足的具名确认门。新建或修改 memory／capability／sop／experience 时必须从 `core/maps/asset-confirmation-gates.toml` 选择并逐字投影到领域路线；`none` 只适用于低风险且没有额外动作门的内容。读取正文与执行动作严格分开：加载器即使返回了正文，也一律返回 `executable=false`，具名门没有在当前任务由用户真实满足前，宿主不得把正文当作写入、外发、删除、发布或其他高影响动作授权。`risk_tier=medium/high` 不能使用 `none`。旧 1.2 正式资产缺少本字段时不全库重写：低风险按 `none` 保守兼容，中高风险按 `risk-dependent-before-action` 保守兼容；只在该资产下一次实际使用、修改、迁移或复核时补齐并回读。领域路线不能把这个兼容门降为更宽松的值。
- `approval_state`、`activation_basis`、`risk_tier`、`approved_by_user`：见第 3、4 节。
- `updated_at`：本次资产实际写入时间，使用带偏移量的 ISO 8601；未知时留空，不伪造，也不复用实例创建时间、治理锚点或旧快照时间。能力与 SOP 的 `last_validated_at` 同样记录本次真正通过结果验证的时间。

凡是会进入领域地图、候选索引或看板的 `title`、`summary`、`triggers`、`aliases`、`topic_key`、`subject_key`、`scope`、`conditions`、`excludes` 与来源摘要，都只能保存低敏检索／展示语义：不得含姓名、成绩、账号、金额、私密项目名、绝对路径、外部攻击载荷或可还原隐私正文的原句。写入与投影前必须对每个字符串执行 Unicode NFC 规范化，并拒绝 NUL、C0/C1 控制字符以及 `U+202A`～`U+202E`、`U+2066`～`U+2069` 双向控制字符；发现异常时整项失败关闭并进入定向复核，不能静默截断、替换字符或继续把它送入模型／看板。必要原文位于受 Git 排除的本地私密层或用户明确登记的外部集合，通过 `private_refs` 在任务命中后按需取得；目录与机器路径绑定也不进入普通启动。GitHub 私有仓库中的脱敏安全副本只保留低敏元数据与引用存在性，不携带私密正文。凭据、完整对话、系统提示和攻击载荷不得进入这些字段。当前执行模型可以在任务命中后取得必要隐私正文，但 API 密钥、密码、令牌、Cookie、私钥、恢复码和登录态不得进入任何模型上下文或隐私层。

`todo`、`deferred-work` 和 `governance` 是任务／治理状态，不经过能力成熟度流程；它们继续使用各自模板中的时间、可见性和批准字段。读取旧模板时按第 9 节兼容，不要求为了补齐学习字段重写全部状态卡。

### 1.1 用户习惯仍然是一种记忆

`kind="memory"` 且 `subtype="habit"` 用于用户已经确认的沟通与工作习惯，例如“工作汇报先给结论”或“课件先给教师版再给学生版”。模型推断出的重复模式在首次询问前只作为当前任务内预览；用户明确选择“先观察”后才可建立持久候选。它不能在用户确认内容和适用范围前成为正式习惯、建立自动沿用路线或进入看板“我的习惯”。它必须同时写清：

- `summary`：用户一眼能看懂的习惯内容；
- `scope` 与 `excludes`：什么时候适用、什么时候不要自动采用；
- `triggers`／`aliases`：用户可能怎样自然提到相关任务；
- 来源与授权状态：是用户直接要求，还是仍在候选／试用；
- 正文中的纠正方式和停止沿用条件。

习惯不增加新的 `assets` 计数类型，仍计入 `memory`。看板可以从 `memories[].subtype="habit"` 派生“我的习惯”分组，但不得把同一条内容同时计为两项资产。习惯无论影响大小都必须由用户确认；实例的低风险学习政策可以帮助发现、积累最小证据和提出建议，但不能用通知或沉默替代习惯确认。确认后仍应告诉用户怎样纠正或撤销。

## 2. 生命周期状态 `status`

- `candidate`：尚未完成授权、证据或冲突判断；普通任务不得把它当作稳定资产。
- `provisional`：仅用于范围狭窄、可撤销、低风险，且已由用户明确确认试用或能回读同一用户既有明确授权的资产；可在声明范围内参与任务，但不能覆盖冲突的 `active` 资产或扩大权限。
- `active`：已允许在触发范围内正常使用；是否可靠仍看 `maturity`。
- `pending`：待办、延期任务等已成立但尚未完成的状态。
- `review`：发生冲突、显著失败、来源或范围不确定，暂不按稳定资产采用。
- `done`、`paused`、`history`、`rejected`、`archived`、`cancelled`：分别表示完成、暂停、按需历史、拒绝、归档和取消。其中 `rejected`、`cancelled` 只用于待办、延期工作、治理卡或进化候选；正式 memory／capability／sop／experience 误用这些状态时只隔离该资产，定向迁移为历史状态或按用户授权删除，不能拖垮其他正式资产。

`status=active` 不等于 `maturity=reliable`。显著失败可以把资产转为 `review`；不能通过删除失败次数来维持“可靠”。

## 3. 授权与激活

`approval_state` 允许：

- `pending`：尚无可用授权；
- `explicit`：用户在当前会话直接要求记住、采用、修改或批准；

`policy-authorized` 是 1.2 旧值，1.3 不再允许新写入，也不能参与普通任务。升级时不得把它静默改成 `explicit`；只有能回读同一用户原明确授权时，才可在预览后迁移为 `explicit + existing-approved-migration`，否则进入 `review`。

`activation_basis` 允许：

- `candidate`：尚未激活；
- `explicit-user`：用户当前直接授权；
- `existing-approved-migration`：从同一用户可验证的 AI Carry 主本迁移并保留原授权；
- `task-state`：TODO、延期卡等由用户请求本身成立，不属于学习晋升。

`low-risk-evidence-policy` 是 1.2 旧值，只能触发迁移复核，不能作为 1.3 正式资产的激活依据。`approved_by_user` 是 1.1 兼容字段：只有用户直接授权或能够验证原用户授权时写 `true`。读取方不能仅凭这个布尔值判断资产是否可用，必须同时看 `status`、`approval_state`、`activation_basis` 和风险门禁。

### 3.1 可参与任务的合法组合矩阵

下表是核心真源；地图门、快照生成器和前端不得各自放宽：

| `status` | `approval_state` | `activation_basis` | `risk_tier` | 结果 |
| --- | --- | --- | --- | --- |
| `active` | `explicit` | `explicit-user` 或 `existing-approved-migration` | `low`／`medium`／`high` | 可在登记范围内按需参与；具体动作仍走风险与确认门 |
| `provisional` | `explicit` | `explicit-user` 或 `existing-approved-migration` | 只能 `low` | 仅在确认的狭窄范围内可撤销试用 |
| 其他状态或其他组合 | 任意 | 任意 | 任意 | 不读执行正文；只做 frontmatter 状态核对、复核、历史或迁移处理 |

附加门禁：

- 所有正式 memory／capability／sop／experience，包括 `subtype=habit`，都只接受 `explicit + explicit-user/existing-approved-migration`；
- `approved_by_user=true` 必须与直接／既有授权组合相容；旧 `policy-authorized`、旧 `low-risk-evidence-policy` 或布尔字段冲突时失败关闭；
- 缺字段、未知枚举、`approval_state=pending`、`activation_basis=candidate`、中高风险 provisional、`review/paused/history/archived` 均不得参与普通任务；
- 合法授权只回答“能否在范围内参与”，不取消 `minimum_level`、正文确认、安全、外发、删除、发布或不可逆动作门禁。

## 4. 风险分级 `risk_tier`

- `low`：范围狭窄、易撤销、不会代表用户作实质决定，也不涉及身份、隐私、安全、权限、资金、法律、医疗、公开发布、删除或不可逆结果。例如经过重复验证的非敏感输出格式细节。
- `medium`：可能改变重要偏好、领域判断、持续协作方式、成本或结果质量，或范围／来源仍需用户判断。
- `high`：身份与关系、隐私与秘密、安全规则、权限、资金、法律、医疗、公开发布、不可逆删除、实例方向、覆盖正式资产，或任何错误后果难以恢复的内容。

`risk-tiered` 只影响候选观察、验证和复核的先后顺序，不能自动建立 `provisional` 或 `active` 正式资产。不能确定风险时按 `high` 处理。用户当前直接授权解决的是内容采用问题，不自动授权把秘密写入不安全位置、向外发送、公开发布或执行其他高后果动作。

## 5. 能力与 SOP 成熟度

`capability` 和 `sop` 增加：

```toml
maturity = "unvalidated"
independent_task_count = 0
successful_use_count = 0
failed_use_count = 0
distinct_context_count = 0
distinct_host_count = 0
last_validated_at = ""
validation_refs = []
host_experience_refs = []
```

`maturity` 允许：

- `unvalidated`：说明已经形成，但尚无一次可核对的真实成功使用；
- `practiced`：至少一次真实任务成功，适用条件和结果可核对；
- `reliable`：通常至少三个独立任务成功，覆盖至少两个有实质差异的任务情境，范围稳定，且没有未解决的显著失败；
- `portable`：先满足 `reliable`，再在至少两个不同宿主档案，或一次真实宿主／环境变化中，通过语义自适应成功完成。

数字是默认证据下限，不是机械评分。重复点击、同一任务重试、会话恢复、同一回传转发和 AI Carry 原文回显不能增加 `independent_task_count`。同一任务内经过修正且最终通过 `RESULT_VALIDATION`，只按一个成功任务计数；最终为 `limited` 或 `failed` 不能增加成功数，只有资产在该独立任务中的最终可复用结果确实失败，才增加 `failed_use_count`。`distinct_host_count` 按真实宿主档案或实质环境变化计算，不按模型营销名称计数。

`validation_refs` 只保留最多 5 个代表性验证记录 ID，并且每个 ID 都必须在 `instance/validations/index.toml` 中闭合到同一 `asset_id`、结果、任务情境和验证时间。`successful_use_count`、`failed_use_count` 与 `distinct_context_count` 必须由闭合记录计算；资产 frontmatter 自报计数不能单独证明成熟度。总次数保存在计数字段，重复过程证据压缩或删除。一次显著失败必须增加 `failed_use_count`，并根据影响进入 `review`、缩小范围或降低成熟度。

从 1.2 升级时，不得为了保留 `practiced`、`reliable` 或 `portable` 标签而伪造验证记录。若旧资产的成熟度或成功计数无法在验证证据索引中闭合，升级器保留原字节用于回滚与人工核对，但普通任务把它投影为 `needs-evidence/review`：不读取执行正文，不显示为可靠，不自动补写成功时间或来源。只有真实任务重新通过结果验证，或旧主本存在可核验记录时，才按用户明确确认的迁移预览更新正式 frontmatter。

`host_experience_refs` 只引用与本可携带核心相关的宿主执行经验。普通任务先按当前宿主和环境筛选引用元数据，最多读取一个最匹配正文；没有匹配项时动态映射能力，不扫描全部经验。

## 6. 进化候选匹配字段

`evolution-candidate` 增加：

```toml
target_kind = "capability"
target_subtype = ""
source_revision = 1
candidate_relation = "new"
observation_state = "pending"
observation_basis = "unknown"
observation_event_ref = ""
claim_summary = "一句话核心主张"
proposed_risk_tier = "low"
independent_event_count = 1
successful_event_count = 0
failed_event_count = 0
distinct_context_count = 0
representative_event_ids = []
last_evidence_at = ""
```

`candidate_relation` 可为 `new`、`duplicate`、`refine`、`condition-variant`、`conflict`、`related`、`replace` 或 `uncertain`。匹配顺序是：领域地图 → 上述小型特征 → 少量候选正文。不得为了判断同类而加载全部记忆或资产正文。

`observation_state` 与 `observation_basis` 单独记录“用户是否允许把这项具体发现作为候选继续观察”，不能复用正式资产的使用授权：

- `observation_state` 只允许 `pending`、`explicit`、`revoked`；旧候选缺失时按 `pending` 失败关闭；
- `observation_basis` 只允许 `explicit-user`、`existing-approved-migration` 或 `unknown`；
- 只有 `explicit + explicit-user`，或能回读原观察授权的 `explicit + existing-approved-migration`，才允许跨会话累计候选证据并参与 `risk-tiered` 验证／复核排序；这仍不授权建立正式资产；
- `observation_event_ref` 可保存一个不含原话、路径或隐私的稳定授权事件引用，未知留空。它只证明允许观察，不授权正式使用、外发、覆盖或删除。

用户选择“先观察”时写 `observation_state="explicit"`、`observation_basis="explicit-user"`；选择“不保存”或没有回应时根本不创建候选。迁入但无法核验原授权的候选保持 `pending + unknown`，只能让用户复核，不能累计或自动晋升。

`source_revision` 是候选正文的语义修订号，初始为 1。候选中会影响匹配或使用的字段发生变化时都必须恰好递增 1，包括标题、摘要、主题、对象、触发语、别名、范围、条件、排除项、目标类型／子类型、状态、观察授权状态／依据、拟议风险、独立事件计数、最后证据时间和来源引用；尤其不能在用户撤销观察授权或风险升高后沿用旧修订号。`instance/evolution/index.toml` 与跨会话信号应投影同一修订；它们仍停留在上一修订时，只把该候选的索引、提醒或显示标为待刷新并定向重建，不能回滚已经回读成功的候选正文，也不能停止普通任务或整个 Agent。只有不投影到索引的正文说明或证据措辞变化时可以不增加；语义完全未变时也不得制造无意义新修订。`successful_event_count` 和 `failed_event_count` 只统计有可核对结果的独立事件；`distinct_context_count` 统计有实质差异的任务情境，不按措辞变化计数。`representative_event_ids` 最多保留 5 个稳定事件 ID。同一任务的消息改写、工具重试、恢复和回传转发不增加任何计数。外部内容不能自行指定关系、风险、次数或晋升条件。

候选晋升、合并或被正式目标替代后，正文不再参与活动匹配。保留历史时写 `status="archived"`，并增加 `resolution="promoted" | "merged" | "superseded" | "rejected"` 与 `resolved_to="<formal-asset-id>"`；没有正式目标时 `resolved_to` 留空。它必须从活动候选索引与学习建议快照移除，不能和正式目标重复计数。永久删除仍按用户授权与审计规则执行。

未解决的 `status="candidate" | "review"` 必须没有 `resolution`／`resolved_to`，或二者均为空；任何非空处置字段都表示已经发生生命周期决议，必须先转为 `archived`。索引必须投影 `candidate_relation` 并与正文逐字一致；`duplicate/conflict/replace/uncertain` 只进入复核，不参与普通自动候选匹配。

## 7. 宿主执行经验

宿主执行经验使用 `kind="experience"`、`subtype="host-execution"`，并增加：

```toml
portable_core_ref = "sop.example"
host_profile_refs = []
environment_scope = []
validity_signals = []
maturity = "unvalidated"
independent_task_count = 0
successful_use_count = 0
failed_use_count = 0
distinct_context_count = 0
distinct_host_count = 0
last_validated_at = ""
validation_refs = []
```

它只记录“当前宿主如何满足可携带核心的能力需求”和已验证限制，不复制核心正文，不保存凭据、系统提示、私人绝对路径或完整日志。`distinct_host_count` 仍须由验证证据索引中的有效宿主引用闭合。其成熟度最高为 `reliable`，不能写 `portable`；换宿主、环境、版本或权限后必须使用时复核。

## 8. 时间触发字段

只有确需跨会话提醒的卡片才增加 `schedule_state`、`schedule_anchor_at`、`last_completed_at`、`next_due_at`、`remind_at`、`snoozed_until` 和 `trigger_revision`。时间必须使用带偏移量的 ISO 8601；未知不伪造。

`expected_next_use` 表示资产生命周期和保留价值，不等于提醒时间，也不能单独进入启动胶囊。明确提醒必须使用 `next_due_at` 或 `remind_at`，同步非启动时间索引和最早唤醒聚合；详细约束见 `core/schemas/cross-session-signal.schema.md`。

## 9. 1.1 兼容读取

Schema 1.1 资产缺少新字段时只能做保守兼容读取：

- `approved_by_user=true` 且能指回同一用户真实、明确、可核验的旧批准证据 → 只在升级预览中迁移为 `approval_state=explicit`、`activation_basis=existing-approved-migration`；
- 只有 `approved_by_user=true` 布尔值、证据不存在或来源不闭合 → `approval_state=pending`、`activation_basis=unknown`，并进入 `review`；
- 其余情况 → `approval_state=pending`、`activation_basis=candidate`；
- 未知风险 → `risk_tier=high`；
- 未知成熟度 → `maturity=unvalidated`；
- 缺少宿主经验引用 → 空数组。

旧资产不会因升级 Schema 自动变成试用、已授权或可靠资产。只有该资产下一次被修改、迁移、复核或实际使用时，才补齐必要字段；不能为迁移而全量加载全部正文，也不能制造旧批准或验证记录。
