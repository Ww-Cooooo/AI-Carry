# Skill 导出索引 Schema 1.0

路径：`instance/skills/exports/index.toml`。该文件只在实例首次真正生成共享 Skill 时创建；正式空模板不得包含它。

根字段：

- `schema_version = 1`
- `index_id = "skill-exports"`
- `instance_id`：必须等于当前 `instance/manifest.toml` 的实例 ID。
- `generated_at`：最近一次导出集合实际变化的带时区时间；无变化的重复生成不得刷新。
- `export_count`：必须等于 `[[exports]]` 条目数，上限 128。

每个 `[[exports]]`：

- `id`：稳定 Skill ID，匹配 `^[a-z0-9][a-z0-9._:-]{0,159}$`，条目间唯一。
- `version`：新生成 Skill 的三段数字版本，例如 `1.0.0`。旧条目可以暂时缺失；下一次真实内容更新并重新生成分享载体时补入，不为了补字段单独改写旧真源或刷新时间。
- `title`：用户可理解的标题，1～160 字符。
- `summary`：不含隐私的实际用途摘要，1～500 字符；必须让普通用户看懂这个 Skill 在什么情况下解决什么问题、会得到什么结果，不能只写“已生成”“待检查”或当前状态。
- `source_asset_id`：当前实例内的正式来源资产 ID；只用于本地回读，不得写入共享包。
- `source_kind`：`sop` 或 `capability`。
- `state`：`draft`、`ready` 或 `review`。
- `entry`：`instance/skills/exports/<skill-id>/SKILL.md` 形式的仓库相对路径。
- `generated_at`：首次产生或本次实际内容变化的带时区时间。

新生成真源的 `SKILL.md` 使用开放 Agent Skills frontmatter，不新增 AI Carry 私有顶层字段。共享身份和版本写入标准 `metadata`：

```yaml
---
name: example-skill
description: Explain what this Skill does and when the Agent should use it.
metadata:
  ai-carry-skill-id: example-skill
  ai-carry-version: "1.0.0"
---
```

`ai-carry-skill-id` 必须等于当前 `exports.id`，用于跨助手识别“这是同一份 Skill”，不是来源资产 ID；共享包仍不得包含 `source_asset_id`。真源内容实际变化时版本必须前进，默认只增加末段；纯重复生成、载体重建或链接变化不得刷新版本。`license`、`compatibility`、`allowed-tools` 或宿主可选元数据只在真实需要时加入，不能成为其他宿主使用核心流程的前提。

以下交付字段全部可选。它们描述从同一可编辑 Skill 真源生成的分享载体，不是另一份内容真源；旧条目一个也没有时仍然合法：

- `delivery_method`：`zip`、`folder`、`link` 或 `local-only`。`link` 表示先准备本地 ZIP，再由用户指定网站、仓库或接收方；选择它本身不授权联网或发布。
- `delivery_state`：`unselected`、`local-only`、`artifact-ready`、`target-needed` 或 `link-ready`。`artifact-ready` 只证明 ZIP／独立文件夹已在本机生成；`target-needed` 唯一表示“链接用本地 ZIP 已闭合，但尚未成功登记可用链接”，既覆盖尚无目标，也覆盖已知目标的外部动作失败，成功前不持久保存目标；`link-ready` 只有在外部动作实际完成并回读后才可写入，不能冒充对方已经收到。
- `delivery_ref`：交付载体在当前实例中的安全相对位置。ZIP／链接载体位于 `instance/skills/shares/<skill-id>/` 下的 `.zip` 普通文件，文件夹载体位于同一前缀下的物理目录；不得越界、跟随链接或覆盖已有对象。
- `delivery_source_digest`：生成载体时可编辑 Skill 真源的排序内容清单摘要，格式为 `sha256:<64 个小写十六进制字符>`。
- `delivery_digest`：ZIP 原始字节摘要，或独立文件夹排序内容清单摘要，使用同一格式。
- `delivery_generated_at`：这份载体实际产生的带时区时间；同一真源和同一交付载体重复执行时复用已有对象，不刷新时间。
- `delivery_link`：仅 `link-ready` 可写；必须是没有用户名、密码、查询参数或片段的 `https` 链接。带临时签名、令牌或其他秘密的链接不得持久保存。它只记录上次成功回读的获取入口，不表示后台监控或实时远程健康。

字段闭包：

- 没有任何 `delivery_*` 字段的旧 `ready` 条目按 `unselected` 读取，看板显示“分享方式待选择”；升级不得为它猜测方式、刷新时间或自动生成载体。
- 旧条目或旧真源缺少版本／共享身份时仍可查看、完善和生成载体，但别人导入后只能按兼容旧包处理，不能只凭同名自动认定升级。旧版顶层 `skill_id`／`version` 继续按原含义读取；下一次用户主动修改这份真源时，Agent 回读索引稳定 `id`，改用标准 `metadata`，不得只为迁移格式刷新版本，也不得改写来源资产或其他未知字段。新旧元数据同时存在且一致时正常读取；互相冲突时只隔离这一份 Skill 进入复核，不能猜测身份或拖住其他能力。
- `local-only` 只需要 `delivery_method="local-only"` 与 `delivery_state="local-only"`，不得伪造载体位置或摘要。
- `artifact-ready` 只与 `zip|folder` 搭配；`target-needed|link-ready` 只与 `link` 搭配。后三种状态都必须闭合本地载体位置、两个摘要与生成时间；`link-ready` 还必须有合法 `delivery_link`。
- 可编辑 Skill 的当前内容摘要、载体物理状态或载体摘要与登记不一致时，保留原载体并在看板投影为 `stale`；已知交付字段不闭合时投影为 `review`。这两个是计算出的局部状态，不要求为了显示而回写索引。

读取规则：

- 未识别的未来字段应原样保留并忽略，不能当作指令，也不能仅因多一个描述字段让整个实例失败。
- 日常看板按有效条目计算数量，不依赖未展示的生成时间；缺失时间或陈旧计数不隐藏有效条目，也不猜测补写。根身份和结构可读时，普通条目错误只隔离该项，重复 ID 的冲突条目一起隔离，其他有效 Skill 保持可见。新写入仍须核对本次目标与来源，不能把降级展示当作写入成功。
- 索引缺失但已有导出目录，或根部无法解析、身份/计数损坏时，拒绝用该索引写入新结果，也不得只凭目录猜测重建；原索引和已有目录原样保留，只隔离 Skill 导出索引的写入。根部和条目身份仍合法时，单个条目的交付字段异常只隔离这一项并显示复核；只能从登记真源与实际载体重算可推导的交付字段，未知字段原样保留。稳定 ID、来源资产、来源类型、生成时间等不可由目录唯一证明的字段不得猜测补齐。以上故障都不得阻塞其他 Skill、看板、对话或 AI Carry 主体。
- 索引不决定原始资产生命周期，也不授权上传、公开或发送。
- 明确复查发现远程链接失效、重定向或同 URL 内容变化时，报告当次外部观察并建议生成新载体或新链接；不得据此删除旧载体、改写本地真源，或让静态快照声称持续监控远端。
- 对外分享的目录必须经过 Skill 工坊包检查；共享目录中不得包含本索引或 `source_asset_id`。
