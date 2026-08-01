package main

import (
	"net/http"

	"github.com/xpzouying/xiaohongshu-mcp/cookies"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

func respondLoginVerificationError(c *gin.Context, err error) {
	verificationError, ok := err.(*LoginVerificationError)
	if !ok {
		respondError(c, http.StatusInternalServerError, "VERIFICATION_FAILED", "小红书工具账号验证失败", nil)
		return
	}
	nextAction := "stop"
	if verificationError.Retryable {
		nextAction = "retry_later"
	}
	logrus.WithFields(logrus.Fields{
		"reasonCode": verificationError.Code,
		"status":     verificationError.HTTPStatus,
	}).Warn("小红书工具账号验证请求失败")
	c.JSON(verificationError.HTTPStatus, ErrorResponse{
		Error:      verificationError.Message,
		Code:       verificationError.Code,
		Retryable:  verificationError.Retryable,
		NextAction: nextAction,
	})
}

// respondError 返回错误响应
func respondError(c *gin.Context, statusCode int, code, message string, details any) {
	response := ErrorResponse{
		Error:   message,
		Code:    code,
		Details: details,
	}

	logrus.Errorf("%s %s %s %d", c.Request.Method, c.Request.URL.Path,
		c.GetString("account"), statusCode)

	c.JSON(statusCode, response)
}

// respondSuccess 返回成功响应
func respondSuccess(c *gin.Context, data any, message string) {
	response := SuccessResponse{
		Success: true,
		Data:    data,
		Message: message,
	}

	logrus.Infof("%s %s %s %d", c.Request.Method, c.Request.URL.Path,
		c.GetString("account"), http.StatusOK)

	c.JSON(http.StatusOK, response)
}

// checkLoginStatusHandler 检查登录状态
func (s *AppServer) checkLoginStatusHandler(c *gin.Context) {
	status, err := s.xiaohongshuService.CheckLoginStatus(c.Request.Context())
	if err != nil {
		respondReadError(c, err)
		return
	}

	c.Set("account", "ai-report")
	respondSuccess(c, status, "检查登录状态成功")
}

// getLoginQrcodeHandler 处理 [GET /api/v1/login/qrcode] 请求。
// 用于生成并返回登录二维码（Base64 图片 + 超时时间），供前端展示给用户扫码登录。
func (s *AppServer) getLoginQrcodeHandler(c *gin.Context) {
	result, err := s.xiaohongshuService.GetLoginQrcode(c.Request.Context())
	if err != nil {
		respondReadError(c, err)
		return
	}

	respondSuccess(c, result, "获取登录二维码成功")
}

func (s *AppServer) startLoginVerificationHandler(c *gin.Context) {
	var request StartLoginVerificationRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		respondError(c, http.StatusBadRequest, "INVALID_REQUEST", "验证请求参数无效", nil)
		return
	}
	result, err := s.xiaohongshuService.StartLoginVerification(
		c.Request.Context(),
		request.RequestKey,
	)
	if err != nil {
		respondLoginVerificationError(c, err)
		return
	}
	respondSuccess(c, result, "小红书工具账号验证会话已创建")
}

func (s *AppServer) loginVerificationStatusHandler(c *gin.Context) {
	result, err := s.xiaohongshuService.LoginVerificationStatus(
		c.Param("challenge_id"),
	)
	if err != nil {
		respondLoginVerificationError(c, err)
		return
	}
	respondSuccess(c, result, "小红书工具账号验证状态已更新")
}

func (s *AppServer) loginVerificationQRCodeHandler(c *gin.Context) {
	image, err := s.xiaohongshuService.LoginVerificationQRCode(
		c.Param("challenge_id"),
	)
	if err != nil {
		respondLoginVerificationError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Disposition", "inline")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, "image/png", image)
}

func (s *AppServer) cancelLoginVerificationHandler(c *gin.Context) {
	if err := s.xiaohongshuService.CancelLoginVerification(
		c.Param("challenge_id"),
	); err != nil {
		respondLoginVerificationError(c, err)
		return
	}
	respondSuccess(c, map[string]string{"status": "cancelled"}, "已取消小红书工具账号验证")
}

// deleteCookiesHandler 删除 cookies，重置登录状态
func (s *AppServer) deleteCookiesHandler(c *gin.Context) {
	err := s.xiaohongshuService.DeleteCookies(c.Request.Context())
	if err != nil {
		respondError(c, http.StatusInternalServerError, "DELETE_COOKIES_FAILED",
			"删除 cookies 失败", err.Error())
		return
	}

	cookiePath := cookies.GetCookiesFilePath()
	respondSuccess(c, map[string]interface{}{
		"cookie_path": cookiePath,
		"message":     "Cookies 已成功删除，登录状态已重置。下次操作时需要重新登录。",
	}, "删除 cookies 成功")
}

// publishHandler 发布内容
func (s *AppServer) publishHandler(c *gin.Context) {
	var req PublishRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
			"请求参数错误", err.Error())
		return
	}

	result, err := s.xiaohongshuService.PublishContent(c.Request.Context(), &req)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "PUBLISH_FAILED",
			"发布失败", err.Error())
		return
	}

	respondSuccess(c, result, "发布成功")
}

