import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ENGLISH_TEXT } from "./i18n-catalog";

export type DashboardLocale = "zh-Hans" | "en";

const STORAGE_PREFIX = "ai-carry:dashboard-locale:";
const LEGACY_STORAGE_PREFIX = "agent-carry:dashboard-locale:";
const LOCALE_QUERY_KEY = "ac_lang";

function localeStorageKey(prefix = STORAGE_PREFIX): string {
  const path = `${window.location.pathname}|${document.baseURI}`;
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}${(hash >>> 0).toString(16)}`;
}

function queryLocale(): DashboardLocale | null {
  try {
    const value = new URL(window.location.href).searchParams.get(LOCALE_QUERY_KEY)?.trim().toLowerCase();
    if (value === "en" || value === "en-us" || value === "en-gb") return "en";
    if (value === "zh" || value === "zh-cn" || value === "zh-hans") return "zh-Hans";
  } catch {
    // A hardened local browser can limit URL access. Chinese remains the safe default.
  }
  return null;
}

function storedLocale(): DashboardLocale | null {
  try {
    const current = window.localStorage.getItem(localeStorageKey());
    if (current === "en" || current === "zh-Hans") return current;
    const legacy = window.localStorage.getItem(localeStorageKey(LEGACY_STORAGE_PREFIX));
    if (legacy === "en" || legacy === "zh-Hans") {
      window.localStorage.setItem(localeStorageKey(), legacy);
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveInitialLocale(): DashboardLocale {
  return storedLocale() ?? queryLocale() ?? "zh-Hans";
}

let runtimeLocale: DashboardLocale = typeof window === "undefined" ? "zh-Hans" : resolveInitialLocale();

export function getDashboardLocale(): DashboardLocale {
  return runtimeLocale;
}

function updateDocumentLanguage(locale: DashboardLocale): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = "ltr";
  document.documentElement.dataset.locale = locale;
}

export function setDashboardLocale(locale: DashboardLocale, persist = true): void {
  runtimeLocale = locale;
  updateDocumentLanguage(locale);
  if (!persist) return;
  try {
    window.localStorage.setItem(localeStorageKey(), locale);
  } catch {
    // Language switching still works for this session when storage is unavailable.
  }
}

function preserveOuterWhitespace(source: string, translated: string): string {
  const leading = source.match(/^\s*/)?.[0] ?? "";
  const trailing = source.match(/\s*$/)?.[0] ?? "";
  return `${leading}${translated}${trailing}`;
}

const ASSET_NOUN_EN: Record<string, string> = {
  "记忆": "memory",
  "流程": "workflow",
  "SOP": "workflow",
  "能力": "capability",
  "经验": "experience",
};

const ASSET_OPERATION_EN: Record<string, { imperative: string; passive: string }> = {
  "读取": { imperative: "read", passive: "read" },
  "执行": { imperative: "run", passive: "run" },
  "调用": { imperative: "invoke", passive: "invoked" },
  "参考": { imperative: "reference", passive: "referenced" },
};

const englishAssetNoun = (value: string) => ASSET_NOUN_EN[value] ?? value;
const englishAssetOperation = (value: string) => ASSET_OPERATION_EN[value] ?? { imperative: value, passive: value };

const DYNAMIC_TRANSLATIONS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^选择(记忆|SOP|能力|经验)：(.+)$/u, match => `Select ${englishAssetNoun(match[1])}: ${match[2]}`],
  [/^返回(记忆|SOP|能力|经验)$/u, match => `Back to ${({记忆:'memories',SOP:'workflows',能力:'capabilities',经验:'experiences'} as Record<string,string>)[match[1]]}`],
  [/^核对要(恢复|删除)的(记忆|SOP|能力|经验)$/u, match => `Review ${englishAssetNoun(match[2])} selection to ${match[1]==='恢复'?'restore':'delete'}`],
  [/^(删除|恢复)所选(记忆|SOP|能力|经验)$/u, match => `${match[1]==='恢复'?'Restore':'Delete'} selected ${({记忆:'memories',SOP:'workflows',能力:'capabilities',经验:'experiences'} as Record<string,string>)[match[2]]}`],
  [/^没有已移除的(记忆|SOP|能力|经验)$/u, match => `No removed ${({记忆:'memories',SOP:'workflows',能力:'capabilities',经验:'experiences'} as Record<string,string>)[match[1]]}`],
  [/^让 Agent 恢复这项(记忆|SOP|能力|经验)$/u, match => `Ask your Agent to restore this ${englishAssetNoun(match[1])}`],
  [/^取消选择：(.+)$/u, match => `Deselect: ${match[1]}`],
  [/^有\s*(\d+)\s*项内容暂未进入看板，源文件仍(?:原样|然)保留(?:，其他有效内容可以继续使用)?。$/u,
    (match) => `${match[1]} items are temporarily omitted from the dashboard. Their source files are unchanged, and other valid content remains available.`],
  [/^受影响类别：(.+)。这次隔离只影响对应内容，不会让整个助手停止工作。$/u,
    (match) => `Affected areas: ${match[1]}. Isolation is limited to that content and does not stop the whole assistant.`],
  [/^(\d+)\s*项暂未显示；源文件已保留，其他功能仍可用$/u,
    (match) => `${match[1]} items are temporarily hidden; source files are preserved and other features remain available`],
  [/^任务命中后按需(读取|执行|调用|参考)$/u, (match) => `${englishAssetOperation(match[1]).imperative[0].toUpperCase()}${englishAssetOperation(match[1]).imperative.slice(1)} on demand when a relevant task matches`],
  [/^这条(记忆|流程|能力|经验)有可核验的使用授权。Agent 仍会先核对当前范围、条件和风险，再只加载必要正文。$/u, (match) => `This ${englishAssetNoun(match[1])} has verifiable use authorization. The Agent still checks the current scope, conditions, and risk, then loads only the necessary content.`],
  [/^这条(记忆|流程|能力|经验)尚未成为稳定资产。只有当前任务精确命中已登记范围且没有冲突时才可(读取|执行|调用|参考)；范围外或影响不清时先询问用户。$/u, (match) => `This ${englishAssetNoun(match[1])} is not yet a stable asset. It may be ${englishAssetOperation(match[2]).passive} only when the current task exactly matches its recorded scope and there is no conflict; ask the user first outside that scope or when the impact is unclear.`],
  [/^这条(记忆|流程|能力|经验)的旧证据、适用范围或当前环境需要重新检查。复核完成前不能把它当作可用资产。$/u, (match) => `Earlier evidence, scope, or the current environment for this ${englishAssetNoun(match[1])} needs review. It cannot be treated as usable until that review is complete.`],
  [/^这条(记忆|流程|能力|经验)只保留用于解释、审计或以后恢复；重新启用前必须核对当前内容、范围和授权。$/u, (match) => `This ${englishAssetNoun(match[1])} is kept only for explanation, auditing, or possible restoration. Its current content, scope, and authorization must be checked before re-enabling it.`],
  [/^这条(记忆|流程|能力|经验)仍是候选或等待处理，不能仅凭看板内容直接(读取|执行|调用|参考)。$/u, (match) => `This ${englishAssetNoun(match[1])} is still a candidate or awaiting handling and cannot be ${englishAssetOperation(match[2]).passive} directly from dashboard content.`],
  [/^看板缺少足以确认这条(记忆|流程|能力|经验)可用的状态或授权信息。核对前不得自动或手动(读取|执行|调用|参考)正文。$/u, (match) => `The dashboard lacks enough status or authorization information to confirm that this ${englishAssetNoun(match[1])} is usable. Do not automatically or manually ${englishAssetOperation(match[2]).imperative} its content before verification.`],
  [/^查看(记忆|流程|能力|经验)历史状态$/u, (match) => `Check ${englishAssetNoun(match[1])} history status`],
  [/^复制(记忆|流程|能力|经验)复核指令$/u, (match) => `Copy ${englishAssetNoun(match[1])} review request`],
  [/^核对(记忆|流程|能力|经验)保存状态$/u, (match) => `Check ${englishAssetNoun(match[1])} saved status`],
  [/^核对(记忆|流程|能力|经验)状态$/u, (match) => `Check ${englishAssetNoun(match[1])} status`],
  [/^说明缺失：请让 Agent 补齐这条(记忆|流程|能力|经验)的用途说明，并重建看板数据。$/u, (match) => `Description missing: ask the Agent to add a purpose summary for this ${englishAssetNoun(match[1])} and rebuild the dashboard data.`],
  [/^当前助手[：·]\s*(.+)$/u, (match) => `Current assistant · ${match[1]}`],
  [/^当前可携带资产\s*(\d+)\s*项$/u, (match) => `${match[1]} portable assets`],
  [/^第\s*(\d+)\s*步$/u, (match) => `Step ${match[1]}`],
  [/^第\s*(\d+)\s*步[，,]\s*共\s*(\d+)\s*步$/u, (match) => `Step ${match[1]} of ${match[2]}`],
  [/^第\s*(\d+)\s*步[，,]\s*共\s*(\d+)\s*步\s*·\s*(.+)$/u, (match) => `Step ${match[1]} of ${match[2]} · ${localizeText(match[3])}`],
  [/^共\s*(\d+)\s*项$/u, (match) => `${match[1]} items`],
  [/^已经保存\s*(\d+)\s*项内容$/u, (match) => `${match[1]} saved items`],
  [/^待办事项\s*(\d+)\s*个$/u, (match) => `${match[1]} to-dos`],
  [/^(\d+)\s*项(.+)$/u, (match) => `${match[1]} ${localizeText(match[2])}`],
  [/^(.+?)\s*(\d+)\s*项$/u, (match) => `${localizeText(match[1])} ${match[2]}`],
  [/^了解“(.+)”$/u, (match) => `Learn what “${localizeText(match[1])}” means`],
  [/^当前确认：Level\s*(\d+)$/u, (match) => `Currently confirmed: Level ${match[1]}`],
  [/^这条内容当前处于“(.+)”状态。$/u, (match) => `This item is currently “${localizeText(match[1])}.”`],
  [/^约\s*(\d+)\s*分钟$/u, (match) => `about ${match[1]} min`],
  [/^约\s*(\d+)\s*小时$/u, (match) => `about ${match[1]} hr`],
  [/^约\s*(\d+)\s*天$/u, (match) => `about ${match[1]} days`],
  [/^更新于\s*(.+)$/u, (match) => `Updated ${match[1]}`],
];

export function localizeText(value: string): string {
  if (runtimeLocale !== "en" || !value.trim()) return value;
  const trimmed = value.trim();
  const exact = ENGLISH_TEXT[trimmed];
  if (exact) return preserveOuterWhitespace(value, exact);
  for (const [pattern, render] of DYNAMIC_TRANSLATIONS) {
    const match = trimmed.match(pattern);
    if (match) return preserveOuterWhitespace(value, render(match));
  }
  return value;
}

export function dashboardLanguageTag(): string {
  return runtimeLocale === "en" ? "en" : "zh-CN";
}

export function localizeAgentRequest(request: string): string {
  if (runtimeLocale !== "en") return request;
  return `# AI Carry request from an English dashboard

