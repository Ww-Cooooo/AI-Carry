import { useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, ChevronRight, CircleHelp, ClipboardCopy, Download, FileArchive, FolderOpen, Link2, PackageOpen, ShieldCheck, Sparkles, Upload, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoHint, SectionEyebrow, SourceText, StatusBadge } from "@/components/dashboard/Shared";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildSkillCreateAction,
  buildSkillExportAction,
  buildInstalledSkillRepairAction,
  capabilities,
  getGlobalActions,
  isolatedContentMessage,
  snapshotAreaDegraded,
  profile,
  skills,
  sops,
  type AssetItem,
  type ExportedSkillItem,
  type InstalledSkillItem,
} from "@/lib/data";
import { recommendForSkillWorkshop, type SkillWorkshopSourceKind } from "@/lib/skill-workshop";

type CopyRequest = (text: string, label: string) => void;

interface WorkshopAsset {
  kind: SkillWorkshopSourceKind;
  item: AssetItem;
}

type WorkshopTab = "methods" | "mine" | "installed" | "import";

interface ExportedSkillView {
  label: string;
  help: string;
  deliveryTitle: string;
  deliveryCopy: string;
  nextStep: string;
}

function exportedSkillView(item: ExportedSkillItem): ExportedSkillView {
  if (item.state === "draft") return {
    label: "待完善",
    help: "这份 Skill 的可编辑真源已经保存在本机，但检查还没完成。原方法不受影响，其他 Skill 和助手能力照常使用。",
    deliveryTitle: "还没有生成分享文件",
    deliveryCopy: "继续完成触发、隐私和使用边界检查后，Agent 会请你选择 ZIP、独立文件夹、链接或只保留在本机。",
    nextStep: "让 Agent 继续完善这一份 Skill；检查通过后，它会接着询问一次分享方式并生成你选择的本地载体。",
  };
  if (item.state === "review") return {
    label: "需要复核",
    help: "这份 Skill 的内容或依赖有一项需要理解。它会原样保留并只暂停这一份，其他 Skill 和助手能力不受影响。",
    deliveryTitle: "复核完成前不生成新载体",
    deliveryCopy: "已有文件不会被删除或覆盖。Agent 会先说明具体命中项，再按你的决定继续。",
    nextStep: "让 Agent 打开检查结果，用自然语言说明问题、影响和可选处理方式。",
  };
  const views: Record<ExportedSkillItem["deliveryState"], ExportedSkillView> = {
    unselected: {
      label: "分享方式待选择",
      help: "Skill 本身已经通过检查，只是还没有选择怎样交给别人。旧版生成的 Skill 会自然进入这个状态，不需要先迁移。",
      deliveryTitle: "可编辑 Skill 已就绪",
      deliveryCopy: "选择 ZIP、独立文件夹、链接或只保留在本机后，Agent 会直接生成相应载体。",
      nextStep: "让 Agent 问你一次分享方式；如果你不确定，它会推荐最合适的一种。",
    },
    "local-only": {
      label: "仅本机保留",
      help: "你之前选择先不分享。可编辑 Skill 仍安全保留，随时可以改选 ZIP、文件夹或链接。",
      deliveryTitle: "当前没有额外分享文件",
      deliveryCopy: "这是主动选择，不是错误，也不会影响 Skill 继续完善或以后分享。",
      nextStep: "如果现在想分享，让 Agent 重新询问交付方式并生成相应载体。",
    },
    "artifact-ready": {
      label: item.deliveryMethod === "folder" ? "分享文件夹已准备" : "ZIP 已准备",
      help: item.deliveryMethod === "folder" ? "一个独立 Skill 文件夹已经在本机生成，可以复制给别人；可编辑真源仍是原来的那一份。" : "一个可直接发送的 Skill ZIP 已经在本机生成；可编辑真源仍是原来的那一份。",
      deliveryTitle: item.deliveryMethod === "folder" ? "独立文件夹可以交付" : "ZIP 可以直接交付",
      deliveryCopy: "看板不公开本机路径。点击下方按钮后，Agent 会告诉你准确位置，并可按你的目标继续处理。",
      nextStep: "让 Agent 打开实际位置；你可以自己发送，也可以明确接收方后让 Agent 继续。",
    },
    "target-needed": {
      label: "分享链接尚未完成",
      help: "用于链接分享的本地 ZIP 已准备好，但还没有成功登记可用链接：可能尚未给出目标，也可能上次外部操作没有完成。",
      deliveryTitle: "本地 ZIP 已准备",
      deliveryCopy: "Agent 会先复用当前对话里仍然有效的目标与授权；无法回读时才请你补充，不会把失败说成你从未给过目标。",
      nextStep: "让 Agent 继续准备链接；有有效目标就直接重试，没有时再告诉它放到哪里、谁可以看到。",
    },
    "link-ready": {
      label: "分享链接已准备",
      help: "本地载体和实际链接都已登记。这里不展示地址，避免把来源或私密位置暴露到看板。",
      deliveryTitle: "链接已经可以使用",
      deliveryCopy: "点击下方按钮后，Agent 会回读当前记录并告诉你实际链接和适用范围。",
      nextStep: "让 Agent 打开分享信息，或在内容变化后重新生成一个新版本。",
    },
    stale: {
      label: "分享文件需要更新",
      help: "可编辑 Skill 后来发生了变化，或原来的分享载体已缺失。旧载体会保留，但不再冒充最新版本。",
      deliveryTitle: "当前载体不是最新内容",
      deliveryCopy: "Agent 会从现在的可编辑真源生成一个新的、不覆盖旧文件的载体。",
      nextStep: "让 Agent 重新生成分享文件；完成后它会报告新位置和检查结果，内部校验不需要你填写。",
    },
    review: {
      label: "分享信息需复核",
      help: "Skill 内容仍可保留，但分享方式、载体记录或链接信息有一项不闭合。问题只影响这一份交付信息。",
      deliveryTitle: "先核对这一份分享记录",
      deliveryCopy: "Agent 会根据实际真源和已有载体修复可推导的信息，不删除或覆盖用户文件。",
      nextStep: "让 Agent 说明并复核分享信息；能安全修复的会修复，仍需决定的只问一个问题。",
    },
  };
  return views[item.deliveryState];
}

