package xiaohongshu

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/errors"
	"github.com/xpzouying/xiaohongshu-mcp/humanize"
)

type SearchResult struct {
	Search struct {
		Feeds FeedsValue `json:"feeds"`
	} `json:"search"`
}

const searchReadTimeout = 12 * time.Second

const (
	searchStateWaitTimeout    = 8 * time.Second
	searchStatePollInterval   = 350 * time.Millisecond
	searchStateEvalTimeout    = 900 * time.Millisecond
	searchDiagnosticAfter     = 4 * time.Second
	searchContextSafetyMargin = 1200 * time.Millisecond
)

type searchPageSnapshot struct {
	State           string   `json:"state"`
	Path            string   `json:"path"`
	ReadyState      string   `json:"readyState"`
	HasInitialState bool     `json:"hasInitialState"`
	HasSearchState  bool     `json:"hasSearchState"`
	FeedCount       int      `json:"feedCount"`
	FeedKeys        []string `json:"feedKeys"`
	ExploreLinks    int      `json:"exploreLinks"`
	RateLimited     bool     `json:"rateLimited"`
	Empty           bool     `json:"empty"`
	LoginVisible    bool     `json:"loginVisible"`
}

const searchPageSnapshotJS = `() => {
	const unwrap = (candidate) => {
		if (!candidate || typeof candidate !== "object") return candidate;
		if (candidate.value !== undefined) return candidate.value;
		if (candidate._value !== undefined) return candidate._value;
		if (candidate._rawValue !== undefined) return candidate._rawValue;
		return candidate;
	};
	const feedsContainer = window.__INITIAL_STATE__?.search?.feeds;
	const feeds = unwrap(feedsContainer);
	const rawUser = window.__INITIAL_STATE__?.user?.userInfo;
	const user = unwrap(rawUser);
	const text = document.body?.innerText || "";
	const loginVisible = Boolean(document.querySelector(
		'.login-container, [class*="login-container"], [class*="login-modal"]'
	));
	const rateLimited = /操作太快|请求过于频繁|访问频繁|稍后再试/.test(text);
	const empty = /暂无搜索结果|没有找到相关笔记|未找到相关内容/.test(text);
	let state = "";
	if (window.location.pathname.startsWith("/website-login/captcha")) {
		state = "captcha";
	} else if (Array.isArray(feeds) && feeds.length > 0) {
		state = "ready";
	} else if (user?.guest === true || loginVisible) {
		state = "logged_out";
	} else if (rateLimited) {
		state = "rate_limited";
	} else if (empty) {
		state = "empty";
	}
	return JSON.stringify({
		state,
		path: window.location.pathname,
		readyState: document.readyState,
		hasInitialState: Boolean(window.__INITIAL_STATE__),
		hasSearchState: Boolean(window.__INITIAL_STATE__?.search),
		feedCount: Array.isArray(feeds) ? feeds.length : -1,
		feedKeys: feedsContainer && typeof feedsContainer === "object"
			? Object.keys(feedsContainer).slice(0, 12)
			: [],
		exploreLinks: document.querySelectorAll('a[href*="/explore/"]').length,
		rateLimited,
		empty,
		loginVisible,
	});
}`

// FilterOption 筛选选项结构体
type FilterOption struct {
	SortBy      string `json:"sort_by,omitempty" jsonschema:"排序依据: 综合|最新|最多点赞|最多评论|最多收藏,默认为'综合'"`
	NoteType    string `json:"note_type,omitempty" jsonschema:"笔记类型: 不限|视频|图文,默认为'不限'"`
	PublishTime string `json:"publish_time,omitempty" jsonschema:"发布时间: 不限|一天内|一周内|半年内,默认为'不限'"`
	SearchScope string `json:"search_scope,omitempty" jsonschema:"搜索范围: 不限|已看过|未看过|已关注,默认为'不限'"`
	Location    string `json:"location,omitempty" jsonschema:"位置距离: 不限|同城|附近,默认为'不限'"`
}

// filterGroup 面板上的一个筛选组：标签是什么、对应入参的哪个字段、允许哪些取值。
//
// 组和选项一律按文本定位，不用序号。面板里同一个选项可能渲染成多个 div.tags
// （数量随视口而变），首项是否重复各组也不一致，下标对不齐。
type filterGroup struct {
	label   string                    // 面板上这一组的标签文本
	pick    func(FilterOption) string // 从入参里取这一组的值
	allowed []string                  // 合法取值；在打开页面之前就能挡掉写错的值
}

