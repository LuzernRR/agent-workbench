package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/go-rod/rod"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/headless_browser"
	"github.com/xpzouying/xiaohongshu-mcp/browser"
	"github.com/xpzouying/xiaohongshu-mcp/configs"
	"github.com/xpzouying/xiaohongshu-mcp/cookies"
	"github.com/xpzouying/xiaohongshu-mcp/pkg/downloader"
	"github.com/xpzouying/xiaohongshu-mcp/pkg/xhsutil"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

// XiaohongshuService 小红书业务服务
type XiaohongshuService struct {
	logins        loginSessions
	verifications loginVerificationSessions

	stagedVerificationMu sync.Mutex
	stagedVerification   *stagedVerificationSession

	// 登录态读取由互斥锁串行执行，避免同一 Cookie 会话并发争用。搜索和主页
	// 读取可在小上限内复用浏览器；详情正文使用隔离浏览器会话，避免搜索页或
	// 上一篇详情的 renderer 卡顿传递到下一篇。每次操作仍创建独立页面。
	readMu          sync.Mutex
	readBrowser     *headless_browser.Browser
	readPage        *rod.Page
	readOperations  int
	readCookieStamp cookieStamp
	readCleanup     <-chan struct{}

	// 以下依赖只为生命周期回归测试提供可替换边界；生产构造器始终注入真实
	// 浏览器、页面、Cookie 标记和同步关闭实现。
	newReadBrowser   func() (*headless_browser.Browser, error)
	newReadPage      func(*headless_browser.Browser) (*rod.Page, error)
	readPageHealthy  func(*rod.Page) bool
	readCookie       func() cookieStamp
	closeReadSession func(*rod.Page, *headless_browser.Browser)

	closeVerificationPage   func(*rod.Page, *headless_browser.Browser)
	resolveVerificationUser func(context.Context) (*LoginStatusResponse, error)
	fetchVerificationQRCode func(context.Context, *rod.Page) (string, bool, error)
	waitVerificationLogin   func(context.Context, *rod.Page) bool
	readVerificationUser    func(context.Context, *rod.Page) (*xiaohongshu.CurrentUser, error)
	saveVerificationCookies func(*rod.Page) error
	verificationTimeout     time.Duration
	verificationStageTTL    time.Duration
}

// 非详情只读操作最多复用四次，随后整体轮换，页面和 renderer 数量始终受控。
const maxReadOperationsPerSession = 4
const readCleanupWait = 2500 * time.Millisecond
const readPageHealthTimeout = 600 * time.Millisecond
const defaultVerificationStageTTL = 45 * time.Second

type stagedVerificationSession struct {
	requestKey string
	page       *rod.Page
	browser    *headless_browser.Browser
	timer      *time.Timer
}

type cookieStamp struct {
	modTime time.Time
	size    int64
	exists  bool
}

// NewXiaohongshuService 创建小红书服务实例
func NewXiaohongshuService() *XiaohongshuService {
	return &XiaohongshuService{
		newReadBrowser:          safeNewBrowser,
		newReadPage:             safeNewPage,
		readPageHealthy:         safeReadPageHealthy,
		readCookie:              currentCookieStamp,
		closeReadSession:        safeCloseReadSession,
		closeVerificationPage:   safeCloseReadSession,
		fetchVerificationQRCode: safeFetchVerificationQRCode,
		waitVerificationLogin:   waitForVerificationLogin,
		readVerificationUser:    readVerificationCurrentUser,
		saveVerificationCookies: saveCookies,
		verificationTimeout:     4 * time.Minute,
		verificationStageTTL:    defaultVerificationStageTTL,
	}
}

// Close 关闭可复用的只读页面、待验证页面和正在等待扫码的验证会话。
func (s *XiaohongshuService) Close() {
	s.verifications.close()
	s.closeStagedVerificationSession()
	s.readMu.Lock()
	_ = s.waitForReadCleanupLocked(context.Background())
	s.resetReadSessionLocked()
	s.readMu.Unlock()
}

func (s *XiaohongshuService) closeVerificationSession(
	session *stagedVerificationSession,
) {
	if session == nil {
		return
	}
	if session.timer != nil {
		session.timer.Stop()
	}
	closer := s.closeVerificationPage
	if closer == nil {
		closer = s.closeReadSession
	}
	if closer == nil {
		closer = safeCloseReadSession
	}
	closer(session.page, session.browser)
}

func (s *XiaohongshuService) expireStagedVerificationSession(
	session *stagedVerificationSession,
) {
	s.stagedVerificationMu.Lock()
	if s.stagedVerification != session {
		s.stagedVerificationMu.Unlock()
		return
	}
	s.stagedVerification = nil
	s.stagedVerificationMu.Unlock()
	s.closeVerificationSession(session)
}

