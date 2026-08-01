package main

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestClassifyReadFailureUsesStableCodes(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		code       string
		retryable  bool
		nextAction string
	}{
		{
			name:       "timeout",
			err:        context.DeadlineExceeded,
			code:       "MCP_TIMEOUT",
			retryable:  true,
			nextAction: "retry_later",
		},
		{
			name:       "captcha",
			err:        errors.New("小红书要求安全验证"),
			code:       "CAPTCHA_REQUIRED",
			retryable:  false,
			nextAction: "use_alternative_channel",
		},
		{
			name:       "invalid output",
			err:        errors.New("没有捕获到 feed 详情数据"),
			code:       "MCP_OUTPUT_INVALID",
			retryable:  false,
			nextAction: "use_alternative_channel",
		},
		{
			name:       "inaccessible note",
			err:        errors.New("笔记不可访问"),
			code:       "MCP_OUTPUT_INVALID",
			retryable:  false,
			nextAction: "use_alternative_channel",
		},
		{
			name:       "rate limited",
			err:        errors.New("小红书请求过于频繁，请稍后再试"),
			code:       "MCP_RATE_LIMITED",
			retryable:  true,
			nextAction: "retry_later",
		},
		{
			name:       "unavailable",
			err:        errors.New("browser startup failed"),
			code:       "MCP_UNAVAILABLE",
			retryable:  true,
			nextAction: "retry_later",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			failure := classifyReadFailure(test.err)
			assert.Equal(t, test.code, failure.Code)
			assert.Equal(t, test.retryable, failure.Retryable)
			assert.Equal(t, test.nextAction, failure.NextAction)
			assert.NotEmpty(t, failure.Message)
			assert.NotZero(t, failure.HTTPStatus)
		})
	}
}

func TestRespondReadErrorNeverExposesRawFailure(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)

	respondReadError(context, errors.New(
		"net.OpError https://www.xiaohongshu.com/explore/abc?xsec_token=secret",
	))

	assert.Equal(t, 503, recorder.Code)
	assert.JSONEq(t, `{
		"error": "小红书只读网络暂不可用",
		"code": "MCP_NETWORK_ERROR",
		"retryable": true,
		"nextAction": "retry_later"
	}`, recorder.Body.String())
	assert.NotContains(t, recorder.Body.String(), "secret")
	assert.NotContains(t, recorder.Body.String(), "xsec_token")
}
