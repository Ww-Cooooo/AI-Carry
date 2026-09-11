const forbiddenQueryControl = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const automaticReuseStopSignal = /(?:不要(?:再|继续|沿用|照旧|使用|按|照)?|别(?:再|继续|沿用|照旧|使用|按|照)?|不用(?:再|这个|之前|按|照)?|不(?:想|愿意|愿|打算|准备)(?:再|继续|沿用|照旧|使用|按|照)?|不按(?!时)|(?:暂时|先)不(?:再|继续|沿用|照旧|使用|按|照)?|拒绝(?:再|继续|沿用|照旧|使用|按|照)?|请勿|(?:请)?避免|无需|不必|不需要|停止|停用|取消|不再|这次不按|这次别按|不要这样|不是这样|换一种|换个方式|重新来|纠正|更正|改掉|do\s+not|don't|dont|not\s+this\s+time|no\s+longer|avoid|stop|disable|cancel|do\s+something\s+else|use\s+a\s+different|correct\s+this)/iu;
const globalReuseCorrectionSignal = /(?:不要这样|不是这样|换一种|换个方式|重新来|纠正|更正|改掉|stop|disable|cancel|do\s+something\s+else|use\s+a\s+different|correct\s+this)/iu;
const explicitReuseOptOutSignal = /(?:(?:不要|别|不用|不想|不愿|不打算|不准备|暂时不|先不|拒绝|无需|不必|不需要|停止|停用|取消|不再)\s*(?:再|继续)?\s*(?:使用|沿用|照旧|按|照|套用|调用|参考)|(?:do\s+not|don't|dont|avoid|stop|disable|cancel|no\s+longer)\s+(?:use|reuse|follow|apply|invoke|refer\s+to))/iu;
const negatedStopException = /(?:不要忘记|别忘(?:记|了)?|不要漏(?:掉)?|仍然不要忘记|不想忘记|不愿忘记|(?:请)?避免忘记|don't\s+forget|do\s+not\s+forget|avoid\s+forgetting)/giu;
const clauseBoundary = /(?:[，,。.!！？?；;]+|\s*(?:但是|但|不过|然而|可是)\s*|\s+(?:but|however|whereas)\s+)/iu;
const minimumAutomaticPhraseLength = 4;

function normalizeWhitespace(value) {
  return value.replace(/[\t\r\n ]+/gu, " ").trim().normalize("NFC");
}

export function normalizeRetrievalRequest(queryText = "", intentHints = [], workSignals = []) {
  if (typeof queryText !== "string" || [...queryText].length > 1000 || forbiddenQueryControl.test(queryText)) {
    return Object.freeze({ ok: false, reason: "query-invalid", query: "", hints: Object.freeze([]), workSignals: Object.freeze([]) });
  }
  const query = normalizeWhitespace(queryText);
  if ([...query].length > 500) return Object.freeze({ ok: false, reason: "query-too-long", query: "", hints: Object.freeze([]), workSignals: Object.freeze([]) });
  if (!Array.isArray(intentHints) || intentHints.length > 3) return Object.freeze({ ok: false, reason: "intent-hints-invalid", query: "", hints: Object.freeze([]), workSignals: Object.freeze([]) });
  const hints = [];
  for (const hint of intentHints) {
    if (typeof hint !== "string" || [...hint].length > 200 || forbiddenQueryControl.test(hint)) return Object.freeze({ ok: false, reason: "intent-hint-invalid", query: "", hints: Object.freeze([]), workSignals: Object.freeze([]) });
    const normalized = normalizeWhitespace(hint);
    if (!normalized || [...normalized].length > 120) return Object.freeze({ ok: false, reason: "intent-hint-invalid", query: "", hints: Object.freeze([]), workSignals: Object.freeze([]) });
    hints.push(normalized);
  }
  if (!Array.isArray(workSignals) || workSignals.length > 6) return Object.freeze({ ok: false, reason: "work-signals-invalid", query: "", hints: Object.freeze([]), workSignals: Object.freeze([]) });
  const signals = [];
  for (const signal of workSignals) {
    if (typeof signal !== "string" || [...signal].length > 200 || forbiddenQueryControl.test(signal)) return Object.freeze({ ok: false, reason: "work-signal-invalid", query: "", hints: Object.freeze([]), workSignals: Object.freeze([]) });
    const normalized = normalizeWhitespace(signal);
    if (!normalized || [...normalized].length > 120) return Object.freeze({ ok: false, reason: "work-signal-invalid", query: "", hints: Object.freeze([]), workSignals: Object.freeze([]) });
    signals.push(normalized);
  }
  const uniqueSignals = [...new Set(signals)];
  if (!query && uniqueSignals.length === 0) return Object.freeze({ ok: false, reason: "query-empty", query: "", hints: Object.freeze([]), workSignals: Object.freeze([]) });
  return Object.freeze({ ok: true, reason: "", query, hints: Object.freeze([...new Set(hints)]), workSignals: Object.freeze(uniqueSignals) });
}

export function normalizeMatchText(value) {
  return String(value).toLowerCase().normalize("NFC").replace(/[\s，。！？、,.!?：:；;（）()\[\]{}'"`/\\_-]/gu, "");
}

function bigrams(value) {
  const text = [...normalizeMatchText(value)];
  return new Set(text.slice(0, -1).map((character, index) => character + text[index + 1]));
}

export function lexicalSimilarity(left, right) {
  const normalizedLeft = normalizeMatchText(left);
  const normalizedRight = normalizeMatchText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 1;
  const a = bigrams(normalizedLeft); const b = bigrams(normalizedRight);
  if (a.size === 0 || b.size === 0) return normalizedLeft === normalizedRight ? 1 : 0;
  const overlap = [...a].filter((item) => b.has(item)).length;
  return overlap / Math.max(1, Math.min(a.size, b.size));
}

export function projectRecallUse(selected, state, evidence = selected?.retrievalEvidence ?? {}) {
  return Object.freeze({
    state,
    assetId: selected?.id ?? null,
    assetKind: selected?.asset_kind ?? selected?.kind ?? null,
    title: selected?.title ?? null,
    triggerSources: Object.freeze([
      ...(evidence.directUserMatch ? ["user-language"] : []),
      ...(evidence.workSignalMatch ? ["work-context"] : []),
      ...(evidence.hintOnlyMatch ? ["bounded-intent-hint"] : []),
    ]),
    // Reading is observable here; application and its outcome are not.
    userReportRequired: false,
    userReportContract: state === "asset-body-loaded"
      ? "report-actual-application-only-not-body-loading"
      : "standalone-brief-no-long-term-asset-used-or-recall-degraded",
    ...(state === "asset-body-loaded" ? {
      applicationGuidance: "Reading is not use or proof of success. Compare the asset with the current goal, scope and contrary evidence; turn the relevant part into a concrete choice before acting. Report actual use briefly under 🧠, not a planned use. Check the result against the user's goal, not retrieval/build success. If the outcome fails, report it and refine the original lesson within existing write authority; do not repeat the same attempt or claim the lesson is proven. No extra form, global gate or automatic action authorization is required.",
    } : {}),
  });
}

function reuseStopRequestedForEntry(userSignal, entryPhrases) {
  // A negative word elsewhere in the request must not disable an unrelated
  // habit. Keep narrow, unambiguous correction phrases global; otherwise the
  // stop word and the habit's own trigger/scope must occur in the same clause.
  const inspected = userSignal.replace(negatedStopException, " ");
  if (globalReuseCorrectionSignal.test(inspected)) return true;
  const informative = entryPhrases.filter((phrase) => normalizeMatchText(phrase).length >= minimumAutomaticPhraseLength);
  if (informative.length === 0) return false;
  const declaredNegativeRules = informative.filter((phrase) => automaticReuseStopSignal.test(phrase));
  return inspected.split(clauseBoundary).some((clause) => {
    if (!automaticReuseStopSignal.test(clause) || !informative.some((phrase) => lexicalSimilarity(clause, phrase) >= 0.45)) return false;
    // A saved rule can itself be phrased as “不要……” or “别……”. Repeating
    // that rule is a positive recall request, not a request to disable the
    // memory. Only a meta-level opt-out such as “不要使用/沿用/按这条习惯”
    // overrides a matching negative rule.
    const normalizedClause = normalizeMatchText(clause);
    const repeatsDeclaredNegativeRule = declaredNegativeRules.some((phrase) => normalizedClause.includes(normalizeMatchText(phrase)));
    return !repeatsDeclaredNegativeRule || explicitReuseOptOutSignal.test(clause);
  });
}

function requestsExcludedScope(signal, phrase) {
  const excludedText = normalizeMatchText(phrase);
  if (excludedText.length < 2) return false;
  let remainingMentions = normalizeMatchText(signal).split(excludedText).length - 1;
  // An action explicitly prohibited in its own clause is not requested scope:
  // “continue the task; do not send externally” must still find the local task.
  // Only recognise direct prohibitions. Ambiguous, double-negative or mixed
  // requests keep the exclusion; this does not rewrite the original instruction
  // or authorise any action. Check every mention, not just the first one.
  for (const clause of signal.split(clauseBoundary)) {
    const normalized = normalizeMatchText(clause);
    for (let offset = normalized.indexOf(excludedText); offset !== -1;
      offset = normalized.indexOf(excludedText, offset + excludedText.length)) {
      const prefix = normalized.slice(0, offset);
      const prohibition = /(?:不要|请勿|切勿|禁止|不得|不准|不必|无需|不需要|别)(?:再|继续|自动|直接|擅自)?$|(?:donot|dont|mustnot|never)(?:automatically|directly)?$/u.exec(prefix);
      if (!prohibition || automaticReuseStopSignal.test(phrase)
        || /(?:不|没|无|别|非|donot|dont|isnot|isnt|never|cannot|cant|without)/u.test(prefix.slice(0, prohibition.index))) return true;
      remainingMentions -= 1;
    }
  }
  // Keep the original conservative match for mentions spanning punctuation.
  return remainingMentions > 0;
}

export function rankRetrievalEntries(entries, request, { limit = 3, lifecyclePriority = () => 0 } = {}) {
  // The public callers keep the default model-visible cap of three. A trusted
  // route adapter may request more metadata-only ranked rows so invalid top
  // entries cannot hide the next valid match before the final cap is applied.
  if (!request?.ok || !Array.isArray(entries) || !Number.isInteger(limit) || limit < 1 || limit > 128) return Object.freeze([]);
  const userSignal = request.query;
  const hintSignals = request.hints;
  const workSignals = request.workSignals ?? Object.freeze([]);
  const ranked = [];
  for (const entry of entries) {
    const excludes = Array.isArray(entry.excludes) ? entry.excludes : [];
    // Requested excluded scope can remove a match. Work-context exclusions
    // prevent reuse, but keep metadata visible for diagnosis or correction.
    // Intent rewrites alone must never suppress a user-grounded match.
    const excluded = excludes.some((phrase) => requestsExcludedScope(userSignal, phrase));
    if (excluded) continue;
    const workContextExcluded = excludes.some((phrase) => workSignals.some((signal) => requestsExcludedScope(signal, phrase)));
    const triggerPhrases = [...(entry.triggers ?? []), ...(entry.aliases ?? [])].filter(Boolean);
    const topicPhrases = [entry.topic_key].filter(Boolean);
    const subjectPhrases = [entry.subject_key].filter(Boolean);
    const declaredScopePhrases = (entry.scope ?? []).filter(Boolean);
    const conditionPhrases = (entry.conditions ?? []).filter(Boolean);
    const scopePhrases = [...topicPhrases, ...subjectPhrases, ...declaredScopePhrases, ...conditionPhrases];
    const phrases = [entry.title, entry.summary, ...triggerPhrases, ...scopePhrases].filter(Boolean);
    const reuseStopOrCorrectionRequested = reuseStopRequestedForEntry(userSignal,
      [entry.title, ...triggerPhrases, ...topicPhrases, ...subjectPhrases, ...declaredScopePhrases]);
    const userScore = Math.max(0, ...phrases.map((phrase) => lexicalSimilarity(userSignal, phrase)));
    const hintScore = Math.max(0, ...hintSignals.flatMap((signal) => phrases.map((phrase) => lexicalSimilarity(signal, phrase))));
    const workScore = Math.max(0, ...workSignals.flatMap((signal) => phrases.map((phrase) => lexicalSimilarity(signal, phrase))));
    const coverageScore = (signals) => signals.length === 0 ? 0
      : signals.map((signal) => Math.max(0, ...phrases.map((phrase) => lexicalSimilarity(signal, phrase))))
        .reduce((total, value) => total + value, 0) / signals.length;
    const workSignalCoverageScore = coverageScore(workSignals);
    const hintCoverageScore = coverageScore(hintSignals);
    const score = Math.max(userScore, workScore, hintScore);
    if (score < 0.24) continue;
    // Free-form intent hints may widen a shortlist but cannot authorize reuse.
    // Bounded current-work signals may select an already-approved habit only
    // when trigger, object/scope, conditions, and user wording do not conflict.
    const automaticTriggerPhrases = triggerPhrases.filter((phrase) => normalizeMatchText(phrase).length >= minimumAutomaticPhraseLength);
    const informative = (phrases) => phrases.filter((phrase) => normalizeMatchText(phrase).length >= minimumAutomaticPhraseLength);
    const automaticTopicPhrases = informative(topicPhrases);
    const automaticSubjectPhrases = informative(subjectPhrases);
    const automaticDeclaredScopePhrases = informative(declaredScopePhrases);
    const automaticConditionPhrases = informative(conditionPhrases);
    const scoreAgainst = (signals, phrase) => Math.max(0, ...signals.map((signal) => lexicalSimilarity(signal, phrase)));
    const userSignals = userSignal ? [userSignal] : [];
    const triggerScore = Math.max(0, ...automaticTriggerPhrases.map((phrase) => scoreAgainst(userSignals, phrase)));
    const topicScore = Math.max(0, ...automaticTopicPhrases.map((phrase) => scoreAgainst(userSignals, phrase)));
    const subjectScore = Math.max(0, ...automaticSubjectPhrases.map((phrase) => scoreAgainst(userSignals, phrase)));
    const declaredScopeScore = Math.max(0, ...automaticDeclaredScopePhrases.map((phrase) => scoreAgainst(userSignals, phrase)));
    const conditionScores = automaticConditionPhrases.map((phrase) => scoreAgainst(userSignals, phrase));
    const workTriggerScore = Math.max(0, ...automaticTriggerPhrases.map((phrase) => scoreAgainst(workSignals, phrase)));
    const workTopicScore = Math.max(0, ...automaticTopicPhrases.map((phrase) => scoreAgainst(workSignals, phrase)));
    const workSubjectScore = Math.max(0, ...automaticSubjectPhrases.map((phrase) => scoreAgainst(workSignals, phrase)));
    const workDeclaredScopeScore = Math.max(0, ...automaticDeclaredScopePhrases.map((phrase) => scoreAgainst(workSignals, phrase)));
    const workConditionScores = automaticConditionPhrases.map((phrase) => scoreAgainst(workSignals, phrase));
    const requiredDimensionScores = [
      ...(topicPhrases.length ? [topicScore] : []),
      ...(subjectPhrases.length ? [subjectScore] : []),
      ...(declaredScopePhrases.length ? [declaredScopeScore] : []),
    ];
    const workRequiredDimensionScores = [
      ...(topicPhrases.length ? [workTopicScore] : []),
      ...(subjectPhrases.length ? [workSubjectScore] : []),
      ...(declaredScopePhrases.length ? [workDeclaredScopeScore] : []),
    ];
    const scopeScore = requiredDimensionScores.length ? Math.min(...requiredDimensionScores) : 0;
    const workScopeScore = workRequiredDimensionScores.length ? Math.min(...workRequiredDimensionScores) : 0;
    const querySignalLength = normalizeMatchText(request.query).length;
    const workSignalLength = Math.max(0, ...workSignals.map((signal) => normalizeMatchText(signal).length));
    const hasInformativeTrigger = automaticTriggerPhrases.length > 0;
    const groundingDeclared = topicPhrases.length + subjectPhrases.length + declaredScopePhrases.length > 0;
    const allDeclaredGroundingInformative = topicPhrases.length === automaticTopicPhrases.length
      && subjectPhrases.length === automaticSubjectPhrases.length
      && declaredScopePhrases.length === automaticDeclaredScopePhrases.length;
    const allConditionsInformative = conditionPhrases.length === automaticConditionPhrases.length;
    const conditionsSatisfied = conditionScores.every((score) => score >= 0.45);
    const workConditionsSatisfied = workConditionScores.every((score) => score >= 0.45);
    const userAutomaticScopeEvidence = !workContextExcluded && !reuseStopOrCorrectionRequested && hasInformativeTrigger && groundingDeclared
      && allDeclaredGroundingInformative && allConditionsInformative && conditionsSatisfied
      && triggerScore >= 0.72 && scopeScore >= 0.45 && querySignalLength >= minimumAutomaticPhraseLength;
    const workAutomaticScopeEvidence = !workContextExcluded && !reuseStopOrCorrectionRequested && hasInformativeTrigger && groundingDeclared
      && allDeclaredGroundingInformative && allConditionsInformative && workConditionsSatisfied
      && workTriggerScore >= 0.72 && workScopeScore >= 0.45 && workSignalLength >= minimumAutomaticPhraseLength;
    const automaticScopeEvidence = userAutomaticScopeEvidence || workAutomaticScopeEvidence;
    const matchPriority = userScore >= 0.24 ? 3 : workScore >= 0.24 ? 2 : 1;
    ranked.push({ entry, score, userScore, workScore, hintScore, workSignalCoverageScore, hintCoverageScore,
      matchPriority, direct: userScore >= 0.24, lifecycle: lifecyclePriority(entry), evidence: Object.freeze({
      triggerScore, scopeScore, workTriggerScore, workScopeScore, automaticScopeEvidence,
      automaticEvidenceSource: userAutomaticScopeEvidence && workAutomaticScopeEvidence ? "user-language-and-work-context"
        : userAutomaticScopeEvidence ? "user-language" : workAutomaticScopeEvidence ? "work-context" : "none",
      reuseStopOrCorrectionRequested, workContextExcluded,
      topicScore, subjectScore, declaredScopeScore, conditionsSatisfied, workConditionsSatisfied,
      automaticBlockedReason: reuseStopOrCorrectionRequested ? "user-negation-stop-or-correction"
        : workContextExcluded ? "work-context-excluded"
        : !hasInformativeTrigger || !groundingDeclared || !allDeclaredGroundingInformative || !allConditionsInformative ? "trigger-or-scope-too-generic"
          : !conditionsSatisfied && !workConditionsSatisfied ? "required-condition-not-established"
          : automaticScopeEvidence ? "" : "positive-evidence-insufficient",
      directUserMatch: userScore >= 0.24, workSignalMatch: workScore >= 0.24,
      workSignalCoverageScore, hintCoverageScore,
      hintOnlyMatch: userScore < 0.24 && workScore < 0.24 && hintScore >= 0.24,
    }) });
  }
  ranked.sort((left, right) => {
    if (left.matchPriority !== right.matchPriority) return right.matchPriority - left.matchPriority;
    const semanticDelta = left.matchPriority === 3 ? right.userScore - left.userScore
      : left.matchPriority === 2 ? right.workScore - left.workScore : right.hintScore - left.hintScore;
    if (Math.abs(semanticDelta) > 0.08) return semanticDelta;
    const coverageDelta = left.matchPriority === 2 ? right.workSignalCoverageScore - left.workSignalCoverageScore
      : left.matchPriority === 1 ? right.hintCoverageScore - left.hintCoverageScore : 0;
    if (Math.abs(coverageDelta) > 0.08) return coverageDelta;
    return right.lifecycle - left.lifecycle || semanticDelta || right.hintScore - left.hintScore || left.entry.id.localeCompare(right.entry.id);
  });
  // Keep a strong current-work candidate visible even when generic user words
  // fill the shortlist. This is candidate diversity, NOT permission to apply it.
  // Arrange the first three even for adapters that request extra metadata rows.
  const visibleLimit = Math.min(limit, 3);
  const workCandidate = ranked.filter((item) => item.workScore >= 0.24 && !item.evidence.workContextExcluded)
    .sort((a, b) => b.workSignalCoverageScore - a.workSignalCoverageScore || b.workScore - a.workScore)[0];
  const workIndex = ranked.indexOf(workCandidate);
  if (visibleLimit > 1 && workIndex >= visibleLimit) {
    ranked.splice(workIndex, 1);
    ranked.splice(visibleLimit - 1, 0, workCandidate);
  }
  return Object.freeze(ranked.slice(0, limit).map(({ entry, score, lifecycle, evidence }) => Object.freeze({ entry, score, lifecycle, evidence })));
}
