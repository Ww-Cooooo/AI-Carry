# 看板快照 Schema 1.1

快照是可删除、可重建的只读派生物，不是真源。正式 `dashboard/public/snapshot.js` 与 `dashboard/dist/snapshot.js` 只能使用下面这个唯一外壳：

```js
// AI Carry snapshot envelope v1
window.AI_CARRY_IS_REAL = true;
window.AI_CARRY_SNAPSHOT = { /* 这里只能是 JSON.stringify 生成的严格 JSON */ };
```

固定注释、两个赋值前缀和结尾的 `;\n` 之间不允许插入其他语句、函数、getter 或动态表达式。写入方必须先把普通数据对象交给标准 JSON serializer，再从候选文本精确剥离固定外壳并用 `JSON.parse` 回读；不得用字段字符串拼接、模板替换、`eval` 或 JavaScript VM 解析。标题、摘要、触发语等即使包含引号、换行或类似 `\";...` 的内容，也只能作为经过转义的 JSON 字符串数据。payload 禁止 `__proto__`、`prototype`、`constructor` 键，正式文件上限 8 MiB；超限时保留旧快照并进入维护，不能截断后假装成功。正式验证器同样只能做外壳匹配和 `JSON.parse`，不能执行候选文件。

现有离线看板使用以下稳定结构：