const INSTALLED_SKILL_HELP: Record<string, string> = {
  available: "这个 Skill 已登记并可在相关任务命中时按需读取；仍只会加载完成当前任务所需的内容。",
  review: "这个 Skill 的入口、依赖、权限或兼容状态需要复核。让 Agent 只检查这一个 Skill；复核前不会启用它，其他能力不受影响。",
  unavailable: "这个 Skill 当前不能使用。Agent 会保留它的记录和恢复入口，其他 Skill 与 AI Carry 主体仍可继续工作。",
};

function MethodTicket({ asset, onCopy }: { asset: WorkshopAsset; onCopy: CopyRequest }) {
  const recommendation = recommendForSkillWorkshop(asset.kind, asset.item);
  const action = buildSkillCreateAction(asset.kind, asset.item);
  const actionLabel = recommendation.state === "ready"
    ? "生成 Skill 并选择分享方式"
    : recommendation.state === "inspect"
      ? "让 Agent 检查后生成"
      : "让 Agent 补齐后再生成";
  const request = recommendation.state === "refine"
    ? `${action.text}\n\n这项方法当前还需要完善。不要只停在“先继续完善”：请用自然语言说明缺少的唯一关键条件；当前对话能安全补齐时继续完成，不得伪造真实任务证据。达到可生成条件后，接着询问一次分享方式并生成所选本地载体；暂时不能补齐时给我一项明确的下一步。`
    : action.text;
  return (
    <article className={`method-ticket method-ticket--${recommendation.state}`}>
      <div className="method-ticket__rail" aria-hidden="true"><i /><i /><i /></div>
      <div className="method-ticket__body">
        <div className="method-ticket__meta">
          <span>{asset.kind === "sop" ? "固定流程（SOP）" : "能力中的流程"}</span>
          <StatusBadge value={asset.item.reliability} />
        </div>
        <SourceText as="h3">{asset.item.title}</SourceText>
        <SourceText as="p" className="method-ticket__summary">{asset.item.summary}</SourceText>
        <div className="method-ticket__decision">
          <StatusBadge value={recommendation.label} showHelp={false} />
          <InfoHint label="为什么这样推荐" help={`${recommendation.reason} ${recommendation.help}`} />
        </div>
        <Button className={`action-button method-ticket__action action-button--${recommendation.state === "ready" ? "teal" : recommendation.state === "inspect" ? "violet" : "soft"}`} variant="outline" onClick={() => onCopy(request, actionLabel)}>
          <Sparkles aria-hidden="true" />
          {actionLabel}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    </article>
  );
}

