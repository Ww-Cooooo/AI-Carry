import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleHelp,
  ClipboardCopy,
  Cpu,
  Database,
  Download,
  FileArchive,
  FileCheck2,
  FileText,
  GitBranch,
  HardDrive,
  History,
  Library,
  Lightbulb,
  LockKeyhole,
  MessageCircleMore,
  PackageOpen,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import Core from "@/components/three/Core";
import { GuidanceModeDialog, OnboardingDialog } from "@/components/dashboard/OnboardingDialog";
import { Button } from "@/components/ui/button";
import { localizeText } from "@/lib/i18n";
import { DashboardScrollRootContext } from "@/lib/scroll-root";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CATEGORIES,
  GROWTH_KINDS,
  LIBRARY_KINDS,
  ORBIT_PLANETS,
  categoryFor,
  routeForOrbit,
  type GrowthKind,
  type LibraryKind,
  type RouteState,
} from "@/dashboard-config";
import {
  advanced,
  assets,
  buildDashboardAction,
  capabilities,
  evolution,
  experiences,
  getGlobalActions,
  getSnapshotStatus,
  isolatedContentMessage,
  snapshotAreaDegraded,
  governance,
  assetMaturityStatusToken,
  assetUsagePresentation,
  habitPresentation,
  memories,
  meta,
  overview,
  profile,
  skills,
  sops,
  todo,
  type GlobalActionDef,
} from "@/lib/data";
import {
  EmptyState,
  InfoHint,
  SectionEyebrow,
  SourceText,
  StatusBadge,
  type DetailItem,
  type DetailState,
} from "@/components/dashboard/Shared";

type Navigate = (route: RouteState) => void;
type CopyRequest = (text: string, label: string) => void;
type Inspect = (detail: DetailState) => void;

function findAction(id: string): GlobalActionDef | undefined {
  return getGlobalActions().find((action) => action.action_id === id);
}

function categoryCount(key: string): number {
  const counts: Record<string, number> = {
    memories: memories.length,
    sops: sops.length,
    capabilities: capabilities.length,
    todos: todo.filter((item) => item.visible).length,
    experiences: experiences.length,
    governance: governance.length,
    evolution: evolution.length,
    model: profile.modelStatus === "confirmed" ? 1 : 0,
  };
  return counts[key] ?? 0;
}

function carriedAssetCount(): number {
  return (
    memories.length +
    sops.length +
    capabilities.length +
    experiences.length +
    evolution.length +
    governance.length +
    todo.filter((item) => item.visible).length
  );
}

function libraryAssetCount(): number {
  return memories.length + sops.length + capabilities.length + experiences.length;
}

const REVEAL_INITIAL = { opacity: 0, y: 28, scale: 0.988 };
const REVEAL_VISIBLE = { opacity: 1, y: 0, scale: 1 };
const REVEAL_VIEWPORT = { once: true, amount: 0.12, margin: "0px 0px -8% 0px" } as const;
const REVEAL_EASE = [0.16, 0.84, 0.3, 1] as const;

function revealTransition(delay = 0) {
  return { duration: 0.56, delay, ease: REVEAL_EASE };
}

function useRevealViewport() {
  const root = useContext(DashboardScrollRootContext);
  return root ? { ...REVEAL_VIEWPORT, root } : REVEAL_VIEWPORT;
}

function StartActionButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <div className="start-cta-wrap">
      <Button className="primary-cta start-cta" onClick={onClick}>
        <span className="start-cta__label"><Sparkles aria-hidden="true" />{children}</span>
        <ArrowRight aria-hidden="true" />
      </Button>
    </div>
  );
}

export function HomeView({
  onNavigate,
  onCopy,
}: {
  onNavigate: Navigate;
  onCopy: CopyRequest;
}) {
  const isTemplate = profile.state === "template";
  const pending = todo.filter((item) => item.visible && item.status !== "done");
  const instantiate = findAction("instance.instantiate");
  const firstTodoAction = pending[0] ? buildDashboardAction("todos", pending[0]) : null;
  const carryCount = carriedAssetCount();
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const selectOrbit = useCallback((key: string) => onNavigate(routeForOrbit(key)), [onNavigate]);

  const headline = isTemplate
    ? "让你的 AI 助手，越用越懂你"
    : pending.length
      ? pending[0].title
      : snapshotAreaDegraded("todo") ? "待办暂未完整显示" : "今天没有需要继续的待办";
  const intro = isTemplate
    ? "记住你的习惯，沉淀你的方法。换模型、换 Agent、换电脑，也能继续。"
    : pending.length
      ? pending[0].summary || "从这项待办继续。"
      : snapshotAreaDegraded("todo") ? isolatedContentMessage : "直接告诉 Agent 今天想做什么，需要的内容会按任务读取。";

  return (
    <div className="page-stack home-view home-view--essential">
      <section className="home-command" aria-labelledby="home-title">
        <div className="home-command__copy">
          <div className="home-command__topline">
            <SectionEyebrow icon={isTemplate ? Sparkles : Lightbulb}>{isTemplate ? "你的 AI 随身助手" : <>当前助手 · <SourceText>{profile.displayName}</SourceText></>}</SectionEyebrow>
            <span className="local-indicator"><i /> 保存在本机</span>
          </div>

          <div className="home-command__message">
            {isTemplate ? (
              <h1 id="home-title" aria-label={headline}>
                <span>让你的 AI 助手</span>
                <strong>越用越懂你</strong>
              </h1>
            ) : (
              <h1 id="home-title">{pending.length ? <SourceText>{headline}</SourceText> : headline}</h1>
            )}
            {isTemplate || !pending.length ? <p>{intro}</p> : <SourceText as="p">{intro}</SourceText>}
          </div>

          {isTemplate ? (
            <div className="home-command__action">
              {instantiate ? <StartActionButton onClick={() => setOnboardingOpen(true)}>创建我的助手</StartActionButton> : null}
              <span className="home-command__assurance"><ShieldCheck aria-hidden="true" /><strong>创建前先看完整预览</strong><InfoHint label="第一次创建说明" help="Agent 会引导你选择交流方式和助手方向；正式保存前会展示完整预览，网页本身不会直接修改或锁定内容。" /></span>
            </div>
          ) : pending.length ? (
            <div className="home-command__action">
              {pending.length > 1 ? <span className="home-command__remaining">另外还有 {pending.length - 1} 项待办</span> : null}
              {firstTodoAction ? <StartActionButton onClick={() => onCopy(firstTodoAction.text, firstTodoAction.buttonLabel)}>继续这项待办</StartActionButton> : null}
            </div>
          ) : (
            <div className="home-command__action">
              <span className="compact-fact"><strong>当前任务需要什么，就读取什么</strong><InfoHint label="按需读取" help="记忆、流程、能力和经验保存在本地；开始任务后只读取相关内容，不会每次启动都全部加载。" /></span>
              <Button variant="outline" className="secondary-cta" onClick={() => onNavigate({ page: "library", kind: "memories" })}>查看随身资产<ArrowRight aria-hidden="true" /></Button>
            </div>
          )}

          <div className="home-command__promises" aria-label="AI Carry 的三项核心价值">
            <div><span>01</span><strong>记得住</strong><small>习惯与经验</small></div>
            <div><span>02</span><strong>用得上</strong><small>相关时自动调用</small></div>
            <div><span>03</span><strong>带得走</strong><small>换环境也能继续</small></div>
          </div>
        </div>

        <div className="home-command__visual" aria-label={`当前保存 ${carryCount} 项内容`}>
          <div className="home-command__visual-heading" aria-hidden="true">
            <span>AI CARRY</span>
            <small>PORTABLE INTELLIGENCE</small>
          </div>
          <Core planets={ORBIT_PLANETS} onSelect={selectOrbit} className="home-command__core" />
          <div className="home-command__count"><strong>{carryCount}</strong><span>项随身内容</span></div>
        </div>

        <nav className="carry-index" aria-label="查看随身内容">
          <div className="carry-index__lead"><Library aria-hidden="true" /><span><strong>随身内容</strong><small>需要时自动读取</small></span></div>
          {CATEGORIES.map((category) => (
            <button
              key={category.key}
              type="button"
              data-full-label={localizeText(category.shortLabel)}
              onClick={() => onNavigate(routeForOrbit(category.key))}
              style={{ "--category-color": category.color } as React.CSSProperties}
            >
              <span className="carry-index__dot" />
              <span>{category.shortLabel}</span>
              <strong>{categoryCount(category.key)}</strong>
            </button>
          ))}
        </nav>
      </section>
      {instantiate ? (
        <OnboardingDialog
          open={onboardingOpen}
          onOpenChange={setOnboardingOpen}
          baseRequest={instantiate.request}
          onCopy={onCopy}
        />
      ) : null}
    </div>
  );
}