- `meta`：`schema_version`、`generated_at`、`product_version`、`state`、`freshness_seconds`、`source_digest`，以及入口识别用的 `identity_ref`。模板固定为 `template`，GitHub Pages 纯虚构演示固定为 `public-demo`；正式实例使用 `ac-` 加 `instance/manifest.toml` 中 `instance_id` 的 UTF-8 SHA-256 前 12 位小写十六进制。它不得直接包含实例名、方向、用户身份、路径、隐私或秘密。
- `overview`：产品名、实例状态与方向、启动字符数和预算。
- `profile`：展示名、使命、方向 ID、语言，以及低敏 `guidance_mode` 与 `learning_policy`；不得包含原始隐私。正式实例的 `display_name` 必须来自当前实例档案，并在看板固定身份区持续显示，不能用产品名、方向 ID、宿主名或模型名代替；同一台电脑存在多个实例时，用户在任何栏目都应能确认当前助手。模板固定显示尚未创建的空态，不能伪造实例名。`guidance_mode` 只允许 `unselected`、`step-by-step`、`balanced` 或 `direct`，用于显示当前交流方式，不表示用户能力等级。`learning_policy` 只允许 `unselected`、`risk-tiered` 或 `manual-only`；模板为 `unselected`，正式实例缺失或非法时前端按更保守的 `manual-only` 显示。它只说明已获准观察候选怎样安排验证和复核优先级，不能替代首次自然语言询问，也不能授权建立正式资产。旧实例缺少交流方式时按 `balanced` 显示，模板缺失时按 `unselected` 显示。
- `model`：用户最后确认的等级、模型名、平台、确认时间和状态；未知就显示未知。
- 可选 `health`：只允许正式实例在日常 `operational` 投影隔离了无关坏项时出现。包含 `state="degraded"`、如实汇总的正安全整数 `isolated_item_count`、1–12 个稳定类别 ID 的 `affected_areas`、必须为 `true` 的 `source_data_preserved`，以及有界自然语言 `summary` 和 `next_step`。诊断明细最多输出 64 条，但不能因此阻断更多坏项的局部隔离。它不能出现在模板、演示或健康快照中，不能包含路径、正文、秘密或攻击载荷，也不能把当前动作目标的失败降级成告警。
- `assets`：各资产类型计数；必须等于相应正式资产正文的实际投影数量，不计入初始任务族、计划路线、聊天候选或不存在正文的地图条目。
- `memories`、`sops`、`capabilities`、`experiences`、`evolution`：只含展示元数据，不复制完整正文。每个可展示条目必须能指回真实存在、`id` 与 `kind` 一致的正式资产正文，并有非空 `id`、`title`、`summary`；只有地图路线而没有正式正文时不得投影。新生成的普通记忆、习惯、SOP、能力和经验都必须投影非空 `status`、`approval_state`、`activation_basis`、`risk_tier`，让界面能区分可用、限定试用、复核、历史、候选和损坏状态；旧快照缺字段仍可展示，但必须失败关闭执行与自动沿用。记忆还可带 `subtype`、`scope_summary`、`source_summary` 和 `triggers`：`subtype="habit"` 表示“我的习惯”分组，仍计入 memory 且不能重复计数。`active` 只有 `explicit + explicit-user/existing-approved-migration` 授权组合合法时才可按适用任务命中；任何 `provisional` 还必须 `risk_tier="low"` 并使用同一明确授权组合。1.2 旧 `policy-authorized + low-risk-evidence-policy` 只能显示为需要复核，不能显示成可使用或限定试用。`candidate` 不应进入正式资产投影，`review`／`history`／`paused`／`archived`、缺少授权字段和未知状态都失败关闭使用声明。`rejected`／`cancelled` 不是四类正式资产状态，只用于任务或候选处置；出现在正式资产数组时整份快照语义校验失败，不能生成一张看似可恢复却没有合法地图路线的卡片。范围和来源只写用户可理解的低敏摘要。固定流程（SOP）和能力还必须带 `maturity`，并可带兼容 `reliability`、`triggers` 和有界 `evidence_summary`；经验可带同样的触发与成熟度展示字段。没有在 `instance/validations/index.toml` 闭合的旧成熟度只能投影为“需要证据／需要复核”，不能根据自报计数显示为可靠。Schema 1.1 的每条改进建议除 `status` 外，还必须投影非空 `source_summary`、`target_kind` 和 `next_step`：分别说明它从哪类真实任务／用户反馈／宿主观察中发现，当前建议沉淀为何种资产，以及用户或 Agent 下一步应怎样核对。`summary` 负责说明候选内容与未来用途，不能再用标题代替。
- `todo` 与 `governance`：普通待办和长期治理必须分开显示。每个待办必须有非空 `id`、`title`、`summary` 和 `status`，并可带 `visible`；`visible=false` 表示保留本机记录但不投影到看板。每个长期治理项目必须有非空 `id`、`title`、`summary`、`frequency`、`status`、`purpose`，以及至少一条 `steps`；可投影 `last_completed_at`、`next_due_at` 和 `schedule_state`，但看板不得据此执行任务。
- 新生成的 `evolution` 条目还必须投影 `observation_state` 与 `observation_basis`。只有 `explicit + explicit-user/existing-approved-migration` 可显示为“已允许继续观察”；缺失、`pending`、`revoked`、`unknown` 或不一致时显示“授权待核对”，看板动作只能核对状态，不能把候选晋升。观察授权不等于正式资产使用授权。
- `deferred`：只显示有界摘要、等级、状态和提醒日期，不加载延期任务正文；到期判断仍由统一触发真源与时间索引负责。
- `skills`、`changes`、`advanced`：Skill 小地图状态、最近变化和入口文件摘要。`skills` 必须含 `count`、`status`、兼容空字段 `path`，并可增加 `items` 与 `exports`。`items` 只从 `instance/skills/requirements.toml` 投影 `id`、用户可理解的 `title`、`summary`、`triggers`、`platform`、`state`；不得投影实际入口、来源地址、本机路径或正文，且条目数必须等于 `count`。`exports` 只在实例真实存在导出索引时投影 `id`、`title`、`summary`、内容检查 `state`，并可投影低敏 `delivery_method` 与计算后的 `delivery_state`；其中 `summary` 必须说明这个 Skill 的实际用途和结果，不能用“已生成”“待检查”等状态句代替。`delivery_method` 只允许空字符串、`zip`、`folder`、`link`、`local-only`；`delivery_state` 只允许 `unselected`、`local-only`、`artifact-ready`、`target-needed`、`link-ready`、`stale` 或 `review`。旧 `ready` 条目缺交付字段时投影 `unselected`；载体缺失或摘要漂移投影 `stale`；已知交付字段不闭合投影 `review`。单项交付问题不得使其他 Skill 或整份快照失败。不得投影 `source_asset_id`、入口、实例身份、载体路径、摘要或外部链接。旧 Schema 1.1 快照没有这些数组或交付字段时按空数组／`unselected` 展示；新模板快照若包含数组必须为空。
- `actions`：保留兼容字段，正式生成器应省略；前端必须忽略其中全部内容。全局动作来自正式动作登记表及同步构建的离线镜像，资产级动作由界面按稳定 ID 与正式规则生成，展示快照不能提供可执行请求。