You are the current host Agent connected to this AI Carry. Communicate with the user in clear English throughout this task, including questions, previews, warnings, choices, progress updates, and the final verification report.

Treat English as the current interaction language unless the user asks for another language. During first-time instantiation, include that language preference in the complete preview instead of silently reverting to the template's Chinese placeholder. Never translate or rewrite user-authored memories, professional terms, source files, or local-private data merely because the dashboard is in English.

The canonical operational request below is stored in Simplified Chinese so AI Carry has one maintained protocol instead of separate language-specific logic. Read it completely and follow its meaning exactly. Do not omit its routing, confirmation, privacy, security, model-level, preservation, or reporting requirements. Do not ask the user to translate it. When a choice is needed, explain the concrete options and consequences in plain English; assume the user may be new to Agents or programming without treating them as incapable.

Secrets such as API keys, passwords, tokens, cookies, private keys, recovery codes, and login state must never be copied into model prompts, migration files, GitHub repositories, or reports. Use only the host Agent's approved login or secret-management mechanism.

--- BEGIN CANONICAL AI CARRY REQUEST ---

${request}

--- END CANONICAL AI CARRY REQUEST ---`;
}

type LocaleContextValue = {
  locale: DashboardLocale;
  setLocale: (locale: DashboardLocale) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleRoot({ children }: { children: (locale: DashboardLocale) => ReactNode }) {
  const [locale, setLocaleState] = useState<DashboardLocale>(() => {
    const initial = resolveInitialLocale();
    setDashboardLocale(initial, false);
    return initial;
  });
  const setLocale = useCallback((next: DashboardLocale) => {
    setDashboardLocale(next);
    setLocaleState(next);
  }, []);
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children(locale)}</LocaleContext.Provider>;
}

export function useDashboardLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useDashboardLocale must be used inside LocaleRoot");
  return value;
}
