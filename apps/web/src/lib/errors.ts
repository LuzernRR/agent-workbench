const NETWORK_ERROR_PATTERNS = [
  /^failed to fetch$/i,
  /^load failed$/i,
  /^networkerror\b/i,
  /^network request failed$/i
];

const WORKBENCH_ERROR_MESSAGES: Array<[RegExp, string]> = [
  [/\bthread not found\b/i, "会话不存在"],
  [/\bproject not found\b/i, "项目不存在"],
  [/\bagent (?:not found|unavailable)\b/i, "助手配置暂不可用"],
  [/\bmodel (?:not found|unavailable)\b/i, "所选模型暂不可用"],
  [/\bbackend unavailable\b|\bservice unavailable\b/i, "工作台服务暂不可用"],
  [/\bunauthorized\b/i, "登录状态已失效"],
  [/\bforbidden\b|\baccess denied\b/i, "没有执行此操作的权限"],
  [/\brequest timed out\b|\btimeout\b/i, "请求超时，请重试"],
  [/\bpayload too large\b|\bfile too large\b/i, "附件大小超过限制"],
  [/\bunsupported media type\b|\bunsupported file\b/i, "不支持此附件格式"],
  [/\binternal server error\b/i, "工作台服务发生错误"]
];

const RUN_FAILURE_MESSAGES: Array<[RegExp, string]> = [
  [/duplicate entry[\s\S]*wb_tool_call/i, "任务状态发生冲突，请重新发起任务"],
  [/\binternal server error\b/i, "工作台服务发生错误"],
  [/required_claim_facets_missing/i, "引用未覆盖任务要求的关键结论"],
  [/invalid_or_insecure_url/i, "引用来源地址未通过安全检查"],
  [/discovery_page_is_not_evidence/i, "搜索结果页不能作为有效证据"],
  [/insufficient_content/i, "引用来源内容不足，无法形成可靠结论"],
  [/query_not_entailed/i, "引用内容与当前任务不匹配"],
  [/citation failed the Java evidence gate/i, "引用未通过证据质量检查"],
  [/\bno_relevant_evidence\b|no relevant product evidence/i, "没有找到足以支持结论的可靠证据"],
  [/\bno_adopted_evidence\b|no adopted evidence/i, "没有可用于生成报告的可靠证据"],
  [/\bcitation_persist_failed\b|citation store did not persist/i, "引用保存失败"],
  [/\bsearch_empty\b|search provider returned no response/i, "搜索服务未返回结果"],
  [/\brun_deadline_exceeded\b|run deadline elapsed/i, "任务执行超时"],
  [/\brun_cancelled\b|run was cancelled/i, "任务已停止"],
  [/\bagent_runtime_error\b|agent execution failed/i, "任务运行失败"]
];

export function getWorkbenchErrorMessage(error: unknown, fallback = "工作台请求失败") {
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message || NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return fallback;
  for (const [pattern, localized] of WORKBENCH_ERROR_MESSAGES) {
    if (pattern.test(message)) return localized;
  }
  if (/(?:runtimeerror|exception|traceback|stack trace|caused by:|\bat\s+[a-z][\w$.]+\()/i.test(message)) return fallback;
  if (/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/.test(message)) return fallback;
  if (!/\p{Script=Han}/u.test(message) && /[A-Za-z]{3}/u.test(message)) return fallback;
  return message;
}

export function getRunFailureMessage(message: string) {
  const visible = message.split(/。请注入\s+/u, 1)[0].trim();
  for (const [pattern, localized] of RUN_FAILURE_MESSAGES) {
    if (pattern.test(visible)) return localized;
  }

  const localizedRuntime = visible
    .replace(/\s*LangGraph\s+runtime\s*/gi, "运行环境")
    .replace(/\s*\bruntime\b\s*/gi, "运行环境")
    .trim();
  if (!localizedRuntime) return "任务执行失败";

  // Unknown implementation exceptions and machine-readable error codes must
  // remain fail-closed without leaking Java/Python class names or internal IDs.
  if (
    /(?:exception|traceback|error:|failed\b|failure\b)/i.test(localizedRuntime)
    || /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(localizedRuntime)
    || /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(localizedRuntime)
  ) {
    return "任务执行失败，请稍后重试";
  }

  return localizedRuntime;
}
