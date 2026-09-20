+++
id = "governance.memory-technology-review"
kind = "governance"
status = "active"
title = "记忆治理技术长期改进"
summary = "周期性研究更适合 AI Carry 的记忆、检索与自我进化技术。"
triggers = ["运行记忆治理长期TODO", "研究新的记忆技术"]
frequency_days = 180
background = false
minimum_level = 3
approved_by_user = false
schedule_state = "uninitialized"
schedule_anchor_at = ""
last_completed_at = ""
next_due_at = ""
snoozed_until = ""
trigger_revision = 0
+++
# 原始目的

当前分层地图、按需加载、Markdown/TOML 真源和混合路由是可用基线，但技术会继续发展。本项目每隔约 180 天，在用户明确要求后做一次完整联网调研，寻找比现有方案更适合 AI Carry 的记忆治理方式，并据此提出优化。

# 每轮必须做什么

1. 先量化当前真实问题：记忆漏检、误检、上下文占用、路由延迟、重复/冲突、进化候选质量和跨平台迁移。
2. 联网检索国内外高质量论文、主要 Agent/模型厂商的技术报告、可信研究机构资料和有实作证据的行业专家文章；过滤水论文、营销稿和无验证观点。
3. 比较文件地图、全文检索、RAG、向量/图检索、情景/程序性记忆、分层摘要、记忆反思与新出现技术的质量、速度、成本、隐私和可迁移性。
4. 判断是保留现状，还是改进现有地图或派生索引。公版的记忆引擎升级方案已暂停，不把本轮研究自动转成安装任务；Markdown/TOML 真源和已有检索配置保持不变。
5. 输出建议、证据、风险、资源影响和回退方式；用户批准后才修改正式架构。

平时不读取本卡，不后台运行，不因到期自动联网。启动胶囊只比较所有定时项中的最早唤醒时间；到期后先显示聚合提醒，用户选择本项后才加载本卡。用户主动提到新的记忆技术时，只提示可以提前启动；仍须用户明确同意后才开始联网研究。