var filterGroups = []filterGroup{
	{"排序依据", func(f FilterOption) string { return f.SortBy },
		[]string{"综合", "最新", "最多点赞", "最多评论", "最多收藏"}},
	{"笔记类型", func(f FilterOption) string { return f.NoteType },
		[]string{"不限", "视频", "图文"}},
	{"发布时间", func(f FilterOption) string { return f.PublishTime },
		[]string{"不限", "一天内", "一周内", "半年内"}},
	{"搜索范围", func(f FilterOption) string { return f.SearchScope },
		[]string{"不限", "已看过", "未看过", "已关注"}},
	{"位置距离", func(f FilterOption) string { return f.Location },
		[]string{"不限", "同城", "附近"}},
}

// pendingFilter 一个待应用的筛选项。
type pendingFilter struct {
	group  string // 组标签
	option string // 选项文本
}

// collectFilters 把入参展开成待应用的筛选项，顺便校验取值。
//
// 校验放在这里是为了在打开浏览器之前就挡掉写错的值——否则要等导航、悬停、
// 在面板里找不到之后才能报错，等于为了说一句"你写错了"先向平台发一次请求。
func collectFilters(filters []FilterOption) ([]pendingFilter, error) {
	var pending []pendingFilter

	for _, f := range filters {
		for _, g := range filterGroups {
			value := g.pick(f)
			if value == "" {
				continue
			}
			if !slices.Contains(g.allowed, value) {
				return nil, fmt.Errorf("%s 不支持 %q，可选：%s",
					g.label, value, strings.Join(g.allowed, "、"))
			}
			pending = append(pending, pendingFilter{group: g.label, option: value})
		}
	}

	return pending, nil
}

type SearchAction struct {
	page *rod.Page
}

func NewSearchAction(page *rod.Page) *SearchAction {
	return &SearchAction{page: page}
}

func readSearchPageSnapshot(page *rod.Page) (searchPageSnapshot, error) {
	var snapshot searchPageSnapshot
	evaluated, err := page.Timeout(searchStateEvalTimeout).Eval(searchPageSnapshotJS)
	if err != nil {
		return snapshot, err
	}
	if err := json.Unmarshal([]byte(evaluated.Value.String()), &snapshot); err != nil {
		return snapshot, fmt.Errorf("解析搜索页安全状态失败: %w", err)
	}
	return snapshot, nil
}

func logSearchPageSnapshot(stage string, snapshot searchPageSnapshot, evalFailed bool) {
	// 诊断只包含路径、布尔状态、键名和数量；不记录关键词、正文、URL 查询串、
	// Cookie 或 xsec_token。
	logrus.WithFields(logrus.Fields{
		"stage":           stage,
		"path":            snapshot.Path,
		"readyState":      snapshot.ReadyState,
		"hasInitialState": snapshot.HasInitialState,
		"hasSearchState":  snapshot.HasSearchState,
		"feedCount":       snapshot.FeedCount,
		"feedKeys":        snapshot.FeedKeys,
		"exploreLinks":    snapshot.ExploreLinks,
		"rateLimited":     snapshot.RateLimited,
		"empty":           snapshot.Empty,
		"loginVisible":    snapshot.LoginVisible,
		"evalFailed":      evalFailed,
	}).Info("搜索页安全诊断")
}

func waitForSearchPageState(
	ctx context.Context,
	evaluate func() (searchPageSnapshot, error),
	timeout time.Duration,
	interval time.Duration,
) (searchPageSnapshot, error) {
	startedAt := time.Now()
	deadline := startedAt.Add(timeout)
	nextDiagnostic := startedAt.Add(searchDiagnosticAfter)
	diagnosticLogged := false
	var last searchPageSnapshot
	var lastEvalErr error

	for {
		if err := ctx.Err(); err != nil {
			logSearchPageSnapshot("context_done", last, lastEvalErr != nil)
			return last, err
		}

		snapshot, err := evaluate()
		if err == nil {
			last = snapshot
			lastEvalErr = nil
			if snapshot.State != "" {
				return snapshot, nil
			}
		} else {
			// renderer 短暂繁忙或一次 CDP 读取超时不应立刻丢弃本次搜索；在总
			// 预算内继续轮询，最终仍通过结构化超时/不可用错误回收会话。
			lastEvalErr = err
		}

		now := time.Now()
		if !diagnosticLogged && !now.Before(nextDiagnostic) {
			logSearchPageSnapshot("waiting", last, lastEvalErr != nil)
			diagnosticLogged = true
		}
		if !now.Before(deadline) {
			logSearchPageSnapshot("final", last, lastEvalErr != nil)
			if lastEvalErr != nil {
				return last, fmt.Errorf("读取搜索页状态失败: %w", lastEvalErr)
			}
			return last, fmt.Errorf("等待搜索结果超时")
		}

		pause := interval
		if remaining := time.Until(deadline); pause > remaining {
			pause = remaining
		}
		timer := time.NewTimer(pause)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			logSearchPageSnapshot("context_done", last, lastEvalErr != nil)
			return last, ctx.Err()
		case <-timer.C:
		}
	}
}