function libraryItems(kind: LibraryKind): DetailItem[] {
  if (kind === "memories") return memories.map((item) => ({ ...item }));
  if (kind === "sops") return sops.map((item) => ({ ...item }));
  if (kind === "capabilities") return capabilities.map((item) => ({ ...item }));
  return experiences.map((item) => ({ ...item }));
}

const LIBRARY_EMPTY: Record<LibraryKind, { title: string; description: string }> = {
  memories: { title: "还没有长期记忆", description: "先正常使用助手。以后还会用到的事实、偏好和要求，会保存到这里。" },
  sops: { title: "还没有固定流程", description: "当一种任务重复出现，并且做法已经在真实任务中验证过，才会整理成固定流程。" },
  capabilities: { title: "还没有记录能力", description: "助手会在真实任务中记录自己会做什么，并逐步验证这些能力是否可靠。" },
  experiences: { title: "还没有任务经验", description: "完成真实任务后，值得保留的成功做法和失败教训会记录在这里。" },
};

const LIBRARY_GUIDANCE: Record<LibraryKind, string> = {
  memories: "保存稳定事实、长期要求和你的习惯；只在当前任务相关时读取。",
  sops: "保存已经在真实任务中验证过的固定流程；点开可以查看用途和适用范围。",
  capabilities: "记录助手已经证明会做的事情；可靠程度和使用状态会随实际证据更新。",
  experiences: "保存值得复用的成功做法和失败教训；只在相似任务出现时参考。",
};

export function LibraryView({
  kind,
  onNavigate,
  onCopy,
  onInspect,
}: {
  kind: LibraryKind;
  onNavigate: Navigate;
  onCopy: CopyRequest;
  onInspect: Inspect;
}) {
  const reduced = useReducedMotion();
  const revealViewport = useRevealViewport();
  const [query, setQuery] = useState("");
  const items = libraryItems(kind);
  const category = categoryFor(kind);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () => items.filter((item) => {
      if (!normalized) return true;
      const searchable = [
        item.title,
        item.summary,
        item.scopeSummary,
        item.sourceSummary,
        ...(item.triggers ?? []),
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return searchable.includes(normalized);
    }),
    [items, normalized],
  );
  const habitItems = kind === "memories" ? filtered.filter((item) => item.subtype === "habit") : [];
  const regularItems = kind === "memories" ? filtered.filter((item) => item.subtype !== "habit") : filtered;
  const instantiate = findAction("instance.instantiate");

  const renderAssetCards = (cardItems: DetailItem[], section?: { title: string; description: string; tone: "habit" | "regular" }) => (
    <div className={`library-asset-section ${section ? `library-asset-section--${section.tone}` : ""}`}>
      {section ? (
        <header className="library-asset-section__head">
          <div><span>{section.tone === "habit" ? "默认自动按需 · 手动管理备用" : kind === "memories" ? "默认自动按需 · 手动指定备用" : "长期保留 · 任务命中后读取"}</span><div className="heading-with-hint"><h2>{section.title}</h2><InfoHint label={`${section.title}说明`} help={section.description} /></div></div>
        </header>
      ) : null}
      <section className="asset-card-grid" aria-live="polite">
        {cardItems.map((item, index) => {
          const action = buildDashboardAction(kind, item);
          const isHabit = kind === "memories" && item.subtype === "habit";
          const habit = isHabit ? habitPresentation(item.status, item.approvalState, item.activationBasis, item.riskTier, item.approvedByUser) : null;
          const usage = isHabit ? null : assetUsagePresentation(kind, item);
          const maturityStatus = !isHabit ? assetMaturityStatusToken(kind, item) : undefined;
          return (
            <motion.article
              key={`${item.id || "missing-asset"}-${index}`}
              className={`content-card content-card--${kind} render-deferred ${isHabit ? `content-card--habit content-card--habit-${habit?.key}` : ""}`}
              data-reveal-card
              style={{ "--category-color": category.color } as React.CSSProperties}
              initial={reduced ? false : REVEAL_INITIAL}
              whileInView={reduced ? undefined : REVEAL_VISIBLE}
              viewport={revealViewport}
              transition={reduced ? undefined : revealTransition((index % 2) * 0.075)}
            >
              <button type="button" className="content-card__open" onClick={() => onInspect({ kind, item })}>
                <span className="content-card__icon"><category.icon aria-hidden="true" /></span>
                <SourceText className="content-card__title">{item.title}</SourceText>
                <ChevronRight aria-hidden="true" />
              </button>
              {item.summary ? <SourceText as="p" className="content-card__summary">{item.summary}</SourceText> : <p className="content-card__summary">这条内容还没有用途说明，请让 Agent 补充后重新生成看板数据。</p>}
              <div className="content-card__meta">
                {kind === "memories" ? (
                  isHabit ? (
                    <>
                      <span className="habit-memory-badge"><Sparkles aria-hidden="true" />我的习惯 · {habit?.label}</span>
                    </>
                  ) : (
                    <>
                      <span className="content-card__states">
                        <span><small>使用</small><StatusBadge value={usage?.statusToken} showHelp={usage?.key === "unknown"} helpText={usage?.behaviorSummary} /></span>
                      </span>
                    </>
                  )
                ) : (
                  <>
                    <span className="content-card__states">
                      <span><small>使用</small><StatusBadge value={usage?.statusToken} showHelp={usage?.key === "unknown"} helpText={usage?.behaviorSummary} /></span>
                      {maturityStatus ? <span><small>成熟度</small><StatusBadge value={maturityStatus} showHelp={false} /></span> : null}
                    </span>
                  </>
                )}
              </div>
              {isHabit ? (
                <Button variant="ghost" className="card-action card-action--memory card-action--habit-manage" onClick={() => onInspect({ kind, item })}>
                  <Sparkles aria-hidden="true" />
                  查看与管理
                </Button>
              ) : (
                <Button variant="ghost" className={`card-action ${kind === "memories" ? "card-action--memory" : ""}`} onClick={() => onCopy(action.text, action.buttonLabel)}>
                  <ClipboardCopy aria-hidden="true" />
                  {action.buttonLabel}
                </Button>
              )}
            </motion.article>
          );
        })}
      </section>
    </div>
  );

  return (
    <div className="page-stack">
      <section className="page-intro page-intro--compact">
        <div>
          <SectionEyebrow icon={Library}>随身资产</SectionEyebrow>
          <div className="heading-with-hint"><h1>{category.label}</h1><InfoHint label={`${category.label}说明`} help={LIBRARY_GUIDANCE[kind]} /></div>
        </div>
        <div className="page-intro__number"><strong>{libraryAssetCount()}</strong><span>项内容</span></div>
      </section>

      <div className="category-toolbar">
        <div className="category-tabs" role="tablist" aria-label="随身资产分类">
          {LIBRARY_KINDS.map((tab) => {
            const metaItem = categoryFor(tab);
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={tab === kind}
                onClick={() => onNavigate({ page: "library", kind: tab })}
              >
                <metaItem.icon aria-hidden="true" />
                <span>{metaItem.label}</span>
                <strong>{categoryCount(tab)}</strong>
              </button>
            );
          })}
        </div>
        <label className="search-field">
          <Search aria-hidden="true" />
          <span className="sr-only">搜索当前分类，可匹配标题、触发语和适用范围</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、常用说法或适用范围" />
          {query ? <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X aria-hidden="true" /></button> : null}
        </label>
      </div>

      {filtered.length ? (
        kind === "memories" ? (
          <>
            {habitItems.length ? renderAssetCards(habitItems, { title: "我的习惯", description: "直接像平常一样说要做什么；相关任务命中后，已启用习惯会自动沿用，试用习惯只在确认范围内使用。需要复核或已经停止的记录不会自动使用。", tone: "habit" }) : null}
            {regularItems.length ? renderAssetCards(regularItems, habitItems.length ? { title: "其他长期记忆", description: "保存稳定事实、背景和长期要求；只在当前任务相关时读取。", tone: "regular" } : undefined) : null}
          </>
        ) : renderAssetCards(regularItems)
      ) : (
        <EmptyState
          icon={category.icon}
          title={snapshotAreaDegraded(kind) ? "部分内容暂未显示" : query ? "没有找到相关内容" : LIBRARY_EMPTY[kind].title}
          description={snapshotAreaDegraded(kind) ? isolatedContentMessage : query ? "换一个更短的关键词，或者清除搜索查看全部内容。" : LIBRARY_EMPTY[kind].description}
          action={profile.state === "template" && instantiate ? (
            <Button className="primary-cta" onClick={() => onNavigate({ page: "home" })}>回到总览创建助手</Button>
          ) : undefined}
        />
      )}

    </div>
  );
}