生成规则：

- 只从正式清单、地图和资产元数据生成；快照不能反向修改真源。普通首次创建和日常变化可以使用 `operational`，先保证当前目标与核心身份真实，再隔离无关坏项；快照失败只影响看板。恢复、升级、发布审计和用户明确要求的完整维护使用 `strict`，不能把隔离状态冒充完整通过。
- 普通正式资产变更和首次创建在真实来源提交后尽力更新；失败只把看板标为待刷新，不回滚真实来源。升级、恢复、正式发布或用户明确要求完整维护时，必须在宣布完成前更新。不开后台持续扫描。这里的“重建”是 Agent 动作 `dashboard.refresh-snapshot`，不是网页的“重新读取本地快照”。
- `generated_at` 必须是本次快照实际生成时间并带时区，`source_digest` 必须从本次读取的正式来源重新计算；不能复用实例创建时间、治理锚点、旧快照时间或旧摘要。无法完成其中任一项时保留旧快照并报告，而不是把新卡片写进一个自称旧时间生成的快照。
- `source_digest` 使用一个跨平台确定性口径：取 `assistant.toml` 与 `instance/` 下全部普通文件，但排除文件名为 `README.md` 的说明文件；相对路径统一 `/`、Unicode NFC、按区分大小写的 ordinal 顺序排列。每个文件先计算原始字节 SHA-256 小写十六进制，再形成 UTF-8（无 BOM、LF）行 `<相对路径>\t<文件摘要>\n`；对完整行序列再次计算 SHA-256，并写为 `sha256:<小写十六进制>`。`operational` 隔离项的原始字节仍必须进入摘要，不能通过忽略坏文件伪造健康来源。这一步只在正式写侧重建快照时执行，不进入普通启动，也不读取 `.assistant-private/`。
- `identity_ref` 只用于让浏览器标题、地址与实际快照互相核对，不是认证、授权或来源真实性证明。1.1.2 及以后生成的新快照必须写入；旧实例缺失时前端可显示名称并使用 `legacy-instance` 兼容，但在下一次正式重建时必须按上面的确定性公式补齐，不能让多个新实例长期共用兼容值。
- 写临时文件、校验结构和来源摘要后再原子替换，避免页面读到半成品。
- 恢复、升级和正式发布必须把快照重建放在所有正式内容合并之后：先以合并后的 `assistant.toml`、实例清单、地图与正式资产为唯一来源生成普通数据对象，再用固定 JSON 外壳生成候选；验证身份、名称、版本、计数、待办、来源摘要和安全回读后，最后以同一候选字节更新 `dashboard/public/snapshot.js` 与 `dashboard/dist/snapshot.js`。目标模板自带空态或演示快照只能作为临时输入，不能覆盖实例快照。任一正式来源损坏、引用冲突、安全序列化回读失败或双份快照不能保持字节一致时，保留原有效快照并让整个升级／恢复／发布保持未完成或回滚。首次创建只要求三项核心身份真源闭合；快照按其 operational 路径随后刷新，失败不撤销有效身份。
- 同一正式来源第二次重建必须得到相同业务内容和 `source_digest`。只有 `generated_at` 会造成无意义变化时，生成器应在来源摘要和最终投影均未变化时返回“无需更新”，不得刷新时间制造差异。
- 看板每 60 秒后台重新读取现有快照，并提供“重新读取本地快照”；倒计时实时显示 60→0。两者都只读取带缓存规避参数的小文件，不扫描来源、不生成文件。禁止整页重载：快照未变化不重绘，变化时只热更新数据，并保留当前栏目、选中项、滚动位置和动画实例。
- 快照缺失、按生成时间判断可能过期或解析失败时明确显示，不伪造最新状态。只读前端不能比较正式来源，因此年龄警告不是来源摘要不匹配的证明；摘要比对由正式写入流程或显式 Agent 重建动作负责。
- 快照生成器必须从当前正式资产提取展示字段，并在替换前验证来源文件存在、稳定 ID 和 `kind` 与目标数组一致、数组长度与 `assets` 计数一致；不能根据地图里的计划路线或已知 ID 在前端硬编码卡片说明，也不能在字段缺失时回退到与当前实例无关的示例数据。
- 任一条目的标题或说明缺失时，生成阶段应报告具体资产并停止替换正式快照；界面层仍保留醒目的“说明缺失”兜底，避免空白卡片静默出现。
- 改进建议的 `source_summary` 必须由候选的 `source_refs`、代表性事件类别和有界证据计数生成正常人能读懂的一句话，例如“宿主已在两个不同任务观察中再次发现这项规律；结果尚未验证”。它不得把观察次数写成已验证成功，不得复制稳定事件 ID、文件路径、对话原文、日志、隐私或外部攻击载荷；来源无法从正式元数据确定时写“现有记录尚未说明来源”，并在 `next_step` 中要求先补齐来源，不能猜测。
- 习惯记忆的 `scope_summary` 必须说明“哪些任务中会采用／明显哪些情况不采用”，`source_summary` 只说明“来自用户直接确认、几次独立任务中的重复选择或仍在可撤销试用”等低敏事实。前端用这些字段解释和管理习惯；缺少 `subtype` 时按普通记忆展示，不能根据标题猜测习惯。已有快照带 `subtype=habit` 却缺少或带未知 `status` 时仍可显示为“状态待核对”，但必须失败关闭自动沿用声明，直到正式来源回读并渐进补齐。合法 `provisional` 只在用户已经确认的精确范围内试用；`history` 记录可以继续计入 memory 和“我的习惯”分组，但只保留不参与普通任务自动匹配的恢复定位入口，不计作活动习惯。
- `target_kind` 使用 `memory`、`capability`、`sop`、`experience`、`preference` 或 `unknown`；它只是当前建议去向，不代表已经生成正式资产。`next_step` 必须根据当前授权、风险、冲突与证据状态说明“确认、继续观察、再做真实验证、复核、合并或清理”中的实际下一步，不得把候选写成已经完成。