func searchStateWaitBudget(ctx context.Context) time.Duration {
	budget := searchStateWaitTimeout
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline) - searchContextSafetyMargin
		if remaining < budget {
			budget = remaining
		}
	}
	if budget < 0 {
		return 0
	}
	return budget
}

func (s *SearchAction) Search(ctx context.Context, keyword string, filters ...FilterOption) ([]Feed, error) {
	// 先校验筛选取值，必须在导航之前——写错的值不该先向平台发一次请求再报错。
	pending, err := collectFilters(filters)
	if err != nil {
		return nil, err
	}

	searchCtx, cancel := context.WithTimeout(ctx, searchReadTimeout)
	defer cancel()
	page := s.page.Context(searchCtx)

	searchURL := makeSearchURL(keyword)
	if err := page.Timeout(8 * time.Second).Navigate(searchURL); err != nil {
		return nil, fmt.Errorf("打开搜索页失败: %w", err)
	}
	// 搜索页有持续的埋点和推荐请求，等待整个页面进入 network-idle 会把
	// 已经到达的搜索数据误判为超时。主动轮询只读安全状态，并在总 context
	// 失效前保留诊断时间，这样既能快速识别平台限制，也不会在超时后再访问
	// 已经不可用的 renderer。
	waitBudget := searchStateWaitBudget(searchCtx)
	if waitBudget <= 0 {
		return nil, context.DeadlineExceeded
	}
	snapshot, err := waitForSearchPageState(
		searchCtx,
		func() (searchPageSnapshot, error) { return readSearchPageSnapshot(page) },
		waitBudget,
		searchStatePollInterval,
	)
	if err != nil {
		return nil, err
	}
	switch snapshot.State {
	case "captcha":
		return nil, fmt.Errorf("小红书要求安全验证")
	case "logged_out":
		return nil, fmt.Errorf("小红书未登录")
	case "rate_limited":
		return nil, fmt.Errorf("小红书请求过于频繁，请稍后再试")
	case "empty":
		return nil, errors.ErrNoFeeds
	case "ready":
		// 继续读取结构化 feeds。
	default:
		return nil, fmt.Errorf("搜索页状态不可用")
	}

	if len(pending) > 0 {
		// 悬停在筛选按钮上展开面板
		filterButton := page.MustElement(`div.filter`)
		if err := humanize.Hover(filterButton); err != nil {
			return nil, fmt.Errorf("悬停筛选按钮失败: %w", err)
		}
		humanize.Delay(ctx, humanize.BeforeClick)

		// 等待筛选面板出现
		page.MustWait(`() => document.querySelector('div.filter-panel') !== null`)

		// 记下筛选前的结果，用来判断筛选后的数据什么时候到位
		before := readFeedIDs(page)

		// 用 ClickNoWait：筛选面板是 hover 浮层，rod 的 WaitInteractable 会误判被遮挡而死等；
		// ClickNoWait 移进面板内选项（维持 hover、面板不关）再点。
		for _, pf := range pending {
			option, err := findFilterOption(page, pf)
			if err != nil {
				return nil, err
			}
			humanize.Delay(ctx, humanize.BeforeClick)
			if err := humanize.ClickNoWait(option); err != nil {
				return nil, fmt.Errorf("点击筛选选项「%s」失败: %w", pf.option, err)
			}
		}

		waitFeedsChanged(searchCtx, page, before, 8*time.Second)
	}

	evaluated, err := page.Eval(`() => {
		if (window.__INITIAL_STATE__ &&
		    window.__INITIAL_STATE__.search &&
		    window.__INITIAL_STATE__.search.feeds) {
			const feeds = window.__INITIAL_STATE__.search.feeds;
			const feedsData = feeds.value !== undefined
				? feeds.value
				: (feeds._value !== undefined
					? feeds._value
					: (feeds._rawValue !== undefined ? feeds._rawValue : feeds));
			if (feedsData) {
				return JSON.stringify(feedsData);
			}
		}
		return "";
	}`)
	if err != nil {
		return nil, fmt.Errorf("读取搜索结果失败: %w", err)
	}
	result := evaluated.Value.String()

	if result == "" {
		return nil, errors.ErrNoFeeds
	}

	var feeds []Feed
	if err := json.Unmarshal([]byte(result), &feeds); err != nil {
		return nil, fmt.Errorf("failed to unmarshal feeds: %w", err)
	}

	return onlyNotes(feeds), nil
}