func (s *XiaohongshuService) stageVerificationSession(
	requestKey string,
	page *rod.Page,
	browserInstance *headless_browser.Browser,
) {
	ttl := s.verificationStageTTL
	if ttl <= 0 {
		ttl = defaultVerificationStageTTL
	}
	session := &stagedVerificationSession{
		requestKey: requestKey,
		page:       page,
		browser:    browserInstance,
	}
	session.timer = time.AfterFunc(ttl, func() {
		s.expireStagedVerificationSession(session)
	})

	s.stagedVerificationMu.Lock()
	previous := s.stagedVerification
	s.stagedVerification = session
	s.stagedVerificationMu.Unlock()
	if previous != nil {
		s.closeVerificationSession(previous)
	}
}

func (s *XiaohongshuService) takeStagedVerificationSession(
	requestKey string,
) (*stagedVerificationSession, bool) {
	s.stagedVerificationMu.Lock()
	session := s.stagedVerification
	if session == nil || session.requestKey != requestKey {
		s.stagedVerificationMu.Unlock()
		return nil, false
	}
	s.stagedVerification = nil
	s.stagedVerificationMu.Unlock()
	if session.timer != nil {
		session.timer.Stop()
		session.timer = nil
	}
	return session, true
}

func (s *XiaohongshuService) closeStagedVerificationSession() {
	s.stagedVerificationMu.Lock()
	session := s.stagedVerification
	s.stagedVerification = nil
	s.stagedVerificationMu.Unlock()
	s.closeVerificationSession(session)
}

func currentCookieStamp() cookieStamp {
	info, err := os.Stat(cookies.GetCookiesFilePath())
	if err != nil {
		return cookieStamp{}
	}
	return cookieStamp{
		modTime: info.ModTime(),
		size:    info.Size(),
		exists:  true,
	}
}

func sameCookieStamp(left, right cookieStamp) bool {
	return left.exists == right.exists &&
		left.size == right.size &&
		left.modTime.Equal(right.modTime)
}

func safeCloseBrowser(b *headless_browser.Browser) {
	if b == nil {
		return
	}
	defer func() {
		if recover() != nil {
			logrus.Warn("只读浏览器关闭时发生异常，资源将由容器回收")
		}
	}()
	b.Close()
}

func safeNewBrowser() (browserInstance *headless_browser.Browser, err error) {
	defer func() {
		if recover() != nil {
			browserInstance = nil
			err = fmt.Errorf("browser startup failed")
		}
	}()
	return newBrowser(), nil
}

func safeNewPage(b *headless_browser.Browser) (page *rod.Page, err error) {
	defer func() {
		if recover() != nil {
			page = nil
			err = fmt.Errorf("browser page creation failed")
		}
	}()
	return b.NewPage(), nil
}

func safeReadPageHealthy(page *rod.Page) (healthy bool) {
	if page == nil {
		return false
	}
	defer func() {
		if recover() != nil {
			healthy = false
		}
	}()
	evaluated, err := page.Timeout(readPageHealthTimeout).Eval(`() => true`)
	return err == nil && evaluated.Value.Bool()
}

func safeCloseReadSession(page *rod.Page, b *headless_browser.Browser) {
	// Browser.Close 会回收该进程下的全部页面；生产会话同时持有 browser 时
	// 不再单独关闭最后一页，避免 page.Close 与新 renderer 启动竞态。
	if b == nil && page != nil {
		pageClosed := make(chan struct{})
		go func() {
			defer close(pageClosed)
			defer func() {
				if recover() != nil {
					logrus.Warn("只读浏览器页面关闭时发生异常")
				}
			}()
			if err := page.Close(); err != nil {
				logrus.Warn("只读浏览器页面关闭失败，继续回收浏览器进程")
			}
		}()
		select {
		case <-pageClosed:
		case <-time.After(500 * time.Millisecond):
			logrus.Warn("只读浏览器页面关闭超时，继续回收浏览器进程")
		}
	}
	if b == nil {
		return
	}
	browserClosed := make(chan struct{})
	go func() {
		defer close(browserClosed)
		safeCloseBrowser(b)
	}()
	select {
	case <-browserClosed:
	case <-time.After(1500 * time.Millisecond):
		logrus.Warn("只读浏览器进程回收超时，资源将由容器 init 回收")
	}
}

func (s *XiaohongshuService) detachReadSessionLocked() (
	*rod.Page,
	*headless_browser.Browser,
) {
	page := s.readPage
	b := s.readBrowser
	s.readPage = nil
	s.readBrowser = nil
	s.readOperations = 0
	s.readCookieStamp = cookieStamp{}
	return page, b
}