// publishVideoHandler 发布视频内容
func (s *AppServer) publishVideoHandler(c *gin.Context) {
	var req PublishVideoRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
			"请求参数错误", err.Error())
		return
	}

	result, err := s.xiaohongshuService.PublishVideo(c.Request.Context(), &req)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "PUBLISH_VIDEO_FAILED",
			"视频发布失败", err.Error())
		return
	}

	respondSuccess(c, result, "视频发布成功")
}

// listFeedsHandler 获取Feeds列表
func (s *AppServer) listFeedsHandler(c *gin.Context) {
	result, err := s.xiaohongshuService.ListFeeds(c.Request.Context())
	if err != nil {
		respondError(c, http.StatusInternalServerError, "LIST_FEEDS_FAILED",
			"获取Feeds列表失败", err.Error())
		return
	}

	c.Set("account", "ai-report")
	respondSuccess(c, result, "获取Feeds列表成功")
}

// searchFeedsHandler 搜索Feeds
func (s *AppServer) searchFeedsHandler(c *gin.Context) {
	var keyword string
	var filters xiaohongshu.FilterOption
	var verificationRequestKey string

	switch c.Request.Method {
	case http.MethodPost:
		// 对于POST请求，从JSON中获取keyword
		var searchReq SearchFeedsRequest
		if err := c.ShouldBindJSON(&searchReq); err != nil {
			respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
				"请求参数错误", err.Error())
			return
		}
		keyword = searchReq.Keyword
		filters = searchReq.Filters
		verificationRequestKey = searchReq.VerificationRequestKey
	default:
		keyword = c.Query("keyword")
	}

	if keyword == "" {
		respondError(c, http.StatusBadRequest, "MISSING_KEYWORD",
			"缺少关键词参数", "keyword parameter is required")
		return
	}
	if verificationRequestKey != "" &&
		!verificationRequestKeyPattern.MatchString(verificationRequestKey) {
		respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
			"安全验证请求标识无效", nil)
		return
	}

	result, err := s.xiaohongshuService.SearchFeedsWithVerification(
		c.Request.Context(),
		keyword,
		verificationRequestKey,
		filters,
	)
	if err != nil {
		respondReadError(c, err)
		return
	}

	c.Set("account", "ai-report")
	respondSuccess(c, result, "搜索Feeds成功")
}

// getFeedDetailHandler 获取Feed详情
func (s *AppServer) getFeedDetailHandler(c *gin.Context) {
	var req FeedDetailRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
			"请求参数错误", err.Error())
		return
	}

	var result *FeedDetailResponse
	var err error
	xsecSource, sourceErr := xiaohongshu.NormalizeFeedDetailSource(req.XsecSource)
	if sourceErr != nil {
		respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
			"详情来源参数无效", nil)
		return
	}

	if req.CommentConfig != nil {
		config := xiaohongshu.CommentLoadConfig{
			ClickMoreReplies:    req.CommentConfig.ClickMoreReplies,
			MaxRepliesThreshold: req.CommentConfig.MaxRepliesThreshold,
			MaxCommentItems:     req.CommentConfig.MaxCommentItems,
			ScrollSpeed:         req.CommentConfig.ScrollSpeed,
		}
		result, err = s.xiaohongshuService.GetFeedDetailWithConfigAndSource(
			c.Request.Context(),
			req.FeedID,
			req.XsecToken,
			req.LoadAllComments,
			config,
			xsecSource,
		)
	} else {
		result, err = s.xiaohongshuService.GetFeedDetailWithSource(
			c.Request.Context(),
			req.FeedID,
			req.XsecToken,
			req.LoadAllComments,
			xsecSource,
		)
	}

	if err != nil {
		respondReadError(c, err)
		return
	}

	c.Set("account", "ai-report")
	respondSuccess(c, result, "获取Feed详情成功")
}

