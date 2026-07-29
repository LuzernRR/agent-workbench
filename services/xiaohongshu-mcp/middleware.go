package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// corsMiddleware CORS 中间件
func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		c.Next()
	}
}

// errorHandlingMiddleware 错误处理中间件
func errorHandlingMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if recovered := recover(); recovered != nil {
				// recovered 可能包含 Rod 页面 URL、访问令牌，或根本无法 JSON
				// 序列化的 Go 值。禁止使用 Gin 默认 Recovery；它会把完整
				// 请求头写入日志。这里仅记录类型和路由。
				logrus.Errorf(
					"服务器内部错误: type=%T, path=%s",
					recovered,
					c.Request.URL.Path,
				)
				c.Abort()
				respondError(c, http.StatusInternalServerError, "INTERNAL_ERROR",
					"服务器内部错误", nil)
			}
		}()
		c.Next()
	}
}