function growthItems(kind: GrowthKind): DetailItem[] {
  if (kind === "todos") return todo.filter((item) => item.visible).map((item) => ({ ...item }));
  if (kind === "evolution") return evolution.map((item) => ({ ...item }));
  return governance.map((item) => ({ ...item }));
}

const GROWTH_COPY: Record<GrowthKind, { title: string; intro: string; empty: string }> = {
  todos: {
    title: "你的待办事项",
    intro: "这里只显示你明确要求保存的待办。完成后可以从看板隐藏，记录仍会保留在本地。",
    empty: "目前没有待办。直接告诉 Agent 今天想做什么即可。",
  },
  evolution: {
    title: "看看助手最近学到了什么",
    intro: "这里是从真实任务中发现、还没有正式保存的做法。先确认以后是否有用，再决定保存成记忆、能力、经验或固定流程。",
    empty: "目前没有需要确认的学习建议。没有新发现时，任务会正常结束。",
  },
  governance: {
    title: "定期看看助手有没有更好的做法",
    intro: "这里有三项长期改进：记忆与检索、组件配合、安全防护。日期到了只提醒一次；你选中一项后，Level 3 才开始调研。",
    empty: profile.state === "template"
      ? "模板包含三项长期改进，但不会带入示例日期。创建助手后，第一次提醒日期会从实际创建时间开始计算。"
      : "目前没有长期改进项目。它们不会自动联网，也不会在后台运行。",
  },
};

export function GrowthView({
  kind,
  onNavigate,
  onCopy,
  onInspect,
}: {
  kind: GrowthKind;
  onNavigate: Navigate;
  onCopy: CopyRequest;
  onInspect: Inspect;
}) {
  const reduced = useReducedMotion();
  const revealViewport = useRevealViewport();
  const items = growthItems(kind);
  const category = categoryFor(kind);
  const copy = GROWTH_COPY[kind];

  return (
    <div className="page-stack">
      <section className="page-intro page-intro--compact">
        <div>
          <SectionEyebrow icon={Sparkles}>待办与成长</SectionEyebrow>
          <h1>{copy.title}</h1>
          <p className="intro-with-help">只显示现在需要关注的内容。<InfoHint label={`${copy.title}说明`} help={copy.intro} /></p>
        </div>
        <div className="page-intro__number"><strong>{items.length}</strong><span>{category.shortLabel}</span></div>
      </section>

      <div className="category-tabs growth-tabs" role="tablist" aria-label="成长与待办分类">
        {GROWTH_KINDS.map((tab) => {
          const metaItem = categoryFor(tab);
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={tab === kind}
              onClick={() => onNavigate({ page: "growth", kind: tab })}
            >
              <metaItem.icon aria-hidden="true" />
              <span>{metaItem.label}</span>
              <strong>{categoryCount(tab)}</strong>
            </button>
          );
        })}
      </div>

      {items.length ? (
        <section className="growth-list">
          {items.map((item, index) => {
            const action = buildDashboardAction(kind, item);
            const done = kind === "todos" && item.status === "done";
            return (
              <motion.article
                key={`${item.id || "missing-growth-item"}-${index}`}
                className={`growth-row render-deferred ${done ? "is-done" : ""}`}
                data-reveal-card
                initial={reduced ? false : REVEAL_INITIAL}
                whileInView={reduced ? undefined : REVEAL_VISIBLE}
                viewport={revealViewport}
                transition={reduced ? undefined : revealTransition(Math.min(index, 3) * 0.045)}
              >
                <div className="growth-row__index">
                  {done ? <CheckCircle2 aria-hidden="true" /> : kind === "todos" ? <Circle aria-hidden="true" /> : <span>{String(index + 1).padStart(2, "0")}</span>}
                </div>
                <button type="button" className="growth-row__main" onClick={() => onInspect({ kind, item })}>
                  <SourceText className="growth-row__title">{item.title}</SourceText>
                  {item.summary ? <SourceText className="growth-row__summary">{item.summary}</SourceText> : <span className="growth-row__summary">这条内容还没有用途说明，请让 Agent 补充后重新生成看板数据。</span>}
                </button>
                <div className="growth-row__status">
                  <StatusBadge value={item.reliability ?? item.status} />
                  {item.frequency ? <SourceText>{item.frequency}</SourceText> : null}
                </div>
                <Button variant="outline" className={`row-action ${done ? "row-action--hide" : ""}`} onClick={() => onCopy(action.text, action.buttonLabel)}>
                  <ClipboardCopy aria-hidden="true" />
                  <span>{action.buttonLabel}</span>
                </Button>
              </motion.article>
            );
          })}
        </section>
      ) : (
        <EmptyState icon={category.icon} title={snapshotAreaDegraded(kind) ? "部分内容暂未显示" : `暂无${category.label}`} description={snapshotAreaDegraded(kind) ? isolatedContentMessage : copy.empty} />
      )}

    </div>
  );
}