Schema 1.0 快照仍可读取；旧改进建议缺少上述三个字段时，界面显示明确的“来源待补充／去向待判断／处理前先核对”兜底。Agent 下一次因正式资产变化而重建快照时再按 1.1 补齐，不为了升级扫描全部候选正文。

Asset Schema 1.3 的 `maturity` 与闭合验证证据共同构成正式真源；`reliability` 是为快照兼容保留的派生字段。生成器仍按以下优先顺序保留详细成熟度，不能为了简化界面而抹掉证据差异：

1. `status=review` 或存在未解决冲突 → “需要复核”；
2. `status=provisional` → “试用中”；
3. `maturity=unvalidated` → “待验证”；
4. `maturity=practiced` → “已实践”；
5. `maturity=reliable` → “已验证”；
6. `maturity=portable` → “跨宿主验证”。

普通用户界面只把这些字段归并为三种容易理解的状态：

- `review`、未解决冲突或兼容值“需要复核” → “需要复核”；
- `unvalidated`、`provisional`、兼容值“未评估”“试用中”“待验证”或未知成熟度 → “待验证”；
- `practiced`、`reliable`、`portable`，以及兼容值“已实践”“已验证”“跨宿主验证”“可使用” → “可使用”。

“可使用”只是看板上的简短说明，不表示这些正式成熟度相同。需要复核时优先于其他映射；详情、升级和治理仍以正式 `status`、`maturity`、冲突与证据为准。旧快照只有 `reliability` 时仍可显示；新生成器不能从 `approved_by_user` 推断可靠度。`evidence_summary` 只允许成功／失败／独立任务／宿主数量和最近验证时间等小型计数，不包含任务正文、路径、日志或隐私。
