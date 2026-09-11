import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { ArrowRight, CheckCircle2, CircleHelp, Clock3, ClipboardCopy, HardDrive, Languages, MonitorPlay, PackageOpen, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  NAV_ITEMS,
  hashForRoute,
  routeFromHash,
  type GrowthKind,
  type LibraryKind,
  type RouteState,
} from "@/dashboard-config";
import {
  CopyDialog,
  EMPTY_COPY,
  ItemDialog,
  LogoMark,
  SourceText,
  type CopyState,
  type DetailState,
} from "@/components/dashboard/Shared";
import {
  GrowthView,
  HomeView,
  LibraryView,
  SystemView,
  TransferView,
} from "@/components/dashboard/Views";
import { SkillWorkshop } from "@/components/dashboard/SkillWorkshop";
import {
  applyDashboardSnapshot,
  getGlobalActions,
  getSnapshotStatus,
  meta,
  profile,
} from "@/lib/data";
import { inspectDashboardIdentity, syncDashboardIdentity } from "@/lib/identity";
import { DashboardScrollRootContext } from "@/lib/scroll-root";
import { localizeAgentRequest, useDashboardLocale } from "@/lib/i18n";

const SCROLL_STATE_EVENT = "ai-carry:scroll-state";
type CarryWindow = Window & {
  AI_CARRY_DEMO?: boolean;
  AI_CARRY_SNAPSHOT?: unknown;
  AGENT_CARRY_DEMO?: boolean;
  AGENT_CARRY_SNAPSHOT?: unknown;
};
const carryWindow = () => window as CarryWindow;
const currentSnapshot = () => carryWindow().AI_CARRY_SNAPSHOT ?? carryWindow().AGENT_CARRY_SNAPSHOT;

