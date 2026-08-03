# fetch_page: HTML `<title>` 回退，修复标题丢失日期导致的证据不足

## 元数据

| 字段 | 内容 |
|---|---|
| 日期 | 2026-08-03 |
| Issue | https://github.com/LuzernRR/agent-workbench/issues/33 |
| PR | https://github.com/LuzernRR/agent-workbench/pull/34 |
| 状态 | awaiting-acceptance |
| 目标环境 | local |

## 问题与目标

### 问题

7 次「今天是几号」实测：2/7 返回「无法确认今天的日期」。Writer 行为本身是正确的——它严格遵守
WRITER_PROMPT「每个事实性陈述必须能由来源支持」。问题在上游：Evidence 的 title 字段丢失了日期。

根因：`trafilatura.extract_metadata()` 从黄历类页面抽到的是导航面包屑 `"黄历"`，而非 HTML
`<title>` 标签里的 `"2026年08月03日农历是多少_2026年08月03日星期几-黄历网"`。同时
`trafilatura.extract()` 提取的正文也不含日期（`body 含 2026 = False`），所以标题是唯一的日期信号。

标题经 `channels/web.py:82` 的 `page.title or hit.title or page.url` 进入 `SearchEvidence.title`，
再作为 `[来源N] {title}` 送给 Writer。标题丢掉日期后，Writer 判定证据不足，正确拒绝作答。

另外 5/7「正确」答案实际上违反了 WRITER_PROMPT——它们靠 URL 路径猜测日期，属于偶然正确。

### 目标

`_fetch_static()` 在 trafilatura metadata title 缺失或过短时，回退到 HTML `<title>` 标签，
保留日期等关键限定词。trafilatura 已给出有效标题的页面行为不变。

### 范围

仅 `services/search-agent/app/tools/fetch_page.py` + 新增测试文件。

### 非目标

- 不改 robots / SSRF / URL policy 任何门禁逻辑。
- 不改 `channels/web.py` 的 title 优先级链（`page.title or hit.title or page.url`）。
- 不改 Writer 的引用规则。

## 根因

`_fetch_static()` 第 158–162 行只用 trafilatura metadata title，未回退到 HTML `<title>` 标签：

```python
# 修复前
text = trafilatura.extract(response.text, url=url) or ""
title = None
meta = trafilatura.extract_metadata(response.text)
if meta is not None:
    title = getattr(meta, "title", None)
# title = "黄历"（错误，导航面包屑）
```

## 方案

新增两个纯函数：

- `_html_title(markup)` — 正则取 `<title>` 标签，反转义 HTML 实体，剥内联标签，归一空白，限长 300。
- `_resolve_title(meta_title, markup)` — trafilatura 标题为 None 或 ≤10 字符时回退；两者都有时取信息量更大的一个。

`_fetch_static()` 改用 `_resolve_title()`。

## 逐文件修改

| 文件 | 修改 | 原因 |
|---|---|---|
| `app/tools/fetch_page.py` | 新增 `import html`, `import re`；新增 `_HTML_TITLE_RE`, `_MIN_INFORMATIVE_TITLE_CHARS`, `_MAX_TITLE_CHARS` 常量；新增 `_html_title()`, `_resolve_title()`；`_fetch_static()` 改用 `_resolve_title()` | 修复标题丢失日期 |
| `tests/test_fetch_page_title.py` | 新增 7 条单测 + 1 条集成测试 | 锁定回退行为与边界 |

## 验证证据

### 单元与静态门禁

| 门禁 | 结果 |
|---|---|
| `pytest tests/test_fetch_page_title.py -q` | 7 passed |
| `pytest -q`（全量） | 408 passed |
| `ruff check .` | All checks passed |
| `compileall -q app` | 通过 |

### 真实页面探针（`scripts/title_probe.py`）

| URL | 修复前 title | 修复后 title | title 含 2026 |
|---|---|---|---|
| `huangli.com/huangli/2026/08_03.html` | `"黄历"` | `"2026年08月03日农历是多少_2026年08月03日星期几-黄历网"` | True |
| `langchain.com/langgraph` | `"LangGraph: Agent Orchestration Framework…"` | 同上（trafilatura 已有效，未改写） | — |

### 真实链路实测（本地 8101，`scripts/ttft_probe.py --skip-old`）

| 指标 | 值 |
|---|---|
| total | 15662ms |
| firstVisible | 14144ms (answer.delta) |
| model | 3 |
| tool | 1 |
| violations | 0 |
| answerPreview | `根据万年日历查询，今天是2026年8月3日，星期一，农历六月廿一（丙午年乙未月辛亥日）[来源1]。` |

答案含真实来源引用，`verificationPassed=true`，`isPrefix=True`，`streamedEqualsFinal=True`。

## 数据与安全

- 未新增网络出口，未改渠道与 SSRF/robots 门禁，全部既有安全测试通过。
- API Key 仍只在 `config/*.local.json`，未新增 `NEXT_PUBLIC_` 暴露。

## 回滚

`git revert` 本次提交即可。无数据迁移、无契约变更；回滚后行为退回修复前（标题丢失日期，Writer 拒绝作答）。

## 未解决问题

- `_freshness_required()` 正则（Item I）仍作为兜底存在，建议单独 Issue 评估移除。
- 真实链路 TTFT 仍有 14s 落在 Writer 之前，阶段 4–5 的性能改造待推进。

## 用户验收

- 状态：等待验收
- 验收反馈：待填写
- 下一功能执行门：阻塞
