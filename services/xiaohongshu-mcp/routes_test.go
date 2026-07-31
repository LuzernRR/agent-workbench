package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMCPStatelessSinglePost 固定「/mcp 接受不带 initialize 握手的单次 POST」这一契约。
//
// 契约由 routes.go 里一行 Stateless 支撑，丢掉它编译和其他单测都不会报错。
func TestMCPStatelessSinglePost(t *testing.T) {
	router := setupRoutes(NewAppServer(NewXiaohongshuService()))
	server := httptest.NewServer(router)
	defer server.Close()

	post := func(t *testing.T, body string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, server.URL+"/mcp", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")

		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		return resp
	}

	// 只用 tools/list：它不碰浏览器，而契约丢失时它恰好就是失败点——
	// 有状态模式下无 session 调用 tools/list 会被回以「握手前不允许调用」。
	resp := post(t, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var result struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Result struct {
			Tools []struct {
				Name        string `json:"name"`
				Annotations struct {
					ReadOnlyHint bool `json:"readOnlyHint"`
				} `json:"annotations"`
			} `json:"tools"`
		} `json:"result"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&result))

	require.Nil(t, result.Error, "无握手的 tools/list 不应报错")
	names := make([]string, 0, len(result.Result.Tools))
	for _, tool := range result.Result.Tools {
		names = append(names, tool.Name)
		assert.True(t, tool.Annotations.ReadOnlyHint, "所有已注册工具都必须声明只读")
	}
	assert.ElementsMatch(t, []string{
		"check_login_status",
		"get_login_qrcode",
		"search_feeds",
		"get_feed_detail",
		"user_profile",
	}, names)
}

func TestWriteAndUnneededRoutesAreNotRegistered(t *testing.T) {
	router := setupRoutes(NewAppServer(NewXiaohongshuService()))
	blocked := []struct {
		method string
		path   string
	}{
		{http.MethodDelete, "/api/v1/login/cookies"},
		{http.MethodPost, "/api/v1/publish"},
		{http.MethodPost, "/api/v1/publish_video"},
		{http.MethodGet, "/api/v1/feeds/list"},
		{http.MethodPost, "/api/v1/feeds/comment"},
		{http.MethodPost, "/api/v1/feeds/comment/reply"},
		{http.MethodPost, "/api/v1/feeds/like"},
		{http.MethodPost, "/api/v1/feeds/favorite"},
		{http.MethodGet, "/api/v1/user/me"},
	}

	for _, route := range blocked {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			request := httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()

			router.ServeHTTP(response, request)

			assert.Equal(t, http.StatusNotFound, response.Code)
		})
	}
}

func TestSourceDoesNotLogSignedNavigationURLs(t *testing.T) {
	files, err := filepath.Glob("xiaohongshu/*.go")
	require.NoError(t, err)
	require.NotEmpty(t, files)
	sensitiveLog := regexp.MustCompile(
		`(?i)logrus\.(?:info|debug|warn|error)f?\([^\n]*(?:xsec|\burl\b)`,
	)

	for _, file := range files {
		source, err := os.ReadFile(file)
		require.NoError(t, err)
		assert.NotRegexp(t, sensitiveLog, string(source), file)
	}
}

func TestRecoveryReturnsStable500WithoutSerializingOrLoggingSecrets(t *testing.T) {
	type sensitivePanic struct {
		Token   string
		Handler func()
	}
	const secret = "xsec_token=must-not-appear"
	var logs bytes.Buffer
	logger := logrus.StandardLogger()
	previousOutput := logger.Out
	logger.SetOutput(&logs)
	t.Cleanup(func() { logger.SetOutput(previousOutput) })

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(errorHandlingMiddleware())
	router.GET("/panic", func(_ *gin.Context) {
		panic(sensitivePanic{Token: secret, Handler: func() {}})
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/panic", nil))

	assert.Equal(t, http.StatusInternalServerError, response.Code)
	assert.JSONEq(t, `{
		"error": "服务器内部错误",
		"code": "INTERNAL_ERROR"
	}`, response.Body.String())
	assert.NotContains(t, response.Body.String(), secret)
	assert.NotContains(t, logs.String(), secret)
	assert.Contains(t, logs.String(), "type=main.sensitivePanic")
}

func TestFeedDetailRejectsUnknownXsecSourceBeforeBrowserAccess(t *testing.T) {
	router := setupRoutes(NewAppServer(NewXiaohongshuService()))
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/feeds/detail",
		strings.NewReader(`{
			"feed_id":"feed123",
			"xsec_token":"token123456",
			"xsec_source":"pc_note"
		}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	assert.Equal(t, http.StatusBadRequest, response.Code)
	assert.JSONEq(t, `{
		"error":"详情来源参数无效",
		"code":"INVALID_REQUEST"
	}`, response.Body.String())
}