func (s *XiaohongshuService) resetReadSessionLocked() {
	page, b := s.detachReadSessionLocked()
	if page == nil && b == nil {
		return
	}
	if s.closeReadSession != nil {
		s.closeReadSession(page, b)
	} else {
		safeCloseReadSession(page, b)
	}
}

func (s *XiaohongshuService) discardReadSessionLocked() {
	page, b := s.detachReadSessionLocked()
	if page == nil && b == nil {
		return
	}
	closer := s.closeReadSession
	if closer == nil {
		closer = safeCloseReadSession
	}
	done := make(chan struct{})
	s.readCleanup = done
	go func() {
		defer close(done)
		closer(page, b)
	}()
}

func (s *XiaohongshuService) waitForReadCleanupLocked(ctx context.Context) error {
	done := s.readCleanup
	if done == nil {
		return nil
	}
	select {
	case <-done:
		s.readCleanup = nil
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(readCleanupWait):
		logrus.Warn("等待旧只读浏览器回收超时，将启动隔离的新会话")
		s.readCleanup = nil
		return nil
	}
}

func (s *XiaohongshuService) resetReadBrowser() {
	s.readMu.Lock()
	defer s.readMu.Unlock()
	_ = s.waitForReadCleanupLocked(context.Background())
	s.resetReadSessionLocked()
}

func (s *XiaohongshuService) ensureReadPageLocked() (*rod.Page, error) {
	stampReader := s.readCookie
	if stampReader == nil {
		stampReader = currentCookieStamp
	}
	stamp := stampReader()
	if s.readBrowser != nil && !sameCookieStamp(stamp, s.readCookieStamp) {
		logrus.Info("登录会话已更新，重建只读浏览器")
		s.resetReadSessionLocked()
	}
	if s.readPage != nil {
		healthCheck := s.readPageHealthy
		if healthCheck == nil {
			healthCheck = safeReadPageHealthy
		}
		if !healthCheck(s.readPage) {
			// Chromium 的 renderer 可能在两次只读请求之间退出。先用本地 CDP
			// Eval 验活，不向平台发请求；失效时在真正导航前干净重建，避免把
			// 瞬时 page-closed 错误暴露成搜索网络故障。
			logrus.Info("只读浏览器页面健康检查失败，导航前重建会话")
			s.resetReadSessionLocked()
		}
	}
	if s.readBrowser == nil {
		browserFactory := s.newReadBrowser
		if browserFactory == nil {
			browserFactory = safeNewBrowser
		}
		b, err := browserFactory()
		if err != nil {
			return nil, err
		}
		s.readBrowser = b
		s.readCookieStamp = stamp
	}
	pageFactory := s.newReadPage
	if pageFactory == nil {
		pageFactory = safeNewPage
	}
	page, err := pageFactory(s.readBrowser)
	if err != nil {
		s.discardReadSessionLocked()
		return nil, err
	}
	// 旧页面保留到本浏览器整体轮换；这里只把健康检查锚点更新为新页面。
	s.readPage = page
	return page, nil
}

func (s *XiaohongshuService) withReadPage(
	ctx context.Context,
	operation func(*rod.Page) error,
) error {
	return s.withReadPageMode(ctx, false, "", operation)
}

func (s *XiaohongshuService) withFreshReadPage(
	ctx context.Context,
	operation func(*rod.Page) error,
) error {
	return s.withReadPageMode(ctx, true, "", operation)
}

func (s *XiaohongshuService) withFreshReadPageForVerification(
	ctx context.Context,
	requestKey string,
	operation func(*rod.Page) error,
) error {
	if !verificationRequestKeyPattern.MatchString(requestKey) {
		return fmt.Errorf("invalid verification request key")
	}
	return s.withReadPageMode(ctx, true, requestKey, operation)
}

