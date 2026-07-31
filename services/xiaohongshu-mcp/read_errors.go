package main

import (
	"context"
	"encoding/json"
	stderrors "errors"
	"net"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

type readFailure struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	Retryable  bool   `json:"retryable"`
	NextAction string `json:"nextAction"`
	HTTPStatus int    `json:"-"`
}

func classifyReadFailure(err error) readFailure {
	text := strings.ToLower(err.Error())

	if strings.Contains(text, "安全验证") ||
		strings.Contains(text, "captcha") ||
		strings.Contains(text, "verify") {
		return readFailure{
			Code:       "CAPTCHA_REQUIRED",
			Message:    "小红书当前要求安全验证",
			Retryable:  false,
			NextAction: "use_alternative_channel",
			HTTPStatus: http.StatusConflict,
		}
	}
	if strings.Contains(text, "未登录") ||
		strings.Contains(text, "not logged") ||
		strings.Contains(text, "unauthorized") ||
		strings.Contains(text, "forbidden") {
		return readFailure{
			Code:       "AUTH_REQUIRED",
			Message:    "小红书登录状态已失效，需要重新扫码",
			Retryable:  false,
			NextAction: "reconnect_account",
			HTTPStatus: http.StatusUnauthorized,
		}
	}
	if stderrors.Is(err, context.DeadlineExceeded) ||
		strings.Contains(text, "deadline exceeded") ||
		strings.Contains(text, "timeout") ||
		strings.Contains(text, "timed out") ||
		strings.Contains(text, "超时") {
		return readFailure{
			Code:       "MCP_TIMEOUT",
			Message:    "小红书只读请求超时",
			Retryable:  true,
			NextAction: "retry_later",
			HTTPStatus: http.StatusGatewayTimeout,
		}
	}
	if strings.Contains(text, "rate limit") ||
		strings.Contains(text, "too many requests") ||
		strings.Contains(text, "请求过于频繁") {
		return readFailure{
			Code:       "MCP_RATE_LIMITED",
			Message:    "小红书只读请求当前受限",
			Retryable:  true,
			NextAction: "retry_later",
			HTTPStatus: http.StatusTooManyRequests,
		}
	}
	var networkError net.Error
	if stderrors.As(err, &networkError) ||
		strings.Contains(text, "net.operror") ||
		strings.Contains(text, "connection reset") ||
		strings.Contains(text, "connection refused") ||
		strings.Contains(text, "network is unreachable") ||
		strings.Contains(text, "tls handshake") {
		return readFailure{
			Code:       "MCP_NETWORK_ERROR",
			Message:    "小红书只读网络暂不可用",
			Retryable:  true,
			NextAction: "retry_later",
			HTTPStatus: http.StatusServiceUnavailable,
		}
	}
	if strings.Contains(text, "unmarshal") ||
		strings.Contains(text, "没有捕获到") ||
		strings.Contains(text, "无法获取初始状态") ||
		strings.Contains(text, "not found in notedetailmap") ||
		strings.Contains(text, "没有可用正文") {
		return readFailure{
			Code:       "MCP_OUTPUT_INVALID",
			Message:    "小红书只读响应缺少有效内容",
			Retryable:  false,
			NextAction: "use_alternative_channel",
			HTTPStatus: http.StatusBadGateway,
		}
	}
	return readFailure{
		Code:       "MCP_UNAVAILABLE",
		Message:    "小红书只读服务当前不可用",
		Retryable:  true,
		NextAction: "retry_later",
		HTTPStatus: http.StatusServiceUnavailable,
	}
}

func respondReadError(c *gin.Context, err error) {
	failure := classifyReadFailure(err)
	c.JSON(failure.HTTPStatus, ErrorResponse{
		Error:      failure.Message,
		Code:       failure.Code,
		Retryable:  failure.Retryable,
		NextAction: failure.NextAction,
	})
}

func mcpReadErrorResult(err error) *MCPToolResult {
	failure := classifyReadFailure(err)
	payload, marshalErr := json.Marshal(failure)
	if marshalErr != nil {
		payload = []byte(`{"code":"MCP_UNAVAILABLE","message":"小红书只读服务当前不可用","retryable":true,"nextAction":"retry_later"}`)
	}
	return &MCPToolResult{
		Content: []MCPContent{{
			Type: "text",
			Text: string(payload),
		}},
		IsError: true,
	}
}