// feedIDsJS 读当前结果集的 id 列表，用来判断数据有没有换一批。
const feedIDsJS = `() => {
	const f = window.__INITIAL_STATE__?.search?.feeds;
	const v = f
		? (f.value !== undefined
			? f.value
			: (f._value !== undefined
				? f._value
				: (f._rawValue !== undefined ? f._rawValue : f)))
		: null;
	return v ? v.map(x => x.id).join(",") : "";
}`

func readFeedIDs(page *rod.Page) string {
	res, err := page.Eval(feedIDsJS)
	if err != nil {
		return ""
	}
	return res.Value.Str()
}

// waitFeedsChanged 等筛选后的数据到位。
//
// 点完筛选项之后不能立刻读结果：站点是先把 feeds 清空、再灌入新数据，
// 中间这段时间读到的要么是空，要么还是筛选前那一批。原先用
// MustWait(__INITIAL_STATE__ !== undefined) 等，而这个条件从首屏起就为真、
// 立即返回，等于没等——多个筛选项一起用时表现为只有一部分生效。
//
// 超时不报错：筛选已经点上了，宁可返回可能偏旧的数据，也不要整个搜索失败。
func waitFeedsChanged(ctx context.Context, page *rod.Page, before string, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return
		}
		if now := readFeedIDs(page); now != "" && now != before {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(300 * time.Millisecond):
		}
	}
	logrus.Warnf("筛选后等待结果刷新超时（%s），返回的可能是筛选前的数据", timeout)
}

// findFilterOption 在筛选面板里定位一个选项：按标签找到组，再在组内按文本找选项。
//
// 全程不用序号。同一个选项在面板里可能渲染成多个 div.tags（数量随视口而变，
// 且首项是否重复各组不一致），下标对不齐；早前用 div.tags:nth-child(N) 会选错项。
// 多份重复的位置尺寸完全相同，取第一个点下去落在同一处。
//
// 作用域必须限定在 div.filter-panel 内且只认 div.tags：页面别处存在同文本的
// 可见元素（顶部频道栏的「图文」「视频」、标签「综合」），放宽会点错地方。
func findFilterOption(page *rod.Page, pf pendingFilter) (*rod.Element, error) {
	groups, err := page.Elements("div.filter-panel div.filters")
	if err != nil {
		return nil, fmt.Errorf("读取筛选面板失败: %w", err)
	}

	for _, group := range groups {
		// 组标签是 div.filters 下的直接子 span
		label, err := group.Element(":scope > span")
		if err != nil {
			continue
		}
		text, err := label.Text()
		if err != nil || strings.TrimSpace(text) != pf.group {
			continue
		}

		options, err := group.Elements("div.tags")
		if err != nil {
			return nil, fmt.Errorf("读取「%s」的选项失败: %w", pf.group, err)
		}

		var available []string
		for _, opt := range options {
			t, err := opt.Text()
			if err != nil {
				continue
			}
			t = strings.TrimSpace(t)
			if t == pf.option {
				return opt, nil
			}
			available = append(available, t)
		}
		return nil, fmt.Errorf("「%s」里没有选项「%s」，页面上是：%s",
			pf.group, pf.option, strings.Join(available, "、"))
	}

	return nil, fmt.Errorf("筛选面板里没有「%s」这一组", pf.group)
}

func makeSearchURL(keyword string) string {

	values := url.Values{}
	values.Set("keyword", keyword)
	values.Set("source", "web_explore_feed")

	//https://www.xiaohongshu.com/search_result?keyword=%25E7%258E%258B%25E5%25AD%2590&source=web_search_result_notes
	//https://www.xiaohongshu.com/search_result?keyword=%25E7%258E%258B%25E5%25AD%2590&source=web_explore_feed
	return fmt.Sprintf("https://www.xiaohongshu.com/search_result?%s", values.Encode())
}
