package xiaohongshu

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestCollectFilters(t *testing.T) {
	t.Run("只展开非空字段", func(t *testing.T) {
		pending, err := collectFilters([]FilterOption{{
			NoteType:    "图文",
			PublishTime: "一天内",
		}})
		require.NoError(t, err)
		require.Equal(t, []pendingFilter{
			{group: "笔记类型", option: "图文"},
			{group: "发布时间", option: "一天内"},
		}, pending)
	})

	t.Run("五个字段全给", func(t *testing.T) {
		pending, err := collectFilters([]FilterOption{{
			SortBy:      "最新",
			NoteType:    "视频",
			PublishTime: "一周内",
			SearchScope: "已关注",
			Location:    "同城",
		}})
		require.NoError(t, err)
		require.Len(t, pending, 5)
		require.Equal(t, pendingFilter{group: "排序依据", option: "最新"}, pending[0])
		require.Equal(t, pendingFilter{group: "位置距离", option: "同城"}, pending[4])
	})

	t.Run("全空则无待应用项", func(t *testing.T) {
		pending, err := collectFilters([]FilterOption{{}})
		require.NoError(t, err)
		require.Empty(t, pending)
	})

	t.Run("非法取值在打开页面之前就报错", func(t *testing.T) {
		_, err := collectFilters([]FilterOption{{NoteType: "不存在的类型"}})
		require.Error(t, err)
		// 错误里要带上可选值，调用方才知道该怎么改
		require.Contains(t, err.Error(), "笔记类型")
		require.Contains(t, err.Error(), "图文")
	})

	t.Run("取值不能跨组", func(t *testing.T) {
		// 「视频」是笔记类型的选项，不能当排序依据
		_, err := collectFilters([]FilterOption{{SortBy: "视频"}})
		require.Error(t, err)
		require.Contains(t, err.Error(), "排序依据")
	})
}

func TestWaitForSearchPageState(t *testing.T) {
	t.Run("轮询到结构化结果后立即返回", func(t *testing.T) {
		calls := 0
		snapshot, err := waitForSearchPageState(
			context.Background(),
			func() (searchPageSnapshot, error) {
				calls++
				if calls < 3 {
					return searchPageSnapshot{Path: "/search_result", FeedCount: 0}, nil
				}
				return searchPageSnapshot{
					State: "ready", Path: "/search_result", FeedCount: 20,
				}, nil
			},
			100*time.Millisecond,
			time.Millisecond,
		)
		require.NoError(t, err)
		require.Equal(t, "ready", snapshot.State)
		require.Equal(t, 20, snapshot.FeedCount)
		require.Equal(t, 3, calls)
	})

	t.Run("一次 renderer 读取失败不会提前终止", func(t *testing.T) {
		calls := 0
		snapshot, err := waitForSearchPageState(
			context.Background(),
			func() (searchPageSnapshot, error) {
				calls++
				if calls == 1 {
					return searchPageSnapshot{}, errors.New("temporary cdp timeout")
				}
				return searchPageSnapshot{State: "rate_limited", RateLimited: true}, nil
			},
			100*time.Millisecond,
			time.Millisecond,
		)
		require.NoError(t, err)
		require.Equal(t, "rate_limited", snapshot.State)
		require.Equal(t, 2, calls)
	})

	t.Run("预算结束时返回最后一次安全状态", func(t *testing.T) {
		snapshot, err := waitForSearchPageState(
			context.Background(),
			func() (searchPageSnapshot, error) {
				return searchPageSnapshot{
					Path: "/search_result", ExploreLinks: 7, FeedCount: -1,
				}, nil
			},
			8*time.Millisecond,
			2*time.Millisecond,
		)
		require.EqualError(t, err, "等待搜索结果超时")
		require.Equal(t, 7, snapshot.ExploreLinks)
	})
}

// TestFilterGroupsCoverFilterOption 组表必须覆盖 FilterOption 的每个字段，
// 否则以后新增字段会被静默忽略。
func TestFilterGroupsCoverFilterOption(t *testing.T) {
	all := FilterOption{
		SortBy:      "综合",
		NoteType:    "不限",
		PublishTime: "不限",
		SearchScope: "不限",
		Location:    "不限",
	}

	pending, err := collectFilters([]FilterOption{all})
	require.NoError(t, err)
	require.Len(t, pending, 5, "组表漏了 FilterOption 的字段")

	for _, g := range filterGroups {
		require.NotEmpty(t, g.label)
		require.NotEmpty(t, g.allowed, "%s 没有合法取值清单", g.label)
		require.NotNil(t, g.pick, "%s 没有取值函数", g.label)
	}
}