const SECONDARY_ACTION_META = {
  "dashboard.refresh-snapshot": {
    icon: RefreshCw,
    description: "从正式内容重新生成看板数据",
  },
  "preference.reuse-from-instance": {
    icon: Sparkles,
    description: "只复用沟通方式和工作习惯",
  },
  "instance.upgrade-template": {
    icon: Upload,
    description: "检查新版并保留个人内容",
  },
} as const;

type MigrationGuideMode = "complete" | "coverage" | "private-export" | "private-import";
type MigrationGuideChoice = "current" | "supplement" | "unsure";

function choiceInstruction(mode: MigrationGuideMode, choice: MigrationGuideChoice): string {
  if (mode === "complete") {
    if (choice === "current") {
      return "我已在看板选择“按当前清单继续迁移”。请先用普通语言列出你已经知道并将纳入的助手内容与本地资料，然后按当前清单继续；不要重新询问同一选择，也不要让我重新提供你已经知道的路径。";
    }
    if (choice === "supplement") {
      return "我已在看板选择“先补充以前的资料，再继续迁移”。请先一步一步帮助我补充接入 AI Carry 前已有、由其他软件产生或被我手动移动的资料；补充并确认后在同一次对话中直接继续完整迁移，不要让我返回看板重新复制指令。";
    }
    return "我已在看板选择“我不确定，请帮我检查”。请先根据我的职业、最近任务和已经登记的内容，列出可能遗漏的资料类别；不要扫描整台电脑，一次只问一个真正会改变迁移范围的问题。判断完成后在同一次对话中继续完整迁移。";
  }

  if (mode === "private-export") {
    if (choice === "current") {
      return "我已在看板选择“按当前资料范围直接导出”。请先用普通语言列出已经登记、正式引用和准备纳入的本地隐私资料；确认范围后，在本地生成完整隐私资料输出文件夹。不要让我重新提供你已经知道的路径，不要上传到 GitHub 或其他远程位置。";
    }
    if (choice === "supplement") {
      return "我已在看板选择“先补充以前的资料，再导出”。请先一步一步帮助我补充接入 AI Carry 前已有、由其他软件产生或被我手动移动的资料；补充并确认后，在同一次对话中继续生成本地隐私资料输出文件夹，不要让我返回看板重新开始。";
    }
    return "我已在看板选择“我不确定，请帮我检查”。请根据我的职业、最近任务和已经登记的内容提示可能遗漏的资料类别；不要扫描整台电脑，一次只问一个会改变导出范围的问题。判断并确认后，在同一次对话中继续本地导出。";
  }

  if (mode === "private-import") {
    if (choice === "current") {
      return "我已在看板选择“我有完整的输出文件夹”。请让我用普通语言告诉你这个文件夹的位置；先校验入口、全部分卷、文件清单、摘要和冲突，再给我恢复预览。没有通过校验前不要写入，不能只导入其中一个 ZIP。";
    }
    if (choice === "supplement") {
      return "我已在看板选择“我不确定手里的文件是否完整”。请先用普通语言告诉我怎样识别完整输出文件夹，再根据我提供的位置核对入口、全部分卷和清单；不要扫描整台电脑。材料不完整时明确告诉我缺什么，不要勉强恢复。";
    }
    return "我已在看板选择“我还没有从旧电脑导出”。现在不要假装执行导入。请先告诉我应在旧电脑打开 AI Carry 看板的“迁移与安全”，点击“开始导出本地隐私资料”；如果旧电脑无法使用，再逐项说明仍然可行的恢复办法和限制。";
  }

  if (choice === "current") {
    return "我已在看板选择“只查看当前清单”。请用普通语言列出你已经知道、已经登记、正式引用和仍需复核的资料；不要新增范围，不要让我重新提供你已经知道的路径，也不要开始打包。";
  }
  if (choice === "supplement") {
    return "我已在看板选择“补充以前的资料”。请先列出你已经知道的内容，再一步一步帮助我补充接入 AI Carry 前已有、由其他软件产生或被我手动移动的资料；每次只问一个必要问题，写入前用我当前交流语言给我一份清楚预览。";
  }
  return "我已在看板选择“我不确定，请帮我检查”。请根据我的职业、最近任务和已经登记的内容，列出可能遗漏的资料类别；不要扫描整台电脑，一次只问一个真正会改变登记范围的问题，最后再让我决定是否补充。";
}