func (s *XiaohongshuService) withReadPageMode(
	ctx context.Context,
	forceFreshSession bool,
	verificationRequestKey string,
	operation func(*rod.Page) error,
) (err error) {
	s.readMu.Lock()
	defer s.readMu.Unlock()

	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.waitForReadCleanupLocked(ctx); err != nil {
		return err
	}
	if forceFreshSession && (s.readPage != nil || s.readBrowser != nil) {
		logrus.Info("详情正文读取前轮换隔离浏览器会话")
		s.resetReadSessionLocked()
	}
	page, err := s.ensureReadPageLocked()
	if err != nil {
		return err
	}
	defer func() {
		if recover() != nil {
			err = fmt.Errorf("browser operation failed")
			s.discardReadSessionLocked()
		}
	}()

	operationNumber := s.readOperations + 1
	err = operation(page)
	if err != nil {
		failure := classifyReadFailure(err)
		if failure.Code == "CAPTCHA_REQUIRED" &&
			verificationRequestKeyPattern.MatchString(verificationRequestKey) &&
			s.readPage != nil && s.readBrowser != nil {
			verificationPage, verificationBrowser := s.detachReadSessionLocked()
			s.stageVerificationSession(
				verificationRequestKey,
				verificationPage,
				verificationBrowser,
			)
			logrus.WithFields(logrus.Fields{
				"reasonCode": failure.Code,
				"operation":  operationNumber,
			}).Warn("小红书要求安全验证，保留当前工具会话等待扫码")
			return err
		}
		logrus.WithFields(logrus.Fields{
			"errorType":  fmt.Sprintf("%T", err),
			"reasonCode": failure.Code,
			"operation":  operationNumber,
		}).Warn("只读浏览器操作失败，丢弃当前会话")
		s.discardReadSessionLocked()
		return err
	}
	s.readOperations++
	if s.readOperations >= maxReadOperationsPerSession {
		s.resetReadSessionLocked()
	}
	return nil
}

// PublishRequest 发布请求
type PublishRequest struct {
	Title      string   `json:"title" binding:"required"`
	Content    string   `json:"content" binding:"required"`
	Images     []string `json:"images" binding:"required,min=1"`
	Tags       []string `json:"tags,omitempty"`
	ScheduleAt string   `json:"schedule_at,omitempty"` // 定时发布时间，ISO8601格式，为空则立即发布
	IsOriginal bool     `json:"is_original,omitempty"` // 是否声明原创
	Visibility string   `json:"visibility,omitempty"`  // 可见范围: "公开可见"(默认), "仅自己可见", "仅互关好友可见"
	Products   []string `json:"products,omitempty"`    // 商品关键词列表，用于绑定带货商品
}

// LoginStatusResponse 登录状态响应
type LoginStatusResponse struct {
	IsLoggedIn bool   `json:"is_logged_in"`
	Username   string `json:"username,omitempty"` // 当前登录账号的昵称
	UserID     string `json:"user_id,omitempty"`  // 用户唯一标识（个人主页 URL 中的 ID）
}

// LoginQrcodeResponse 登录扫码二维码
type LoginQrcodeResponse struct {
	Timeout    string `json:"timeout"`
	IsLoggedIn bool   `json:"is_logged_in"`
	Img        string `json:"img,omitempty"`
}

// PublishResponse 发布响应
type PublishResponse struct {
	Title   string `json:"title"`
	Content string `json:"content"`
	Images  int    `json:"images"`
	Status  string `json:"status"`
	PostID  string `json:"post_id,omitempty"`
}

// PublishVideoRequest 发布视频请求（仅支持本地单个视频文件）
type PublishVideoRequest struct {
	Title      string   `json:"title" binding:"required"`
	Content    string   `json:"content" binding:"required"`
	Video      string   `json:"video" binding:"required"`
	Tags       []string `json:"tags,omitempty"`
	ScheduleAt string   `json:"schedule_at,omitempty"` // 定时发布时间，ISO8601格式，为空则立即发布
	Visibility string   `json:"visibility,omitempty"`  // 可见范围: "公开可见"(默认), "仅自己可见", "仅互关好友可见"
	Products   []string `json:"products,omitempty"`    // 商品关键词列表，用于绑定带货商品
}

// PublishVideoResponse 发布视频响应
type PublishVideoResponse struct {
	Title   string `json:"title"`
	Content string `json:"content"`
	Video   string `json:"video"`
	Status  string `json:"status"`
	PostID  string `json:"post_id,omitempty"`
}

// FeedsListResponse Feeds列表响应
type FeedsListResponse struct {
	Feeds []xiaohongshu.Feed `json:"feeds"`
	Count int                `json:"count"`
}

// UserProfileResponse 用户主页响应
type UserProfileResponse struct {
	UserBasicInfo xiaohongshu.UserBasicInfo      `json:"userBasicInfo"`
	Interactions  []xiaohongshu.UserInteractions `json:"interactions"`
	Feeds         []xiaohongshu.Feed             `json:"feeds"`
}

// DeleteCookies 删除 cookies 文件，用于登录重置
func (s *XiaohongshuService) DeleteCookies(ctx context.Context) error {
	cookiePath := cookies.GetCookiesFilePath()
	cookieLoader := cookies.NewLoadCookie(cookiePath)
	if err := cookieLoader.DeleteCookies(); err != nil {
		return err
	}
	s.resetReadBrowser()
	return nil
}

