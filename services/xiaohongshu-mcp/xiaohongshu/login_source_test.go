package xiaohongshu

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCurrentUserFallsBackToProfileLink(t *testing.T) {
	source, err := os.ReadFile("login.go")
	require.NoError(t, err)

	text := string(source)
	assert.Contains(t, text, `a[href*="/user/profile/"]`)
	assert.Contains(t, text, `href.match(/\/user\/profile\/([^/?#]+)/)`)
}