// userProfileHandler 用户主页
func (s *AppServer) userProfileHandler(c *gin.Context) {
	var req UserProfileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
			"请求参数错误", err.Error())
		return
	}

	result, err := s.xiaohongshuService.UserProfile(c.Request.Context(), req.UserID, req.XsecToken)
	if err != nil {
		respondReadError(c, err)
		return
	}

	c.Set("account", "ai-report")
	respondSuccess(c, map[string]any{"data": result}, "result.Message")
}

// postCommentHandler 发表评论到Feed
func (s *AppServer) postCommentHandler(c *gin.Context) {
	var req PostCommentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
			"请求参数错误", err.Error())
		return
	}

	// 发表评论
	result, err := s.xiaohongshuService.PostCommentToFeed(c.Request.Context(), req.FeedID, req.XsecToken, req.Content)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "POST_COMMENT_FAILED",
			"发表评论失败", err.Error())
		return
	}

	c.Set("account", "ai-report")
	respondSuccess(c, result, result.Message)
}

// replyCommentHandler 回复指定评论
func (s *AppServer) replyCommentHandler(c *gin.Context) {
	var req ReplyCommentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
			"请求参数错误", err.Error())
		return
	}

	result, err := s.xiaohongshuService.ReplyCommentToFeed(c.Request.Context(), req.FeedID, req.XsecToken, req.CommentID, req.UserID, req.Content)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "REPLY_COMMENT_FAILED",
			"回复评论失败", err.Error())
		return
	}

	c.Set("account", "ai-report")
	respondSuccess(c, result, result.Message)
}

// likeFeedHandler 点赞/取消点赞
func (s *AppServer) likeFeedHandler(c *gin.Context) {
	var req LikeFeedRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
			"请求参数错误", err.Error())
		return
	}

	var result *ActionResult
	var err error
	if req.Unlike {
		result, err = s.xiaohongshuService.UnlikeFeed(c.Request.Context(), req.FeedID, req.XsecToken)
	} else {
		result, err = s.xiaohongshuService.LikeFeed(c.Request.Context(), req.FeedID, req.XsecToken)
	}
	if err != nil {
		respondError(c, http.StatusInternalServerError, "LIKE_FEED_FAILED",
			"点赞操作失败", err.Error())
		return
	}

	c.Set("account", "ai-report")
	respondSuccess(c, result, result.Message)
}

// favoriteFeedHandler 收藏/取消收藏
func (s *AppServer) favoriteFeedHandler(c *gin.Context) {
	var req FavoriteFeedRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
			"请求参数错误", err.Error())
		return
	}

	var result *ActionResult
	var err error
	if req.Unfavorite {
		result, err = s.xiaohongshuService.UnfavoriteFeed(c.Request.Context(), req.FeedID, req.XsecToken)
	} else {
		result, err = s.xiaohongshuService.FavoriteFeed(c.Request.Context(), req.FeedID, req.XsecToken)
	}
	if err != nil {
		respondError(c, http.StatusInternalServerError, "FAVORITE_FEED_FAILED",
			"收藏操作失败", err.Error())
		return
	}

	c.Set("account", "ai-report")
	respondSuccess(c, result, result.Message)
}

// healthHandler 健康检查
func healthHandler(c *gin.Context) {
	respondSuccess(c, map[string]any{
		"status":    "healthy",
		"service":   "xiaohongshu-mcp",
		"version":   version,
		"account":   "ai-report",
		"timestamp": "now",
	}, "服务正常")
}

// myProfileHandler 我的信息
func (s *AppServer) myProfileHandler(c *gin.Context) {
	// 获取当前登录用户信息
	result, err := s.xiaohongshuService.GetMyProfile(c.Request.Context())
	if err != nil {
		respondError(c, http.StatusInternalServerError, "GET_MY_PROFILE_FAILED",
			"获取我的主页失败", err.Error())
		return
	}

	c.Set("account", "ai-report")
	respondSuccess(c, map[string]any{"data": result}, "获取我的主页成功")
}
