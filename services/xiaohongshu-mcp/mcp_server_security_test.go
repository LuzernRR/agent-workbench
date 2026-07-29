package main

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMCPPanicRecoveryDoesNotSerializeOrLogSecrets(t *testing.T) {
	const secret = "xsec_token=must-not-appear"
	var logs bytes.Buffer
	logger := logrus.StandardLogger()
	previousOutput := logger.Out
	logger.SetOutput(&logs)
	t.Cleanup(func() { logger.SetOutput(previousOutput) })

	handler := withPanicRecovery(
		"read_only_test",
		func(context.Context, *mcp.CallToolRequest, any) (*mcp.CallToolResult, any, error) {
			panic(errors.New(secret))
		},
	)
	result, response, err := handler(context.Background(), nil, nil)

	require.NoError(t, err)
	require.Nil(t, response)
	require.NotNil(t, result)
	assert.True(t, result.IsError)
	require.Len(t, result.Content, 1)
	text, ok := result.Content[0].(*mcp.TextContent)
	require.True(t, ok)
	assert.Equal(t, "工具 read_only_test 执行时发生内部错误，请稍后重试。", text.Text)
	assert.NotContains(t, text.Text, secret)
	assert.NotContains(t, logs.String(), secret)
	assert.Contains(t, logs.String(), "panic_type=")
	assert.Contains(t, logs.String(), "*errors.errorString")
}

func TestMCPPanicRecoveryPassesThroughSuccessfulReadResult(t *testing.T) {
	expectedResult := &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: "只读结果"}},
	}
	expectedResponse := map[string]any{"ok": true}
	handler := withPanicRecovery(
		"read_only_test",
		func(context.Context, *mcp.CallToolRequest, any) (*mcp.CallToolResult, any, error) {
			return expectedResult, expectedResponse, nil
		},
	)

	result, response, err := handler(context.Background(), nil, nil)

	require.NoError(t, err)
	assert.Same(t, expectedResult, result)
	assert.Equal(t, expectedResponse, response)
}