function ExportedSkillDetailDialog({
  item,
  onCopy,
  onClose,
}: {
  item: ExportedSkillItem | null;
  onCopy: CopyRequest;
  onClose: () => void;
}) {
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  if (!item) return null;
  const view = exportedSkillView(item);
  const action = buildSkillExportAction(item);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="skill-export-dialog sm:max-w-[660px]"
        onOpenAutoFocus={(event) => {
          openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          openerRef.current?.focus({ preventScroll: true });
          openerRef.current = null;
        }}
      >
        <DialogHeader>
          <div className="skill-export-dialog__eyebrow"><PackageOpen aria-hidden="true" />我的 Skill <InfoHint label="看板展示范围" help="这里显示的是这份 Skill 的低敏说明，不包含来源路径或私密内容。" /></div>
          <DialogTitle ref={titleRef} tabIndex={-1} className="skill-export-dialog__title"><SourceText>{item.title}</SourceText></DialogTitle>
        </DialogHeader>

        <div className="skill-export-dialog__facts">
          <section className="skill-export-dialog__purpose">
            <span>这个 Skill 是做什么的</span>
            <SourceText as="p">{item.summary}</SourceText>
          </section>
          <section>
            <span>现在是什么状态</span>
            <StatusBadge value={view.label} helpText={view.help} />
          </section>
          <section>
            <span>分享方式与文件</span>
            <div className="compact-fact"><strong>{view.deliveryTitle}</strong><InfoHint label="分享文件说明" help={view.deliveryCopy} /></div>
          </section>
          <section className="skill-export-dialog__next">
            <span>接下来可以做什么</span>
            <p>{view.nextStep}</p>
          </section>
        </div>

        <div className="skill-export-dialog__assurances" role="note">
          <span><ShieldCheck aria-hidden="true" />看板不展示私密位置<InfoHint label="隐私展示范围" help="这里只显示用途和状态；来源路径、原始资产编号和实例身份不会出现在看板里。" /></span>
          <span><ClipboardCopy aria-hidden="true" />按钮只复制请求<InfoHint label="按钮怎样工作" help="把复制的请求发给 Agent 后才会继续；网页不会直接改文件、联网或替你发送。" /></span>
        </div>
        <DialogFooter className="skill-export-dialog__footer">
          <Button variant="outline" onClick={onClose}>关闭</Button>
          <Button
            className="skill-export-dialog__action"
            onClick={() => {
              onClose();
              onCopy(action.text, action.buttonLabel);
            }}
          >
            <ClipboardCopy aria-hidden="true" />
            {action.buttonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InstalledSkillDetailDialog({
  item,
  onCopy,
  onClose,
}: {
  item: InstalledSkillItem | null;
  onCopy: CopyRequest;
  onClose: () => void;
}) {
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  if (!item) return null;
  const repairAction = item.state === "available" ? null : buildInstalledSkillRepairAction(item);
  const nextStep = item.state === "available"
    ? "相关任务出现时会自动按需读取；你也可以直接告诉 Agent 想用它完成什么。"
    : item.state === "review"
      ? "让 Agent 只检查这一项，说明需要复核的入口、依赖、权限或兼容问题，并处理能安全修复的部分。"
      : "让 Agent 只诊断这一项，能恢复就局部恢复；需要安装、权限或联网时再让你决定。";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="skill-export-dialog installed-skill-dialog sm:max-w-[660px]"
        onOpenAutoFocus={(event) => {
          openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          openerRef.current?.focus({ preventScroll: true });
          openerRef.current = null;
        }}
      >
        <DialogHeader>
          <div className="skill-export-dialog__eyebrow installed-skill-dialog__eyebrow"><Download aria-hidden="true" />已安装 Skill</div>
          <DialogTitle ref={titleRef} tabIndex={-1} className="skill-export-dialog__title"><SourceText>{item.title}</SourceText></DialogTitle>
        </DialogHeader>
        <div className="skill-export-dialog__facts">
          <section className="skill-export-dialog__purpose"><span>这个 Skill 是做什么的</span><SourceText as="p">{item.summary}</SourceText></section>
          <section><span>现在是什么状态</span><StatusBadge value={item.state} helpText={INSTALLED_SKILL_HELP[item.state]} /></section>
          <section><span>适用平台</span><strong>{item.platform ? <SourceText>{item.platform}</SourceText> : "未单独限制"}</strong></section>
          <section className="skill-export-dialog__next"><span>接下来可以做什么</span><p>{nextStep}</p></section>
          {item.triggers.length ? <section className="installed-skill-dialog__triggers"><span>这些任务可能会用到</span><div>{item.triggers.slice(0, 3).map((trigger) => <SourceText key={trigger}>“{trigger}”</SourceText>)}</div></section> : null}
        </div>
        <div className="skill-export-dialog__assurances" role="note">
          <span><ShieldCheck aria-hidden="true" />问题只影响这一项 Skill</span>
          <span><ClipboardCopy aria-hidden="true" />处理按钮只复制明确请求</span>
        </div>
        <DialogFooter className="skill-export-dialog__footer">
          <Button variant="outline" onClick={onClose}>关闭</Button>
          {repairAction ? (
            <Button className="action-button action-button--violet installed-skill-dialog__action" onClick={() => { onClose(); onCopy(repairAction.text, repairAction.buttonLabel); }}>
              <Sparkles aria-hidden="true" />{repairAction.buttonLabel}<ArrowRight aria-hidden="true" />
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SkillWorkshop({ onCopy }: { onCopy: CopyRequest }) {
  const reduced = useReducedMotion();
  const [activeTab, setActiveTab] = useState<WorkshopTab>("methods");
  const [selectedExport, setSelectedExport] = useState<ExportedSkillItem | null>(null);
  const [selectedInstalled, setSelectedInstalled] = useState<InstalledSkillItem | null>(null);
  const installAction = getGlobalActions().find((action) => action.action_id === "skill.install-shared");
  const assets: WorkshopAsset[] = [
    ...sops.map((item) => ({ kind: "sop" as const, item })),
    ...capabilities.map((item) => ({ kind: "capability" as const, item })),
  ];
  const ranked = assets
    .map((asset) => ({ asset, rank: recommendForSkillWorkshop(asset.kind, asset.item).state === "ready" ? 0 : recommendForSkillWorkshop(asset.kind, asset.item).state === "inspect" ? 1 : 2 }))
    .sort((left, right) => left.rank - right.rank)
    .slice(0, 8)
    .map(({ asset }) => asset);
  const instanceReady = profile.state === "instance";
  const tabs: Array<{ id: WorkshopTab; label: string; count?: number; icon: typeof Workflow; tone: "teal" | "violet" }> = [
    { id: "methods", label: "Agent 推荐整理的 Skill", count: ranked.length, icon: Workflow, tone: "teal" },
    { id: "mine", label: "我的 Skill", count: skills.exports.length, icon: PackageOpen, tone: "teal" },
    { id: "installed", label: "已安装 Skill", count: skills.items.length, icon: Download, tone: "violet" },
    { id: "import", label: "接入 Skill", icon: Upload, tone: "violet" },
  ];

  return (
    <div className="skill-workshop-page">
      <header className="workshop-command-head">
        <div>
          <SectionEyebrow icon={Sparkles}>Skill 工坊</SectionEyebrow>
          <div className="heading-with-hint"><h1>Skill 工坊</h1><InfoHint label="Skill 工坊怎样工作" help="这里可以把已经验证的方法整理成 Skill、管理自己的 Skill、查看已安装内容，或检查别人分享的 Skill。任何转换和安装都从你主动选择后开始。" /></div>
        </div>
        <p>{instanceReady ? "整理自己的方法，也能接入别人分享的 Skill。" : "创建助手后，这里会出现真实方法和已安装 Skill。"}</p>
      </header>

      <div className="workshop-tabs" role="tablist" aria-label="Skill 工坊内容分类">
        {tabs.map(({ id, label, count, icon: Icon, tone }) => (
          <button
            key={id}
            id={`workshop-tab-${id}`}
            type="button"
            role="tab"
            aria-controls={`workshop-panel-${id}`}
            aria-selected={activeTab === id}
            aria-label={label}
            title={label}
            data-tone={tone}
            onClick={() => setActiveTab(id)}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
            {typeof count === "number" ? <strong>{count}</strong> : null}
          </button>
        ))}
      </div>

      <motion.section
        key={activeTab}
        id={`workshop-panel-${activeTab}`}
        className={`workshop-panel workshop-panel--${activeTab}`}
        role="tabpanel"
        aria-labelledby={`workshop-tab-${activeTab}`}
        initial={reduced ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 0.84, 0.3, 1] }}
      >
        {activeTab === "methods" ? (
          <section className="method-shelf method-shelf--essential">
              <div className="workshop-panel-note"><Workflow aria-hidden="true" /><span><strong>选一个方法即可开始</strong><small>Agent 会询问分享方式，并自动处理副本与隐私。</small></span><InfoHint label="推荐与整理说明" help="推荐只是建议，不会自动转换原来的 SOP 或能力。你主动选择后，Agent 才会询问要 ZIP、独立文件夹、链接还是仅保存在本机，并在隔离副本中完成检查与生成。" /></div>
              {ranked.length ? (
                <div className="method-ticket-stack">
                  {ranked.map((asset) => <MethodTicket key={`${asset.kind}-${asset.item.id}`} asset={asset} onCopy={onCopy} />)}
                </div>
              ) : (
                <div className="workshop-empty">
                  <Workflow aria-hidden="true" />
                  <strong>还没有适合推荐的方法</strong>
                  <span>完成真实任务并形成 SOP 后，这里会按当前证据给出建议；不会为了填满页面制造内容。</span>
                </div>
              )}
          </section>
        ) : null}

        {activeTab === "mine" ? (
          <aside className="skill-ledger skill-ledger--single" aria-label="我的 Skill">
            <div className="workshop-panel-note"><ShieldCheck aria-hidden="true" /><span><strong>这里显示可编辑真源和分享状态</strong><small>本机路径、来源身份和分享链接不会出现在看板。</small></span><InfoHint label="我的 Skill 展示范围" help="点开一项可以查看用途、当前载体和下一步；工坊只显示低敏状态，不展示来源地址、本机路径、分享链接或原始资产 ID。" /></div>
            <div className="ledger-block ledger-block--plain">
              {skills.exports.length ? (
                <ul>{skills.exports.map((item) => {
                  const view = exportedSkillView(item);
                  return (
                    <li key={item.id} className="skill-ledger-row">
                      <button type="button" className="skill-ledger-row__open" onClick={() => setSelectedExport(item)}>
                        <span className="skill-ledger-row__copy"><SourceText as="strong">{item.title}</SourceText><SourceText as="span">{item.summary}</SourceText></span>
                        <span className="skill-ledger-row__hint">查看详情<ChevronRight aria-hidden="true" /></span>
                      </button>
                      <span className="skill-ledger-row__status"><StatusBadge value={view.label} helpText={view.help} /></span>
                    </li>
                  );
                })}</ul>
              ) : <p>{snapshotAreaDegraded("skills") ? isolatedContentMessage : "还没有自己的 Skill。选择一个已验证的方法后即可开始整理。"}</p>}
            </div>
          </aside>
        ) : null}

        {activeTab === "installed" ? (
          <aside className="skill-ledger skill-ledger--single skill-ledger--installed" aria-label="已安装 Skill">
            <div className="workshop-panel-note"><Download aria-hidden="true" /><span><strong>{skills.items.length} 个 Skill 已登记</strong><small>相关任务出现时按需读取，不会一次全部加载。</small></span><InfoHint label="已安装 Skill 状态" help="需要复核或暂时不可用的 Skill 只会隔离自身，不影响 AI Carry 主体和其他 Skill。安装入口、来源地址和本机路径不会显示在看板。" /></div>
            <div className="ledger-block ledger-block--plain ledger-block--installed">
              {skills.items.length ? (
                <ul>{skills.items.map((item) => (
                  <li key={item.id} className="skill-ledger-row skill-ledger-row--installed">
                    <button type="button" className="skill-ledger-row__open" onClick={() => setSelectedInstalled(item)}>
                      <span className="skill-ledger-row__copy"><SourceText as="strong">{item.title}</SourceText><SourceText as="span">{item.summary}</SourceText></span>
                      <span className="skill-ledger-row__hint">查看详情<ChevronRight aria-hidden="true" /></span>
                    </button>
                    <span className="skill-ledger-row__status"><StatusBadge value={item.state} helpText={INSTALLED_SKILL_HELP[item.state]} /></span>
                  </li>
                ))}</ul>
              ) : <p>{snapshotAreaDegraded("skills") ? isolatedContentMessage : skills.status || "还没有登记已安装 Skill。"}</p>}
            </div>
          </aside>
        ) : null}

        {activeTab === "import" ? (
          <section className="workshop-import-essential">
            <div className="workshop-import-essential__lead">
              <span><Download aria-hidden="true" /></span>
              <div><h2>把你拿到的 Skill 交给 Agent</h2><p>文件夹、ZIP、链接都可以；不知道类型也可以直接说。</p></div>
              <InfoHint label="接入 Skill 怎样完成" help="点击按钮复制请求并发给 Agent。它会引导你提供位置或链接，先在本机检查用途、脚本、依赖、权限和冲突，再让你确认是否安装；问题只隔离这一份 Skill。" />
            </div>
            <div className="workshop-source-chips" aria-label="支持的 Skill 来源">
              <span><FolderOpen aria-hidden="true" />本地文件夹</span>
              <span><FileArchive aria-hidden="true" />ZIP 文件</span>
              <span><Link2 aria-hidden="true" />Skill 链接</span>
              <span><CircleHelp aria-hidden="true" />我不确定</span>
            </div>
            <div className="workshop-import-essential__action">
              <span><ShieldCheck aria-hidden="true" />先检查这一份，其他能力照常使用</span>
              <Button
                className="workshop-install-action"
                disabled={!instanceReady || !installAction}
                onClick={() => { if (installAction) onCopy(installAction.request, installAction.label); }}
              >
                <Upload aria-hidden="true" />
                {instanceReady ? "复制检查请求" : "创建助手后使用"}
              </Button>
            </div>
          </section>
        ) : null}
      </motion.section>
      <ExportedSkillDetailDialog item={selectedExport} onCopy={onCopy} onClose={() => setSelectedExport(null)} />
      <InstalledSkillDetailDialog item={selectedInstalled} onCopy={onCopy} onClose={() => setSelectedInstalled(null)} />
    </div>
  );
}
