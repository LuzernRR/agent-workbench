package xiaohongshu

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNormalizeFeedDetailSource(t *testing.T) {
	for input, expected := range map[string]string{
		"":          FeedDetailSourcePCFeed,
		"pc_feed":   FeedDetailSourcePCFeed,
		"pc_search": FeedDetailSourcePCSearch,
	} {
		actual, err := NormalizeFeedDetailSource(input)
		require.NoError(t, err)
		assert.Equal(t, expected, actual)
	}

	_, err := NormalizeFeedDetailSource("pc_note&redirect=https://example.com")
	assert.Error(t, err)
}

func TestMakeFeedDetailURLUsesExplicitAllowlistedSource(t *testing.T) {
	url := makeFeedDetailURLWithSource(
		"feed123",
		"token123",
		FeedDetailSourcePCSearch,
	)
	assert.Equal(
		t,
		"https://www.xiaohongshu.com/explore/feed123?xsec_token=token123&xsec_source=pc_search",
		url,
	)
}