export default function Dashboard() {
  const demoMode = carryWindow().AI_CARRY_DEMO === true || carryWindow().AGENT_CARRY_DEMO === true;
  const [route, setRoute] = useState<RouteState>(() => routeFromHash(window.location.hash));
  const [copyState, setCopyState] = useState<CopyState>(EMPTY_COPY);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [refreshIn, setRefreshIn] = useState(60);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const [refreshError, setRefreshError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [identityIssueOpen, setIdentityIssueOpen] = useState(false);
  const [transferStartRequest, setTransferStartRequest] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const lenisRef = useRef<Lenis | null>(null);
  const scrollRestoreRef = useRef<number | null>(null);
  const refreshingRef = useRef(false);
  const reduced = useReducedMotion();
  const { locale, setLocale } = useDashboardLocale();

  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, "", hashForRoute({ page: "home" }));
    }
    const syncRoute = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", syncRoute);
    window.addEventListener("popstate", syncRoute);
    return () => {
      window.removeEventListener("hashchange", syncRoute);
      window.removeEventListener("popstate", syncRoute);
    };
  }, []);

  useEffect(() => {
    const wrapper = mainRef.current;
    if (!wrapper) return;

    let scrolling = false;
    let idleTimer = 0;
    const setScrolling = (active: boolean) => {
      if (scrolling === active) return;
      scrolling = active;
      wrapper.dataset.scrollState = active ? "active" : "idle";
      window.dispatchEvent(new CustomEvent(SCROLL_STATE_EVENT, { detail: active }));
    };
    const onScroll = () => {
      setScrolling(true);
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => setScrolling(false), 140);
    };

    wrapper.dataset.scrollState = "idle";
    wrapper.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      wrapper.removeEventListener("scroll", onScroll);
      window.clearTimeout(idleTimer);
      if (scrolling) window.dispatchEvent(new CustomEvent(SCROLL_STATE_EVENT, { detail: false }));
      delete wrapper.dataset.scrollState;
    };
  }, []);

  useEffect(() => {
    const wrapper = mainRef.current;
    const content = wrapper?.firstElementChild;
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    if (!wrapper || !(content instanceof HTMLElement) || reduced || coarsePointer) return;

    const lenis = new Lenis({
      wrapper,
      content,
      autoRaf: true,
      duration: 0.72,
      smoothWheel: true,
      syncTouch: false,
      overscroll: true,
      respectReducedMotion: true,
    });
    lenisRef.current = lenis;
    wrapper.dataset.scrollEngine = "lenis";

    const syncVisibility = () => {
      if (document.hidden) lenis.stop();
      else lenis.start();
    };
    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();

    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      lenisRef.current = null;
      lenis.destroy();
      delete wrapper.dataset.scrollEngine;
    };
  }, [reduced]);

  useLayoutEffect(() => {
    if (scrollRestoreRef.current == null || !mainRef.current) return;
    if (lenisRef.current) lenisRef.current.scrollTo(scrollRestoreRef.current, { immediate: true });
    else mainRef.current.scrollTop = scrollRestoreRef.current;
    scrollRestoreRef.current = null;
  }, [snapshotRevision]);

  const navigate = useCallback((next: RouteState) => {
    const nextHash = hashForRoute(next);
    if (window.location.hash !== nextHash) window.history.pushState(null, "", nextHash);
    setRoute(next);
    setDetail(null);
    if (lenisRef.current) lenisRef.current.scrollTo(0, { immediate: Boolean(reduced) });
    else mainRef.current?.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }, [reduced]);

  const refreshSnapshot = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshError(false);
    const current = currentSnapshot();
    const before = JSON.stringify(current ?? null);
    const previousScroll = mainRef.current?.scrollTop ?? 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        const source = new URL("./snapshot.js", document.baseURI);
        source.searchParams.set("refresh", String(Date.now()));
        script.src = source.href;
        script.dataset.aiCarryRefresh = "true";
        script.onload = () => { script.remove(); resolve(); };
        script.onerror = () => { script.remove(); reject(new Error("snapshot refresh failed")); };
        document.head.appendChild(script);
      });
      const next = currentSnapshot();
      const after = JSON.stringify(next ?? null);
      if (after !== before) {
        if (applyDashboardSnapshot(next)) {
          scrollRestoreRef.current = previousScroll;
          setSnapshotRevision((value) => value + 1);
        } else {
          setRefreshError(true);
        }
      }
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshIn(60);
      setRefreshing(false);
      refreshingRef.current = false;
    }
  }, []);

  useEffect(() => {
    let remaining = 60;
    const timer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        remaining = 60;
        void refreshSnapshot();
      }
      setRefreshIn(remaining);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [refreshSnapshot]);

  const dashboardIdentity = useMemo(() => inspectDashboardIdentity({
    demoMode,
    state: profile.state,
    displayName: profile.displayName,
    version: profile.version,
    identityRef: meta?.identity_ref,
    href: window.location.href,
  }), [demoMode, snapshotRevision]);

  useEffect(() => {
    syncDashboardIdentity(dashboardIdentity);
    if (!dashboardIdentity.mismatch) setIdentityIssueOpen(false);
  }, [dashboardIdentity]);

  const copyRequest = useCallback(async (text: string, label: string) => {
    const localizedRequest = localizeAgentRequest(text);
    try {
      await navigator.clipboard.writeText(localizedRequest);
      setCopyState({ open: true, copied: true, text: localizedRequest, label });
    } catch {
      setCopyState({ open: true, copied: false, text: localizedRequest, label });
    }
  }, []);

  const requestCopy = useCallback(async (text: string, label: string) => {
    if (dashboardIdentity.mismatch) {
      setIdentityIssueOpen(true);
      return;
    }
    await copyRequest(text, label);
  }, [dashboardIdentity.mismatch, copyRequest]);

  const requestIdentityDiagnosis = () => {
    setIdentityIssueOpen(false);
    void copyRequest("我的 AI Carry 看板提示数据不可用或入口身份不一致。请先只读核对：当前对话加载的是哪份助手、我打开的看板属于哪个目录、实例清单与快照能否对应。看板地址不清楚时先问我，不扫描其他实例，也不把地址栏当作授权。只报告原因、影响和建议，不修改文件、不升级、不导入、不重新实例化。普通对话和无关工作继续。", "只读排查看板入口");
  };

  const currentNav = NAV_ITEMS.find((item) => item.page === route.page) ?? NAV_ITEMS[0];
  const localStatus = getSnapshotStatus(refreshError);
  const StatusIcon = localStatus.tone === "warning" ? TriangleAlert : localStatus.tone === "template" ? Clock3 : CheckCircle2;
  const rebuildAction = getGlobalActions().find((action) => action.action_id === "dashboard.refresh-snapshot");

  return (
    <div
      className={`app-shell app-shell--essential${demoMode ? " app-shell--demo" : ""}${dashboardIdentity.mismatch ? " app-shell--identity-warning" : ""}`}
      data-snapshot-revision={snapshotRevision}
      data-dashboard-kind={dashboardIdentity.expected.kind}
      data-dashboard-ref={dashboardIdentity.expected.ref}
      data-dashboard-version={dashboardIdentity.expected.version}
      data-dashboard-identity={dashboardIdentity.mismatch ? "mismatch" : "matched"}
    >
      <a className="skip-link" href="#main-content">跳到主要内容</a>

      <aside className="site-rail" aria-label="主要导航">
        <div className="rail-brand">
          <LogoMark />
          <div><strong>AI Carry</strong><span>便携式 AI 助手</span></div>
        </div>

        <div
          className={`rail-instance-card${profile.state === "instance" ? " is-instance" : " is-template"}`}
          aria-label={profile.state === "instance" ? `当前助手：${profile.displayName}` : "当前还没有创建助手"}
          title={profile.state === "instance" ? profile.displayName : "完成第一次设置后，这里会一直显示当前助手名称"}
        >
          <i aria-hidden="true" />
          <div>
            <small>{profile.state === "instance" ? "当前助手" : "当前状态"}</small>
            <strong>{profile.state === "instance" ? <SourceText>{profile.displayName}</SourceText> : "尚未创建助手"}</strong>
          </div>
        </div>

        <nav className="rail-nav">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = item.page === route.page;
            return (
              <button
                key={item.page}
                type="button"
                className={active ? "is-active" : ""}
                aria-current={active ? "page" : undefined}
                onClick={() => navigate({ page: item.page })}
              >
                <span className="rail-nav__icon"><Icon aria-hidden="true" /></span>
                <span className="rail-nav__copy"><strong>{item.label}</strong><small>{item.description}</small></span>
              </button>
            );
          })}
        </nav>

        <div className="rail-footer">
          <button
            type="button"
            className="rail-carry"
            onClick={() => {
              navigate({ page: "transfer" });
              setTransferStartRequest((value) => value + 1);
            }}
          >
            <PackageOpen aria-hidden="true" />
            <span><strong>带走本地资料</strong><small>换电脑前查看并准备</small></span>
            <ArrowRight aria-hidden="true" />
          </button>
          <div className={`rail-status rail-status--${localStatus.tone}`}><i /><span>{localStatus.label}</span></div>
          <p>v{profile.version} · 数据默认留在本机</p>
        </div>
      </aside>

      <div className="app-column">
        {demoMode ? (
          <div className="demo-notice" role="note">
            <MonitorPlay aria-hidden="true" />
            <strong>在线演示</strong>
            <span>这里使用的是纯虚构数据，不是你的真实助手；正式安装会从空模板开始。</span>
          </div>
        ) : null}
        <header className="topbar">
          <div className="topbar-brand-compact"><LogoMark /><strong>AI Carry</strong></div>
          <div className="topbar-title"><currentNav.icon aria-hidden="true" /><div><strong>{currentNav.label}</strong><span>{currentNav.description}</span></div></div>
          <div className="topbar-tools">
            <button
              type="button"
              className="locale-switch"
              aria-label={locale === "en" ? "切换到简体中文" : "Switch dashboard to English"}
              title={locale === "en" ? "切换到简体中文" : "Switch dashboard to English"}
              onClick={() => setLocale(locale === "en" ? "zh-Hans" : "en")}
            >
              <Languages aria-hidden="true" />
              <span>{locale === "en" ? "中文" : "EN"}</span>
            </button>
            <button
              type="button"
              className={`snapshot-chip snapshot-chip--${localStatus.tone}`}
              aria-haspopup="dialog"
              aria-expanded={statusOpen}
              onClick={() => setStatusOpen(true)}
            >
              <i />
              <span>{localStatus.label}</span>
              <CircleHelp aria-hidden="true" />
            </button>
            <Button
              variant="ghost"
              className="topbar-refresh"
              aria-label="重新读取看板数据"
              title="只重新读取本地看板数据，不刷新页面，也不修改你的正式内容"
              onClick={() => void refreshSnapshot()}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? "is-spinning" : ""} aria-hidden="true" />
              <span>{refreshing ? "读取中" : `${refreshIn}s`}</span>
            </Button>
          </div>
        </header>

        {dashboardIdentity.mismatch ? (
          <div className="identity-warning" role="alert">
            <TriangleAlert aria-hidden="true" />
            <div>
              <strong>这个入口和实际加载的助手不一致</strong>
              <span>可能打开了另一份 AI Carry、旧书签或复制错目录。为防止把指令交给错误助手，本页暂时只提供查看。</span>
            </div>
            <Button variant="outline" className="identity-warning__button" onClick={() => setIdentityIssueOpen(true)}>
              怎么处理
            </Button>
          </div>
        ) : null}

        {refreshError ? (
          <div className="refresh-error" role="status">
            暂时没有读到新的看板数据。当前内容仍可使用，你可以稍后重试；如果一直失败，再让 Agent 重新生成看板数据。
          </div>
        ) : null}

        <main id="main-content" ref={mainRef} className="app-main" tabIndex={-1}>
          <DashboardScrollRootContext.Provider value={mainRef}>
            <div className="page-frame">
              <AnimatePresence mode="wait">
                <motion.div
                  key={hashForRoute(route)}
                  initial={reduced ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduced ? undefined : { opacity: 0, y: -6 }}
                  transition={{ duration: 0.24, ease: [0.16, 0.84, 0.3, 1] }}
                >
                  {route.page === "home" ? <HomeView onNavigate={navigate} onCopy={requestCopy} /> : null}
                  {route.page === "library" ? (
                    <LibraryView
                      kind={(route.kind as LibraryKind | undefined) ?? "memories"}
                      onNavigate={navigate}
                      onCopy={requestCopy}
                      onInspect={setDetail}
                    />
                  ) : null}
                  {route.page === "workshop" ? <SkillWorkshop onCopy={requestCopy} /> : null}
                  {route.page === "growth" ? (
                    <GrowthView
                      kind={(route.kind as GrowthKind | undefined) ?? "todos"}
                      onNavigate={navigate}
                      onCopy={requestCopy}
                      onInspect={setDetail}
                    />
                  ) : null}
                  {route.page === "transfer" ? <TransferView onCopy={requestCopy} startComputerGuideRequest={transferStartRequest} /> : null}
                  {route.page === "system" ? <SystemView onRefresh={() => void refreshSnapshot()} onCopy={requestCopy} refreshIn={refreshIn} refreshFailed={refreshError} /> : null}
                </motion.div>
              </AnimatePresence>
            </div>
          </DashboardScrollRootContext.Provider>
        </main>

        <nav className="compact-window-nav" aria-label="紧凑窗口主要导航">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = item.page === route.page;
            return (
              <button
                key={item.page}
                type="button"
                className={active ? "is-active" : ""}
                aria-current={active ? "page" : undefined}
                onClick={() => navigate({ page: item.page })}
              >
                <Icon aria-hidden="true" />
                <span>{item.shortLabel}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <ItemDialog detail={detail} onClose={() => setDetail(null)} onCopy={requestCopy} />
      <CopyDialog state={copyState} onClose={() => setCopyState(EMPTY_COPY)} />
      <Dialog open={identityIssueOpen} onOpenChange={setIdentityIssueOpen}>
        <DialogContent className="identity-mismatch-dialog">
          <DialogHeader>
            <div className="identity-mismatch-dialog__state">
              <TriangleAlert aria-hidden="true" />
              <span>已暂停复制执行指令</span>
            </div>
            <DialogTitle>先确认你打开的是哪一份助手</DialogTitle>
            <DialogDescription>
              {profile.state === "snapshot-unavailable"
                ? "看板数据暂时无法读取，还不能判断是不是另一份助手，也不代表你的资料已经丢失。可以先复制只读排查请求。"
                : <>当前页面实际读取到的是“{profile.state === "instance" ? profile.displayName : "尚未创建助手的空白模板"}”，但浏览器入口携带的是另一份身份记录。看板内容仍可浏览；涉及执行的指令暂不复制，可以先只读排查。</>}
            </DialogDescription>
          </DialogHeader>

          <div className="identity-mismatch-dialog__steps">
            <article>
              <span>常见原因</span>
              <p>桌面上有多份入口、打开了旧书签，或者移动／复制目录后仍沿用了另一份助手的链接。</p>
            </article>
            <article>
              <span>安全处理</span>
              <p>请让当前 Agent 核对这个入口指向的安装目录、实例清单与看板快照；确认属于同一份助手后，再重建看板入口并重新打开。</p>
            </article>
          </div>

          <p className="identity-mismatch-dialog__note">
            链接里的匿名编号只用于发现开错入口，不包含助手名称、领域、个人资料或秘密，也不能当作授权凭据。
          </p>

          <DialogFooter>
            <Button className="control-button" onClick={requestIdentityDiagnosis}><ClipboardCopy size={15} />复制只读排查请求</Button>
            <Button className="control-button" onClick={() => setIdentityIssueOpen(false)}>我知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
        <DialogContent className={`snapshot-status-dialog snapshot-status-dialog--${localStatus.tone}`}>
          <DialogHeader>
            <div className={`snapshot-status-dialog__state snapshot-status-dialog__state--${localStatus.tone}`}>
              <StatusIcon aria-hidden="true" />
              <span>{localStatus.label}</span>
            </div>
            <DialogTitle>{localStatus.title}</DialogTitle>
            <DialogDescription>{localStatus.summary}</DialogDescription>
          </DialogHeader>

          <div className="snapshot-status-dialog__explanation">
            <article>
              <span>为什么显示这个状态</span>
              <p>{localStatus.reason}</p>
            </article>
            <article>
              <span>需要怎么处理</span>
              <p>{localStatus.nextStep}</p>
            </article>
          </div>

          <div className="snapshot-status-dialog__local-note">
            <HardDrive aria-hidden="true" />
            <p><strong>只说明这台电脑上的看板状态</strong><span>它不会把内容上传到 GitHub 或云端，也不代表远程备份已经完成。</span></p>
          </div>

          <DialogFooter className="snapshot-status-dialog__footer">
            <Button variant="outline" className="control-button" onClick={() => setStatusOpen(false)}>关闭</Button>
            {localStatus.tone === "template" ? (
              <Button
                className="control-button"
                onClick={() => {
                  setStatusOpen(false);
                  navigate({ page: "home" });
                }}
              >
                回到总览开始设置
              </Button>
            ) : null}
            {localStatus.canRebuild && rebuildAction ? (
              <Button
                variant="outline"
                className="control-button snapshot-status-dialog__repair"
                onClick={() => {
                  setStatusOpen(false);
                  void requestCopy(rebuildAction.request, rebuildAction.label);
                }}
              >
                <ClipboardCopy aria-hidden="true" />
                复制修复指令
              </Button>
            ) : null}
            {localStatus.canRefresh ? (
              <Button
                className="control-button"
                disabled={refreshing}
                onClick={() => {
                  setStatusOpen(false);
                  void refreshSnapshot();
                }}
              >
                <RefreshCw className={refreshing ? "is-spinning" : ""} aria-hidden="true" />
                {refreshing ? "正在重新读取" : "重新读取本地数据"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