function MigrationGuideDialog({
  mode,
  completeAction,
  coverageAction,
  exportAction,
  importAction,
  onClose,
  onCopy,
}: {
  mode: MigrationGuideMode;
  completeAction?: GlobalActionDef;
  coverageAction?: GlobalActionDef;
  exportAction?: GlobalActionDef;
  importAction?: GlobalActionDef;
  onClose: () => void;
  onCopy: CopyRequest;
}) {
  const reduced = useReducedMotion();
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [choice, setChoice] = useState<MigrationGuideChoice | null>(null);
  const action = mode === "complete"
    ? completeAction
    : mode === "coverage"
      ? coverageAction
      : mode === "private-export"
        ? exportAction
        : importAction;
  const isComplete = mode === "complete";
  const isPrivateExport = mode === "private-export";
  const isPrivateImport = mode === "private-import";
  const visibleAssetCount = carriedAssetCount();

  const scopeOptions = [
    {
      id: "current" as const,
      icon: CheckCircle2,
      title: isComplete
        ? "按当前清单继续迁移"
        : isPrivateExport
          ? "按当前资料范围直接导出"
          : "只查看当前清单",
      description: isComplete
        ? "适合主要资料都由当前 Agent 创建或整理、没有其他旧资料需要补充的情况。"
        : isPrivateExport
          ? "Agent 先列出已经登记和正式引用的资料，你确认后直接在本地导出。"
          : "先让 Agent 列出已知、已登记和需要复核的内容，不新增资料，也不开始打包。",
      summary: isComplete
        ? "Agent 先列清单，确认后开始。"
        : isPrivateExport
          ? "先列出范围，确认后在本地导出。"
          : "只查看现有范围，不开始打包。",
    },
    {
      id: "supplement" as const,
      icon: History,
      title: isComplete
        ? "先补充以前的资料，再继续"
        : isPrivateExport
          ? "先补充以前的资料，再导出"
          : "补充以前的资料",
      description: "适合接入 AI Carry 前已有、由其他软件生成，或后来被你手动移动的资料。",
      summary: "补充旧资料后，在同一对话继续。",
    },
    {
      id: "unsure" as const,
      icon: CircleHelp,
      title: "我不确定，请帮我检查",
      description: "Agent 会根据你的职业和真实任务提示可能遗漏的类别，一次只问一个问题，不扫描整台电脑。",
      summary: "Agent 一次只问一个必要问题。",
    },
  ];
  const importOptions = [
    {
      id: "current" as const,
      icon: FileArchive,
      title: "我有完整的输出文件夹",
      description: "文件夹里有恢复说明、总清单和全部隐私分卷。Agent 会先完整校验，再展示恢复预览。",
      summary: "先校验整个文件夹，再展示预览。",
    },
    {
      id: "supplement" as const,
      icon: Search,
      title: "我不确定手里的文件是否完整",
      description: "把你知道的位置告诉 Agent，它会帮你识别缺少的入口、分卷或清单，不会勉强恢复。",
      summary: "Agent 先帮你判断材料是否齐全。",
    },
    {
      id: "unsure" as const,
      icon: CircleHelp,
      title: "我还没有从旧电脑导出",
      description: "Agent 会先告诉你回到旧电脑怎样导出；旧电脑无法使用时，再说明其他恢复办法和限制。",
      summary: "先回旧电脑导出，再开始恢复。",
    },
  ];
  const options = isPrivateImport ? importOptions : scopeOptions;
  const explainerItems = isPrivateImport
    ? [
      {
        title: "完整输出文件夹",
        summary: "恢复说明、总清单和全部分卷。",
        help: "不要只挑一个 ZIP。请保留旧电脑导出时生成的恢复说明、总清单和全部分卷。",
      },
      {
        title: "先校验，再恢复",
        summary: "缺少材料时会明确告诉你。",
        help: "新电脑上的 Agent 会先核对全部分卷、文件清单和摘要；材料不完整就停止恢复并说明缺什么。",
      },
      {
        title: "不会直接覆盖",
        summary: "冲突时先给你恢复预览。",
        help: "发现目标位置冲突、危险路径或摘要不一致时会先停止；密钥和登录状态仍需重新配置。",
      },
    ]
    : [
      {
        title: isPrivateExport ? "本地隐私资料" : "助手里的积累",
        summary: isPrivateExport
          ? "只处理已登记或正式引用的范围。"
          : profile.state === "instance"
            ? `当前可携带资产 ${visibleAssetCount} 项`
            : "创建后的记忆、能力和工作状态。",
        help: isPrivateExport
          ? "只导出本地隐私资料，不重复打包 AI Carry 主体；真正导出前还会重新核对范围。"
          : profile.state === "instance"
            ? "看板只显示低敏摘要；迁移时 Agent 仍会按正式文件重新核对实际范围。"
            : "当前还是空白模板；创建助手后，记忆、能力、固定流程和成长内容会随主体包迁移。",
      },
      {
        title: "Agent 已知的本地资料",
        summary: "先列清单，不让你重新找路径。",
        help: "Agent 创建、移动、整理或已经登记的资料会复用实际位置；只有它不知道的部分才请你帮助定位。",
      },
      {
        title: "不会自动带走",
        summary: "密钥、登录状态和未登记目录。",
        help: "密钥、密码和登录状态不进迁移包；电脑其他位置也不会被偷偷扫描。",
      },
    ];

  const selected = options.find((option) => option.id === choice);
  const title = step === 1
    ? (isComplete
      ? "哪些内容会跟着助手走？"
      : isPrivateExport
        ? "这次会导出哪些本地资料？"
        : isPrivateImport
          ? "你需要准备什么？"
          : "Agent 已经掌握了什么？")
    : step === 2
      ? (isPrivateImport ? "你现在手里的资料是哪种情况？" : "还要补充以前的资料吗？")
      : "最后核对";
  const description = step === 1
    ? "先看三件事，下一步再选择。"
    : step === 2
      ? "选择最接近现在的一项。"
      : "确认处理方式，正确就复制。";
  const stepHelp = step === 1
    ? (isPrivateImport
      ? "导入需要旧电脑生成的整个输出文件夹，不是其中一个 ZIP，也不是 GitHub 下载包。"
      : "你不需要自己维护文件路径。当前 Agent 执行时会读取正式记录，并用你现在的交流语言列出真实清单。")
    : step === 2
      ? "拿不准也没关系，可以选择让 Agent 帮你判断；它只问会改变迁移范围的必要问题。"
      : "这一步不会增加新选择。需要修改就返回上一步；确认后只会复制完整请求，网页不会直接迁移。";
  const modeLabel = isComplete
    ? "完整换机迁移"
    : isPrivateExport
      ? "导出本地隐私资料"
      : isPrivateImport
        ? "导入本地隐私资料"
        : "本地资料范围";
  const stepPhase = step === 1 ? "先了解" : step === 2 ? "做选择" : "最后核对";
  const finalButtonLabel = isComplete
    ? "核对无误，复制完整换机指令"
    : isPrivateExport
      ? "核对无误，复制隐私资料导出指令"
      : isPrivateImport
        ? "核对无误，复制隐私资料导入指令"
        : "核对无误，复制查看与补充指令";
  const reviewSteps = isPrivateImport
    ? [
      ["把指令发给新电脑上的 Agent", "Agent 会承接你刚才选择的情况，不让你重新判断一次。"],
      [choice === "current" ? "校验整个输出文件夹" : choice === "supplement" ? "先判断材料是否完整" : "先引导旧电脑完成导出", "不会只看一个 ZIP，也不会在材料不完整时勉强恢复。"],
      ["通过检查后再展示恢复预览", "确认目标位置、冲突和秘密重新配置要求后，才会写入新电脑。"],
    ]
    : isPrivateExport
      ? [
        ["把指令发给当前 Agent", "看板会把刚才的选择写进指令，不会让你重新选择。"],
        [choice === "supplement" ? "先补充，再确认导出范围" : choice === "unsure" ? "先帮你判断可能遗漏的资料" : "先列出当前资料范围", "Agent 复用已知位置，只对真正不知道的部分提问。"],
        ["在本地生成完整输出文件夹", "资料多时会自动分卷；不会上传 GitHub、网站或其他远程位置。"],
      ]
      : [
        ["把完整指令发给当前 Agent", "看板会把刚刚的选择写进指令；当前 Agent 不会让你从头重新选择。"],
        [choice === "supplement" ? "先补充，再确认范围" : choice === "unsure" ? "先帮你判断可能遗漏的资料" : "先列出当前清单", "Agent 会复用已知位置，只对真正不知道或会改变结果的地方提问。"],
        [isComplete ? "在同一次对话中继续生成迁移套件" : "确认后更新本地资料范围", isComplete ? "完成后会告诉你套件保存位置、检查结果和发给新 Agent 的固定恢复话术。" : "这里只查看或登记范围，不会自动打包、上传、移动或删除文件。"],
      ];

  function copyGuidedRequest() {
    if (!action || !choice) return;
    const request = `${action.request}\n\n【我已经在看板完成的选择】\n${choiceInstruction(mode, choice)}`;
    onClose();
    window.setTimeout(() => onCopy(request, action.label), 0);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="migration-guide-dialog sm:max-w-[860px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader className="migration-guide-dialog__header">
          <div className="migration-guide-dialog__meta">
            <span>{modeLabel}</span>
            <strong>{localizeText(`第 ${step} 步，共 3 步 · ${stepPhase}`)}</strong>
          </div>
          <div className="migration-guide-dialog__progress" aria-label={`当前第 ${step} 步，共 3 步`}>
            {[1, 2, 3].map((item) => <i key={item} className={item <= step ? "is-active" : ""} />)}
          </div>
          <div className="migration-guide-dialog__title-row">
            <DialogTitle ref={titleRef} tabIndex={-1}>{title}</DialogTitle>
            <InfoHint label="这一步怎么做" help={stepHelp} />
          </div>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="migration-guide-dialog__stage" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${mode}-${step}`}
              initial={reduced ? false : { opacity: 0, x: step === 1 ? 0 : 14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduced ? undefined : { opacity: 0, x: -10 }}
              transition={{ duration: 0.2, ease: [0.16, 0.84, 0.3, 1] }}
            >
              {step === 1 ? (
                <section className="migration-guide-explainer" aria-label="本页只用于了解流程，不需要选择">
                  <p className="migration-guide-explainer__lead"><FileText aria-hidden="true" />这一页没有需要选择的内容，只看三件事。</p>
                  <ol className="migration-guide-explainer__flow">
                    {explainerItems.map((item, index) => (
                      <li key={item.title}>
                        <span className="migration-guide-explainer__number">{String(index + 1).padStart(2, "0")}</span>
                        <div><strong>{item.title}</strong><p>{item.summary}</p></div>
                        <InfoHint label={item.title} help={item.help} />
                      </li>
                    ))}
                  </ol>
                  <footer className="migration-guide-explainer__boundary">
                    <ShieldCheck aria-hidden="true" />
                    <span>{isPrivateImport ? "这不是 GitHub 下载包。" : "看板不会显示具体文件路径。"}</span>
                    <InfoHint
                      label={isPrivateImport ? "为什么不是 GitHub 下载包" : "为什么不显示具体路径"}
                      help={isPrivateImport
                        ? "本地隐私输出文件夹由旧电脑单独生成，不经过 GitHub。把完整文件夹交给新电脑上的 Agent，它才有条件校验和恢复。"
                        : "这是为了避免把隐私目录投影到页面。请求交给当前 Agent 后，它会从本地正式记录读取，并先用你现在的交流语言说明清单。"}
                    />
                  </footer>
                </section>
              ) : null}

              {step === 2 ? (
                <fieldset className="migration-guide-choices">
                  <legend className="sr-only">选择怎样处理当前资料范围</legend>
                  {options.map((option) => {
                    const Icon = option.icon;
                    const active = choice === option.id;
                    return (
                      <div className="migration-guide-choice-shell" key={option.id}>
                        <button
                          type="button"
                          className={active ? "is-selected" : ""}
                          aria-pressed={active}
                          onClick={() => setChoice(option.id)}
                        >
                          <span className="migration-guide-choices__icon"><Icon aria-hidden="true" /></span>
                          <span className="migration-guide-choices__copy"><strong>{option.title}</strong><p>{option.summary}</p></span>
                          <span className="migration-guide-choices__state" aria-hidden="true">{active ? <Check /> : <ChevronRight />}</span>
                        </button>
                        <InfoHint label="这个选项适合谁" help={option.description} />
                      </div>
                    );
                  })}
                </fieldset>
              ) : null}

              {step === 3 && selected ? (
                <section className="wizard-review-sheet wizard-review-sheet--migration" aria-label="迁移处理方式核对单">
                  <p className="migration-guide-review__lead"><CheckCircle2 aria-hidden="true" />这一步没有任何选项，只核对一种处理方式。</p>
                  <div className="migration-guide-review__summary">
                    <span><selected.icon aria-hidden="true" /></span>
                    <div><small>本次处理方式</small><strong>{selected.title}</strong><p>{selected.summary}</p></div>
                    <em><Check aria-hidden="true" />已选择</em>
                  </div>
                  <div className="migration-guide-review__route">
                    <span>Agent 接下来会做三件事</span>
                    <ol>
                      {reviewSteps.map(([heading, detail], index) => (
                        <li key={heading}>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <strong>{heading}</strong>
                          <InfoHint label={heading} help={detail} />
                        </li>
                      ))}
                    </ol>
                  </div>
                  <footer className="wizard-review-sheet__footnote">
                    <ShieldCheck aria-hidden="true" />
                    <p>看板只复制请求，不执行迁移。<InfoHint label="执行前还会发生什么" help="当前 Agent 会承接你已经选择的处理方式；遇到范围、目标位置或冲突等真正需要你决定的问题时，再展示必要预览。" /></p>
                  </footer>
                </section>
              ) : null}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="migration-guide-dialog__footer">
          <Button variant="outline" className="control-button" onClick={step === 1 ? onClose : () => setStep((step - 1) as 1 | 2)}>
            {step === 1 ? "暂时不处理" : <><ArrowLeft aria-hidden="true" />{step === 3 ? "返回修改" : "返回上一步"}</>}
          </Button>
          {step < 3 ? (
            <Button className="control-button migration-guide-dialog__next" disabled={step === 2 && !choice} onClick={() => setStep((step + 1) as 2 | 3)}>
              {step === 1 ? (isPrivateImport ? "我了解了，下一步说明情况" : "我了解了，下一步做选择") : "选好了，进入核对"}
              <ArrowRight aria-hidden="true" />
            </Button>
          ) : (
            <div className="wizard-final-action">
              <Button className="control-button migration-guide-dialog__next migration-guide-dialog__next--final" disabled={!action || !choice} onClick={copyGuidedRequest}>
                <CheckCircle2 aria-hidden="true" />
                {finalButtonLabel}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TransferView({ onCopy, startComputerGuideRequest = 0 }: { onCopy: CopyRequest; startComputerGuideRequest?: number }) {
  const [guideMode, setGuideMode] = useState<MigrationGuideMode | null>(null);
  const guideOpenerRef = useRef<HTMLButtonElement | null>(null);
  const secondaryIds = ["dashboard.refresh-snapshot", "preference.reuse-from-instance"];
  const secondary = secondaryIds.map(findAction).filter((action): action is GlobalActionDef => Boolean(action));
  const githubAction = findAction("instance.prepare-git-safe-copy");
  const localAgentAction = findAction("host.prepare-agent-switch");
  const completeMigrationAction = findAction("instance.prepare-complete-migration");
  const privateCoverageAction = findAction("instance.review-private-coverage");
  const privateExportAction = findAction("instance.export-private-package");
  const privateImportAction = findAction("instance.import-private-package");
  const upgradeAction = findAction("instance.upgrade-template");
  const problemReportAction = findAction("support.create-problem-report");

  const openGuide = (mode: MigrationGuideMode, opener: HTMLButtonElement) => {
    guideOpenerRef.current = opener;
    setGuideMode(mode);
  };

  const closeGuide = () => {
    const opener = guideOpenerRef.current;
    setGuideMode(null);
    queueMicrotask(() => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
  };

  useEffect(() => {
    if (startComputerGuideRequest <= 0) return;
    guideOpenerRef.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    setGuideMode("complete");
  }, [startComputerGuideRequest]);

  return (
    <div className="page-stack transfer-essential">
      <section className="transfer-essential__head" aria-labelledby="assistant-relocation-title">
        <div>
          <SectionEyebrow icon={PackageOpen}>迁移与安全</SectionEyebrow>
          <div className="heading-with-hint"><h1 id="assistant-relocation-title">这次你要换 Agent，还是换电脑？</h1><InfoHint label="两种方式有什么区别" help="同一台电脑换 Agent 时直接接入现有 AI Carry；换电脑时生成包含助手主体、本地隐私分卷和恢复说明的迁移套件。" /></div>
        </div>
        <p>选一种去向，Agent 会继续引导。</p>
      </section>

      <section className="transfer-choice-grid" aria-label="选择迁移去向">
        <article className="transfer-choice transfer-choice--agent">
          <div className="transfer-choice__icon"><Cpu aria-hidden="true" /></div>
          <span className="transfer-choice__tag">同一台电脑</span>
          <h2>换 Agent</h2>
          <p>直接接入这一份 AI Carry，不重复复制整套内容。</p>
          <span className="transfer-choice__fact"><ShieldCheck aria-hidden="true" />只读取当前任务需要的内容</span>
          {localAgentAction ? <Button className="action-button action-button--blue" onClick={() => onCopy(localAgentAction.request, localAgentAction.label)}><ClipboardCopy aria-hidden="true" />复制接入指令<ArrowRight aria-hidden="true" /></Button> : null}
        </article>

        <article className="transfer-choice transfer-choice--computer">
          <div className="transfer-choice__icon"><PackageOpen aria-hidden="true" /></div>
          <span className="transfer-choice__tag">另一台电脑</span>
          <h2>换电脑</h2>
          <p>核对现有资料后，生成完整迁移套件。</p>
          <span className="transfer-choice__fact"><ShieldCheck aria-hidden="true" />密钥与登录状态不会打包</span>
          {completeMigrationAction ? <Button className="action-button action-button--teal" onClick={(event) => openGuide("complete", event.currentTarget)}><PackageOpen aria-hidden="true" />开始准备换电脑<ArrowRight aria-hidden="true" /></Button> : null}
        </article>
      </section>

      <section className="transfer-operation-groups" aria-label="迁移与维护操作">
        <article className="transfer-operation-group transfer-operation-group--private">
          <header><span><HardDrive aria-hidden="true" /></span><div><h2>本地隐私资料</h2><p>导出和恢复单独处理，只在本机进行。</p></div><InfoHint label="本地隐私资料怎样处理" help="Agent 会先回读已登记范围；导出不会自动上传，恢复也不会整体覆盖现有实例。真正存在冲突时才请你决定。" /></header>
          <div className="transfer-operation-list">
            {privateExportAction ? <button type="button" onClick={(event) => openGuide("private-export", event.currentTarget)}><Download aria-hidden="true" /><span><strong>导出本地隐私资料</strong><small>生成本机输出文件夹</small></span><ChevronRight aria-hidden="true" /></button> : null}
            {privateImportAction ? <button type="button" onClick={(event) => openGuide("private-import", event.currentTarget)}><Upload aria-hidden="true" /><span><strong>恢复本地隐私资料</strong><small>从完整输出文件夹恢复</small></span><ChevronRight aria-hidden="true" /></button> : null}
            {privateCoverageAction ? <button type="button" onClick={(event) => openGuide("coverage", event.currentTarget)}><Database aria-hidden="true" /><span><strong>核对会带走哪些资料</strong><small>查看或补充当前范围</small></span><ChevronRight aria-hidden="true" /></button> : null}
          </div>
        </article>

        <article className="transfer-operation-group transfer-operation-group--upgrade">
          <header><span><Upload aria-hidden="true" /></span><div><h2>检查并升级 AI Carry</h2><p>先看新版变化，再保留个人内容完成升级。</p></div><InfoHint label="升级怎样进行" help="Agent 先只读检查正式新版并展示预览；你确认后才升级。实例身份、个人资产、本地与私密内容默认保留。" /></header>
          {upgradeAction ? <Button className="action-button action-button--violet" onClick={() => onCopy(upgradeAction.request, upgradeAction.label)}>开始检查新版<ArrowRight aria-hidden="true" /></Button> : null}
        </article>

        <article className="transfer-operation-group transfer-operation-group--other">
          <header><span><FileCheck2 aria-hidden="true" /></span><div><h2>其他维护</h2><p>备份、偏好复用和看板刷新。</p></div><InfoHint label="这些按钮会做什么" help="按钮只复制明确请求，由当前 Agent 说明范围后继续；不会从网页直接上传、删除或修改文件。" /></header>
          <div className="transfer-operation-list transfer-operation-list--compact">
            {githubAction ? <button type="button" onClick={() => onCopy(githubAction.request, githubAction.label)}><GitBranch aria-hidden="true" /><span><strong>GitHub 私有备份</strong><small>先排除隐私，再确认上传</small></span><ChevronRight aria-hidden="true" /></button> : null}
            {secondary.map((action) => {
              const item = SECONDARY_ACTION_META[action.action_id as keyof typeof SECONDARY_ACTION_META];
              const Icon = item?.icon ?? FileCheck2;
              return <button key={action.action_id} type="button" onClick={() => onCopy(action.request, action.label)}><Icon aria-hidden="true" /><span><strong>{action.label}</strong><small>{item?.description ?? "交给当前 Agent 处理"}</small></span><ChevronRight aria-hidden="true" /></button>;
            })}
          </div>
        </article>
      </section>

      {problemReportAction ? (
        <section className="problem-report-compact" aria-labelledby="problem-report-title">
          <span className="problem-report-compact__icon"><CircleHelp aria-hidden="true" /></span>
          <div><SectionEyebrow icon={MessageCircleMore}>遇到问题</SectionEyebrow><h2 id="problem-report-title">让 Agent 帮你整理问题报告</h2><p>从最早觉得不对的地方开始；自动遮盖敏感信息，报告不会自动发送。</p></div>
          <InfoHint label="问题报告怎样生成" help="Agent 会在当前对话中自然询问最早异常点，区分事实与推断；材料不全也能先生成标明缺口的部分报告，不需要你懂日志或开发术语。" />
          <Button className="action-button action-button--report" onClick={() => onCopy(problemReportAction.request, problemReportAction.label)}><ClipboardCopy aria-hidden="true" />开始整理问题报告<ArrowRight aria-hidden="true" /></Button>
        </section>
      ) : null}

      <div className="transfer-safety-line" role="note">
        <LockKeyhole aria-hidden="true" />
        <strong>只给任务需要的隐私</strong><i />
        <strong>密钥不进对话或迁移包</strong><i />
        <strong>发送前确认接收方</strong>
        <InfoHint label="三条安全边界" help="姓名、地址、工作或健康资料只在任务需要时提供；API 密钥、密码、令牌、Cookie、私钥和恢复码不得进入对话或迁移文件；网站、邮件、插件、其他 Agent、其他人和远程仓库都属于新的接收方。" />
      </div>
      {guideMode ? (
        <MigrationGuideDialog
          mode={guideMode}
          completeAction={completeMigrationAction}
          coverageAction={privateCoverageAction}
          exportAction={privateExportAction}
          importAction={privateImportAction}
          onClose={closeGuide}
          onCopy={onCopy}
        />
      ) : null}
    </div>
  );
}

export function SystemView({ onRefresh, onCopy, refreshIn, refreshFailed = false }: { onRefresh: () => void; onCopy: CopyRequest; refreshIn: number; refreshFailed?: boolean }) {
  const snapshot = getSnapshotStatus(refreshFailed);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const guidanceAction = findAction("profile.adjust-guidance-mode");
  const startupBudget = Math.max(Number(profile.startupBudget ?? 0), 1);
  const startupChars = Math.max(Number(profile.startupChars ?? 0), 0);
  const budgetRatio = Math.min((startupChars / startupBudget) * 100, 100);
  const identityDetail = profile.state === "instance"
    ? `${profile.mission || "尚未设置使命。"} 方向：${overview.domain || profile.domainId || "尚未设置"}；交流方式：${profile.guidanceLabel}。`
    : "当前是空白模板；创建助手后，这里会显示真实身份、方向和交流方式。";

  return (
    <div className="page-stack system-essential">
      <section className="system-essential__head">
        <div>
          <SectionEyebrow icon={Cpu}>当前状态</SectionEyebrow>
          <div className="heading-with-hint"><h1>助手状态</h1><InfoHint label="这个页面看什么" help="先确认看板数据、模型、随身内容、本地扩展和学习方式。单项异常只处理对应部分，不会让整个助手停止工作。" /></div>
          <p>先看是否正常，再决定要不要处理。</p>
        </div>
        <Button variant="outline" className="refresh-button" onClick={onRefresh}>
          <RefreshCw aria-hidden="true" />
          刷新 · {refreshIn}s
        </Button>
      </section>

      <section className="health-grid health-grid--essential" aria-label="当前系统概况">
        <article className={`health-card health-card--${snapshot.healthTone}`}>
          <span><HardDrive aria-hidden="true" /></span><div><span className="health-card__label"><small>看板数据</small><InfoHint label="看板数据状态" help={snapshot.cardDetail} /></span><strong>{snapshot.label}</strong></div>
        </article>
        <article className="health-card">
          <span><Cpu aria-hidden="true" /></span><div><small>当前模型</small>{profile.state === "instance" ? <SourceText as="strong">{profile.model}</SourceText> : <strong>{profile.model}</strong>}<p>{profile.modelLevel != null ? `Level ${profile.modelLevel} · ` : ""}{profile.state === "instance" ? <SourceText>{profile.modelPlatform}</SourceText> : profile.modelPlatform}</p></div>
        </article>
        <article className="health-card">
          <span><Database aria-hidden="true" /></span><div><span className="health-card__label"><small>已经保存的内容</small><InfoHint label="保存内容怎样计数" help="从看板隐藏的记录仍保存在本地；模型和本地扩展不计入。" /></span><strong>{carriedAssetCount()} 项</strong></div>
        </article>
        <article className="health-card">
          <span><Sparkles aria-hidden="true" /></span><div><span className="health-card__label"><small>本地扩展</small><InfoHint label="本地扩展怎样使用" help={skills.status ?? "按真实任务需要再加载。"} /></span><strong>{skills.count ?? assets.skills} 项</strong></div>
        </article>
        <article className="health-card health-card--learning">
          <span><Lightbulb aria-hidden="true" /></span><div><span className="health-card__label"><small>学习方式</small><InfoHint label="学习方式说明" help={profile.learningPolicy === "risk-tiered" ? "第一次发现仍会先问你；风险只决定候选先验证、先复核，变成正式资产前仍要你明确确认。" : profile.learningPolicy === "manual-only" ? "发现值得留下的内容时会先问你；候选观察、复核和正式采用都等你确认。" : "创建助手时选择；无论哪种方式，第一次发现和正式采用都会问你。"} /></span><strong title={profile.learningPolicyLabel}>{profile.learningPolicyLabel}</strong></div>
        </article>
      </section>

      <section className="system-essentials" aria-label="助手身份与常用操作">
        <div className="system-identity-row">
          <span><FileText aria-hidden="true" /></span>
          <div><small>当前助手</small>{profile.state === "instance" ? <SourceText as="strong">{profile.displayName}</SourceText> : <strong>{profile.displayName}</strong>}</div>
          <InfoHint label="当前身份详情" help={identityDetail} />
        </div>

        <div className="system-budget-row">
          <div><Lightbulb aria-hidden="true" /><span><small>启动时按需读取</small><strong>{startupChars.toLocaleString()} / {startupBudget.toLocaleString()} 字符</strong></span><InfoHint label="按需读取说明" help="启动时只看身份、未完成操作和内容目录；真正用到记忆、能力、安全规则或固定流程时，才读取相关详情。" /></div>
          <span className="budget-meter__track"><i style={{ width: `${budgetRatio}%` }} /></span>
        </div>

        <div className="system-quick-actions">
          <span className="system-model-guide"><Cpu aria-hidden="true" /><strong>模型怎么选</strong><InfoHint label="模型等级说明" help="目标清楚的日常任务优先使用 Level 1；需要归纳判断时使用 Level 2；创建助手、核心架构、安全规则和重要长期决定使用 Level 3。Agent 需要切换时会先说明原因。" /></span>
          {profile.state === "instance" && guidanceAction ? <Button variant="outline" onClick={() => setGuidanceOpen(true)}><MessageCircleMore aria-hidden="true" />调整交流方式</Button> : null}
        </div>
      </section>

      <details className="advanced-details render-deferred">
        <summary><span><FileText aria-hidden="true" />维护者技术信息</span><ChevronRight aria-hidden="true" /></summary>
        <div>
          <dl className="technical-list">
            <div><dt>产品版本</dt><dd>{profile.version}</dd></div>
            <div><dt>快照 Schema</dt><dd>{meta.schema_version ?? "—"}</dd></div>
            <div><dt>正式文件数</dt><dd>{advanced.file_count ?? 0}</dd></div>
            <div><dt>来源摘要</dt><dd>{meta.source_digest || "—"}</dd></div>
          </dl>
          <div className="entry-files">
            {(advanced.entry_files ?? []).map((file) => <code key={file}>{file}</code>)}
          </div>
        </div>
      </details>
      {guidanceAction ? (
        <GuidanceModeDialog
          open={guidanceOpen}
          onOpenChange={setGuidanceOpen}
          currentMode={profile.guidanceMode}
          baseRequest={guidanceAction.request}
          onCopy={onCopy}
        />
      ) : null}
    </div>
  );
}
