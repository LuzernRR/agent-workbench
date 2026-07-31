export type SearchPromptExample = {
  readonly id: "web" | "xiaohongshu" | "x";
  readonly title: string;
  readonly prompt: string;
};

export const SEARCH_PROMPT_EXAMPLES: readonly SearchPromptExample[] = [
  {
    id: "web",
    title: "学生 · 英国硕士奖学金",
    prompt: "请搜索 2026 年面向中国大陆本科生的英国授课型硕士奖学金与学费减免信息，优先阅读英国大学官网、British Council 和政府页面。筛选仍可申请的项目，按“学校 / 专业限制 / 金额或减免方式 / 申请截止日 / 适合人群 / 官方来源”整理；过期或二手转述不纳入结论。"
  },
  {
    id: "xiaohongshu",
    title: "女性通勤 · 油敏皮夏季防晒",
    prompt: "请搜索小红书上关于“油敏皮夏季通勤防晒”的近期使用笔记。只读取可访问正文，按“肤质与场景 / 使用感受 / 防晒产品类型 / 可能不适合的人群 / 来源链接”归纳 3–5 条经验；不得把个人体验写成医疗建议，正文不可读时不展示为证据。"
  },
  {
    id: "x",
    title: "求职学生 · AI 产品岗位动态",
    prompt: "请搜索 X 上近 90 天关于“AI 产品实习 / Agent 产品岗位”的公开讨论和招聘帖，优先读取可访问帖文正文。为准备求职的学生筛选 3–5 条，按“岗位或技能要求 / 原帖观点 / 对简历准备的启发 / 链接”整理；未读取正文的候选不得写入结论。"
  }
];

export function SearchPromptExamples({
  onSelect
}: {
  onSelect: (example: SearchPromptExample) => void;
}) {
  return (
    <div className="mt-7 grid w-full max-w-[760px] grid-cols-1 gap-3 sm:grid-cols-3" aria-label="搜索案例">
      {SEARCH_PROMPT_EXAMPLES.map((example) => (
        <button
          key={example.id}
          type="button"
          className="min-h-[88px] rounded-2xl border border-line bg-white px-4 py-3 text-left text-[15px] font-medium leading-6 text-ink shadow-sm transition-[background-color,border-color,transform] duration-150 hover:border-[#c9c9c7] hover:bg-panel active:scale-[0.985]"
          aria-label={`填入案例：${example.title}`}
          onClick={() => onSelect(example)}
        >
          {example.title}
        </button>
      ))}
    </div>
  );
}