// CheckLoginStatus 检查登录状态
func (s *XiaohongshuService) CheckLoginStatus(ctx context.Context) (*LoginStatusResponse, error) {
	var isLoggedIn bool
	var currentUser *xiaohongshu.CurrentUser
	err := s.withReadPage(ctx, func(page *rod.Page) error {
		loginAction := xiaohongshu.NewLogin(page)
		loggedIn, err := loginAction.CheckLoginStatus(ctx)
		if err != nil {
			return err
		}
		isLoggedIn = loggedIn
		if loggedIn {
			user, userErr := loginAction.CurrentUser(ctx)
			if userErr != nil {
				logrus.Warn("已登录，但当前用户公开信息暂不可读")
			} else {
				currentUser = user
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	response := &LoginStatusResponse{
		IsLoggedIn: isLoggedIn,
	}

	// 已登录时从当前页读取真实账号信息；读不到只记 warn，不影响状态返回。
	if currentUser != nil {
		response.Username = currentUser.Nickname
		response.UserID = currentUser.UserID
	}

	return response, nil
}

// GetLoginQrcode 获取登录的扫码二维码
func (s *XiaohongshuService) GetLoginQrcode(ctx context.Context) (*LoginQrcodeResponse, error) {
	b := newBrowser()
	page := b.NewPage()

	deferFunc := func() {
		_ = page.Close()
		b.Close()
	}

	loginAction := xiaohongshu.NewLogin(page)

	img, loggedIn, err := loginAction.FetchQrcodeImage(ctx)
	if err != nil || loggedIn {
		defer deferFunc()
	}
	if err != nil {
		return nil, err
	}

	timeout := 4 * time.Minute

	if !loggedIn {
		s.waitScanInBackground(loginAction, page, deferFunc, timeout)
	}

	return &LoginQrcodeResponse{
		Timeout: func() string {
			if loggedIn {
				return "0s"
			}
			return timeout.String()
		}(),
		Img:        img,
		IsLoggedIn: loggedIn,
	}, nil
}

// waitScanInBackground 在后台等用户扫码，扫上了就存 cookie。
//
// 浏览器必须一直活着才检测得到扫码，所以这里不能提前关；但也不能任由它堆积——
// 再取一次二维码就会把上一个还在等的会话关掉，同一时刻只留一个。
func (s *XiaohongshuService) waitScanInBackground(
	loginAction *xiaohongshu.LoginAction, page *rod.Page, closeBrowser func(), timeout time.Duration,
) {
	ctxTimeout, cancel := context.WithTimeout(context.Background(), timeout)
	seq := s.logins.start(cancel)
	logrus.Infof("等待扫码登录，会话 #%d，超时 %s", seq, timeout)

	go func() {
		defer closeBrowser()
		defer cancel()
		defer s.logins.finish(seq)

		if loginAction.WaitForLogin(ctxTimeout) {
			if err := saveCookies(page); err != nil {
				logrus.Errorf("扫码成功但保存 cookies 失败，会话 #%d", seq)
				return
			}
			s.resetReadBrowser()
			logrus.Infof("扫码登录成功，cookies 已保存，会话 #%d", seq)
			return
		}

		// 没等到扫码：要么超时，要么被新取的二维码取代
		logrus.Infof("登录会话 #%d 结束，未检测到扫码（超时或已被新的二维码取代）", seq)
	}()
}

// PublishContent 发布内容
func (s *XiaohongshuService) PublishContent(ctx context.Context, req *PublishRequest) (*PublishResponse, error) {
	// 验证标题长度（小红书限制：最大20个字）
	if xhsutil.CalcTitleLength(req.Title) > 20 {
		return nil, fmt.Errorf("标题长度超过限制")
	}

	imagePaths, err := s.processImages(req.Images)
	if err != nil {
		return nil, err
	}

	var scheduleTime *time.Time
	if req.ScheduleAt != "" {
		t, err := time.Parse(time.RFC3339, req.ScheduleAt)
		if err != nil {
			return nil, fmt.Errorf("定时发布时间格式错误，请使用 ISO8601 格式: %v", err)
		}

		// 校验定时发布时间范围：1小时至14天
		now := time.Now()
		minTime := now.Add(1 * time.Hour)
		maxTime := now.Add(14 * 24 * time.Hour)

		if t.Before(minTime) {
			return nil, fmt.Errorf("定时发布时间必须至少在1小时后，当前设置: %s，最早可选: %s",
				t.Format("2006-01-02 15:04"), minTime.Format("2006-01-02 15:04"))
		}
		if t.After(maxTime) {
			return nil, fmt.Errorf("定时发布时间不能超过14天，当前设置: %s，最晚可选: %s",
				t.Format("2006-01-02 15:04"), maxTime.Format("2006-01-02 15:04"))
		}

		scheduleTime = &t
		logrus.Infof("设置定时发布时间: %s", t.Format("2006-01-02 15:04"))
	}

	content := xiaohongshu.PublishImageContent{
		Title:        req.Title,
		Content:      req.Content,
		Tags:         req.Tags,
		ImagePaths:   imagePaths,
		ScheduleTime: scheduleTime,
		IsOriginal:   req.IsOriginal,
		Visibility:   req.Visibility,
		Products:     req.Products,
	}

	if err := s.publishContent(ctx, content); err != nil {
		logrus.Errorf("发布内容失败: title=%s %v", content.Title, err)
		return nil, err
	}

	response := &PublishResponse{
		Title:   req.Title,
		Content: req.Content,
		Images:  len(imagePaths),
		Status:  "发布完成",
	}

	return response, nil
}

// processImages 处理图片列表，支持URL下载和本地路径
func (s *XiaohongshuService) processImages(images []string) ([]string, error) {
	processor := downloader.NewImageProcessor()
	return processor.ProcessImages(images)
}

// publishContent 执行内容发布
func (s *XiaohongshuService) publishContent(ctx context.Context, content xiaohongshu.PublishImageContent) error {
	b := newBrowser()
	defer b.Close()

	page := b.NewPage()
	defer page.Close()

	action, err := xiaohongshu.NewPublishImageAction(page)
	if err != nil {
		return err
	}

	return action.Publish(ctx, content)
}

// PublishVideo 发布视频（本地文件）
func (s *XiaohongshuService) PublishVideo(ctx context.Context, req *PublishVideoRequest) (*PublishVideoResponse, error) {
	// 标题长度校验（小红书限制：最大20个字）
	if xhsutil.CalcTitleLength(req.Title) > 20 {
		return nil, fmt.Errorf("标题长度超过限制")
	}

	// 本地视频文件校验
	if req.Video == "" {
		return nil, fmt.Errorf("必须提供本地视频文件")
	}
	if _, err := os.Stat(req.Video); err != nil {
		return nil, fmt.Errorf("视频文件不存在或不可访问: %v", err)
	}

	var scheduleTime *time.Time
	if req.ScheduleAt != "" {
		t, err := time.Parse(time.RFC3339, req.ScheduleAt)
		if err != nil {
			return nil, fmt.Errorf("定时发布时间格式错误，请使用 ISO8601 格式: %v", err)
		}

		// 校验定时发布时间范围：1小时至14天
		now := time.Now()
		minTime := now.Add(1 * time.Hour)
		maxTime := now.Add(14 * 24 * time.Hour)

		if t.Before(minTime) {
			return nil, fmt.Errorf("定时发布时间必须至少在1小时后，当前设置: %s，最早可选: %s",
				t.Format("2006-01-02 15:04"), minTime.Format("2006-01-02 15:04"))
		}
		if t.After(maxTime) {
			return nil, fmt.Errorf("定时发布时间不能超过14天，当前设置: %s，最晚可选: %s",
				t.Format("2006-01-02 15:04"), maxTime.Format("2006-01-02 15:04"))
		}

		scheduleTime = &t
		logrus.Infof("设置定时发布时间: %s", t.Format("2006-01-02 15:04"))
	}

	content := xiaohongshu.PublishVideoContent{
		Title:        req.Title,
		Content:      req.Content,
		Tags:         req.Tags,
		VideoPath:    req.Video,
		ScheduleTime: scheduleTime,
		Visibility:   req.Visibility,
		Products:     req.Products,
	}

	if err := s.publishVideo(ctx, content); err != nil {
		return nil, err
	}

	resp := &PublishVideoResponse{
		Title:   req.Title,
		Content: req.Content,
		Video:   req.Video,
		Status:  "发布完成",
	}
	return resp, nil
}

// publishVideo 执行视频发布
func (s *XiaohongshuService) publishVideo(ctx context.Context, content xiaohongshu.PublishVideoContent) error {
	b := newBrowser()
	defer b.Close()

	page := b.NewPage()
	defer page.Close()

	action, err := xiaohongshu.NewPublishVideoAction(page)
	if err != nil {
		return err
	}

	return action.PublishVideo(ctx, content)
}

// ListFeeds 获取Feeds列表
func (s *XiaohongshuService) ListFeeds(ctx context.Context) (*FeedsListResponse, error) {
	b := newBrowser()
	defer b.Close()

	page := b.NewPage()
	defer page.Close()

	action := xiaohongshu.NewFeedsListAction(page)

	feeds, err := action.GetFeedsList(ctx)
	if err != nil {
		logrus.Errorf("获取 Feeds 列表失败: %v", err)
		return nil, err
	}

	response := &FeedsListResponse{
		Feeds: feeds,
		Count: len(feeds),
	}

	return response, nil
}

func (s *XiaohongshuService) SearchFeeds(ctx context.Context, keyword string, filters ...xiaohongshu.FilterOption) (*FeedsListResponse, error) {
	return s.SearchFeedsWithVerification(ctx, keyword, "", filters...)
}

func (s *XiaohongshuService) SearchFeedsWithVerification(
	ctx context.Context,
	keyword string,
	verificationRequestKey string,
	filters ...xiaohongshu.FilterOption,
) (*FeedsListResponse, error) {
	var feeds []xiaohongshu.Feed
	// 详情读取会导航到 explore 页面并可能改变风控状态。每次新搜索都从隔离
	// 浏览器会话开始，避免复用上一详情页后立即触发安全验证。
	operation := func(page *rod.Page) error {
		action := xiaohongshu.NewSearchAction(page)
		var searchErr error
		feeds, searchErr = action.Search(ctx, keyword, filters...)
		return searchErr
	}
	var err error
	if verificationRequestKey == "" {
		err = s.withFreshReadPage(ctx, operation)
	} else {
		err = s.withFreshReadPageForVerification(
			ctx,
			verificationRequestKey,
			operation,
		)
	}
	if err != nil {
		return nil, err
	}

	response := &FeedsListResponse{
		Feeds: feeds,
		Count: len(feeds),
	}

	return response, nil
}

// GetFeedDetail 获取Feed详情
func (s *XiaohongshuService) GetFeedDetail(ctx context.Context, feedID, xsecToken string, loadAllComments bool) (*FeedDetailResponse, error) {
	return s.GetFeedDetailWithConfig(ctx, feedID, xsecToken, loadAllComments, xiaohongshu.DefaultCommentLoadConfig())
}

// GetFeedDetailWithSource 按令牌来源读取详情。搜索结果必须传 pc_search；
// 其他旧调用保持 pc_feed 默认值，避免改变上游 MCP 的既有契约。
func (s *XiaohongshuService) GetFeedDetailWithSource(
	ctx context.Context,
	feedID, xsecToken string,
	loadAllComments bool,
	xsecSource string,
) (*FeedDetailResponse, error) {
	return s.GetFeedDetailWithConfigAndSource(
		ctx,
		feedID,
		xsecToken,
		loadAllComments,
		xiaohongshu.DefaultCommentLoadConfig(),
		xsecSource,
	)
}

// GetFeedDetailWithConfig 使用配置获取Feed详情
func (s *XiaohongshuService) GetFeedDetailWithConfig(ctx context.Context, feedID, xsecToken string, loadAllComments bool, config xiaohongshu.CommentLoadConfig) (*FeedDetailResponse, error) {
	return s.GetFeedDetailWithConfigAndSource(
		ctx,
		feedID,
		xsecToken,
		loadAllComments,
		config,
		xiaohongshu.FeedDetailSourcePCFeed,
	)
}

// GetFeedDetailWithConfigAndSource 使用受控浏览器和明确令牌来源读取详情。
func (s *XiaohongshuService) GetFeedDetailWithConfigAndSource(
	ctx context.Context,
	feedID, xsecToken string,
	loadAllComments bool,
	config xiaohongshu.CommentLoadConfig,
	xsecSource string,
) (*FeedDetailResponse, error) {
	var result *xiaohongshu.FeedDetailResponse
	err := s.withFreshReadPage(ctx, func(page *rod.Page) error {
		action := xiaohongshu.NewFeedDetailAction(page)
		var detailErr error
		result, detailErr = action.GetFeedDetailWithConfigAndSource(
			ctx,
			feedID,
			xsecToken,
			loadAllComments,
			config,
			xsecSource,
		)
		return detailErr
	})
	if err != nil {
		return nil, err
	}

	response := &FeedDetailResponse{
		FeedID: feedID,
		Data:   result,
	}

	return response, nil
}

// UserProfile 获取用户信息
func (s *XiaohongshuService) UserProfile(ctx context.Context, userID, xsecToken string) (*UserProfileResponse, error) {
	b := newBrowser()
	defer b.Close()

	page := b.NewPage()
	defer page.Close()

	action := xiaohongshu.NewUserProfileAction(page)

	result, err := action.UserProfile(ctx, userID, xsecToken)
	if err != nil {
		return nil, err
	}
	response := &UserProfileResponse{
		UserBasicInfo: result.UserBasicInfo,
		Interactions:  result.Interactions,
		Feeds:         result.Feeds,
	}

	return response, nil

}

// PostCommentToFeed 发表评论到Feed
func (s *XiaohongshuService) PostCommentToFeed(ctx context.Context, feedID, xsecToken, content string) (*PostCommentResponse, error) {
	b := newBrowser()
	defer b.Close()

	page := b.NewPage()
	defer page.Close()

	action := xiaohongshu.NewCommentFeedAction(page)

	if err := action.PostComment(ctx, feedID, xsecToken, content); err != nil {
		return nil, err
	}

	return &PostCommentResponse{FeedID: feedID, Success: true, Message: "评论发表成功"}, nil
}

// LikeFeed 点赞笔记
func (s *XiaohongshuService) LikeFeed(ctx context.Context, feedID, xsecToken string) (*ActionResult, error) {
	b := newBrowser()
	defer b.Close()

	page := b.NewPage()
	defer page.Close()

	action := xiaohongshu.NewLikeAction(page)
	if err := action.Like(ctx, feedID, xsecToken); err != nil {
		return nil, err
	}
	return &ActionResult{FeedID: feedID, Success: true, Message: "点赞成功或已点赞"}, nil
}

// UnlikeFeed 取消点赞笔记
func (s *XiaohongshuService) UnlikeFeed(ctx context.Context, feedID, xsecToken string) (*ActionResult, error) {
	b := newBrowser()
	defer b.Close()

	page := b.NewPage()
	defer page.Close()

	action := xiaohongshu.NewLikeAction(page)
	if err := action.Unlike(ctx, feedID, xsecToken); err != nil {
		return nil, err
	}
	return &ActionResult{FeedID: feedID, Success: true, Message: "取消点赞成功或未点赞"}, nil
}

// FavoriteFeed 收藏笔记
func (s *XiaohongshuService) FavoriteFeed(ctx context.Context, feedID, xsecToken string) (*ActionResult, error) {
	b := newBrowser()
	defer b.Close()

	page := b.NewPage()
	defer page.Close()

	action := xiaohongshu.NewFavoriteAction(page)
	if err := action.Favorite(ctx, feedID, xsecToken); err != nil {
		return nil, err
	}
	return &ActionResult{FeedID: feedID, Success: true, Message: "收藏成功或已收藏"}, nil
}

// UnfavoriteFeed 取消收藏笔记
func (s *XiaohongshuService) UnfavoriteFeed(ctx context.Context, feedID, xsecToken string) (*ActionResult, error) {
	b := newBrowser()
	defer b.Close()

	page := b.NewPage()
	defer page.Close()

	action := xiaohongshu.NewFavoriteAction(page)
	if err := action.Unfavorite(ctx, feedID, xsecToken); err != nil {
		return nil, err
	}
	return &ActionResult{FeedID: feedID, Success: true, Message: "取消收藏成功或未收藏"}, nil
}

// ReplyCommentToFeed 回复指定评论
func (s *XiaohongshuService) ReplyCommentToFeed(ctx context.Context, feedID, xsecToken, commentID, userID, content string) (*ReplyCommentResponse, error) {
	b := newBrowser()
	defer b.Close()

	page := b.NewPage()
	defer page.Close()

	action := xiaohongshu.NewCommentFeedAction(page)

	if err := action.ReplyToComment(ctx, feedID, xsecToken, commentID, userID, content); err != nil {
		return nil, err
	}

	return &ReplyCommentResponse{
		FeedID:          feedID,
		TargetCommentID: commentID,
		TargetUserID:    userID,
		Success:         true,
		Message:         "评论回复成功",
	}, nil
}

func newBrowser() *headless_browser.Browser {
	return browser.NewBrowser(configs.IsHeadless(),
		browser.WithFingerprintSeed(configs.FingerprintSeed()),
		browser.WithProxy(configs.Proxy()),
	)
}

func saveCookies(page *rod.Page) error {
	cks, err := page.Browser().GetCookies()
	if err != nil {
		return err
	}

	data, err := json.Marshal(cks)
	if err != nil {
		return err
	}

	cookieLoader := cookies.NewLoadCookie(cookies.GetCookiesFilePath())
	return cookieLoader.SaveCookies(data)
}

// withBrowserPage 执行需要浏览器页面的操作的通用函数
func withBrowserPage(fn func(*rod.Page) error) error {
	b := newBrowser()
	defer b.Close()

	page := b.NewPage()
	defer page.Close()

	return fn(page)
}

// GetMyProfile 获取当前登录用户的个人信息
func (s *XiaohongshuService) GetMyProfile(ctx context.Context) (*UserProfileResponse, error) {
	var result *xiaohongshu.UserProfileResponse
	var err error

	err = withBrowserPage(func(page *rod.Page) error {
		action := xiaohongshu.NewUserProfileAction(page)
		result, err = action.GetMyProfileViaSidebar(ctx)
		return err
	})

	if err != nil {
		return nil, err
	}

	response := &UserProfileResponse{
		UserBasicInfo: result.UserBasicInfo,
		Interactions:  result.Interactions,
		Feeds:         result.Feeds,
	}

	return response, nil
}
