package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/go-rod/rod"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

const verificationQRCodePrefix = "data:image/png;base64,"

var (
	verificationRequestKeyPattern = regexp.MustCompile(`^[A-Za-z0-9:_-]{8,240}$`)
	verificationChallengePattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	pngSignature                  = []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
)

type LoginVerificationError struct {
	Code       string
	Message    string
	HTTPStatus int
	Retryable  bool
}

func (e *LoginVerificationError) Error() string {
	return e.Message
}

func safeFetchVerificationQRCode(
	ctx context.Context,
	page *rod.Page,
) (image string, loggedIn bool, err error) {
	defer func() {
		if recover() != nil {
			image = ""
			loggedIn = false
			err = fmt.Errorf("verification qrcode unavailable")
		}
	}()
	return xiaohongshu.NewLogin(page).FetchCurrentVerificationQrcode(ctx)
}

func waitForVerificationLogin(ctx context.Context, page *rod.Page) (loggedIn bool) {
	defer func() {
		if recover() != nil {
			loggedIn = false
		}
	}()
	return xiaohongshu.NewLogin(page).WaitForVerification(ctx)
}

func readVerificationCurrentUser(
	ctx context.Context,
	page *rod.Page,
) (user *xiaohongshu.CurrentUser, err error) {
	defer func() {
		if recover() != nil {
			user = nil
			err = fmt.Errorf("verification account unavailable")
		}
	}()
	login := xiaohongshu.NewLogin(page)
	if user, currentErr := login.CurrentUser(ctx); currentErr == nil {
		return user, nil
	}
	loggedIn, statusErr := login.CheckLoginStatus(ctx)
	if statusErr != nil {
		return nil, statusErr
	}
	if !loggedIn {
		return nil, fmt.Errorf("verification account is not logged in")
	}
	return login.CurrentUser(ctx)
}

func decodeVerificationQRCode(value string) ([]byte, error) {
	if len(value) <= len(verificationQRCodePrefix) ||
		!bytes.HasPrefix([]byte(value), []byte(verificationQRCodePrefix)) {
		return nil, errors.New("invalid verification qrcode format")
	}
	data, err := base64.StdEncoding.DecodeString(value[len(verificationQRCodePrefix):])
	if err != nil {
		return nil, errors.New("invalid verification qrcode encoding")
	}
	if len(data) < 64 || len(data) > 3*1024*1024 || !bytes.HasPrefix(data, pngSignature) {
		return nil, errors.New("invalid verification qrcode image")
	}
	return data, nil
}

func (s *XiaohongshuService) StartLoginVerification(
	ctx context.Context,
	requestKey string,
) (*LoginVerificationResponse, error) {
	if !verificationRequestKeyPattern.MatchString(requestKey) {
		return nil, &LoginVerificationError{
			Code:       "INVALID_REQUEST",
			Message:    "验证请求标识无效",
			HTTPStatus: 400,
		}
	}
	now := time.Now()
	if existing, ok := s.verifications.pendingForRequest(requestKey, now); ok {
		return &existing, nil
	}
	verificationSession, ok := s.takeStagedVerificationSession(requestKey)
	if !ok {
		return nil, &LoginVerificationError{
			Code:       "VERIFICATION_SESSION_UNAVAILABLE",
			Message:    "触发安全验证的工具会话已失效，请重新发起小红书搜索",
			HTTPStatus: 409,
		}
	}
	closeSession := func() { s.closeVerificationSession(verificationSession) }

	accountResolver := s.resolveVerificationUser
	if accountResolver == nil {
		accountResolver = s.CheckLoginStatus
	}
	account, err := accountResolver(ctx)
	if err != nil {
		closeSession()
		return nil, &LoginVerificationError{
			Code:       "ACCOUNT_STATUS_UNAVAILABLE",
			Message:    "暂时无法确认小红书工具账号",
			HTTPStatus: 503,
			Retryable:  true,
		}
	}
	if account == nil || !account.IsLoggedIn {
		closeSession()
		return nil, &LoginVerificationError{
			Code:       "AUTH_REQUIRED",
			Message:    "小红书工具账号登录状态已失效",
			HTTPStatus: 409,
		}
	}
	if account.UserID == "" || !verificationRequestKeyPattern.MatchString("account:"+account.UserID) {
		closeSession()
		return nil, &LoginVerificationError{
			Code:       "ACCOUNT_ID_UNAVAILABLE",
			Message:    "无法安全确认当前小红书工具账号，未启动验证",
			HTTPStatus: 409,
		}
	}

	fetchQRCode := s.fetchVerificationQRCode
	if fetchQRCode == nil {
		fetchQRCode = safeFetchVerificationQRCode
	}
	image, inheritedLogin, err := fetchQRCode(ctx, verificationSession.page)
	if err != nil || inheritedLogin {
		closeSession()
		return nil, &LoginVerificationError{
			Code:       "VERIFICATION_QRCODE_UNAVAILABLE",
			Message:    "无法生成小红书工具账号验证二维码",
			HTTPStatus: 503,
			Retryable:  true,
		}
	}
	qrcodePNG, err := decodeVerificationQRCode(image)
	if err != nil {
		closeSession()
		return nil, &LoginVerificationError{
			Code:       "VERIFICATION_QRCODE_INVALID",
			Message:    "小红书工具账号验证二维码无效",
			HTTPStatus: 502,
		}
	}
	challengeID, err := newLoginVerificationID()
	if err != nil {
		closeSession()
		return nil, &LoginVerificationError{
			Code:       "VERIFICATION_UNAVAILABLE",
			Message:    "无法创建小红书工具账号验证会话",
			HTTPStatus: 503,
			Retryable:  true,
		}
	}
	timeout := s.verificationTimeout
	if timeout <= 0 {
		timeout = 4 * time.Minute
	}
	verificationContext, cancel := context.WithTimeout(context.Background(), timeout)
	record := &loginVerificationRecord{
		challengeID:    challengeID,
		requestKey:     requestKey,
		status:         verificationPending,
		expiresAt:      now.Add(timeout),
		message:        "等待使用小红书 App 扫码验证工具账号",
		qrcodePNG:      qrcodePNG,
		expectedUserID: account.UserID,
		cancel:         cancel,
	}
	s.verifications.start(record)
	response := record.public()

	waitForLogin := s.waitVerificationLogin
	if waitForLogin == nil {
		waitForLogin = waitForVerificationLogin
	}
	readUser := s.readVerificationUser
	if readUser == nil {
		readUser = readVerificationCurrentUser
	}
	saveSession := s.saveVerificationCookies
	if saveSession == nil {
		saveSession = saveCookies
	}
	go func() {
		defer closeSession()
		defer cancel()
		if !waitForLogin(verificationContext, verificationSession.page) {
			if errors.Is(verificationContext.Err(), context.DeadlineExceeded) {
				s.verifications.transition(
					challengeID,
					verificationExpired,
					"VERIFICATION_TIMEOUT",
					"小红书工具账号验证已超时",
				)
			} else {
				s.verifications.transition(
					challengeID,
					verificationFailed,
					"VERIFICATION_FAILED",
					"小红书工具账号安全验证未完成",
				)
			}
			return
		}
		verifiedUser, userErr := readUser(verificationContext, verificationSession.page)
		if userErr != nil || verifiedUser == nil || verifiedUser.UserID == "" {
			s.verifications.transition(
				challengeID,
				verificationFailed,
				"VERIFICATION_ACCOUNT_UNCONFIRMED",
				"扫码完成，但无法确认验证账号",
			)
			return
		}
		if verifiedUser.UserID != account.UserID {
			s.verifications.transition(
				challengeID,
				verificationAccountMismatch,
				"ACCOUNT_MISMATCH",
				"扫码账号与当前小红书工具账号不一致，未更新登录会话",
			)
			return
		}
		committed, saveErr := s.verifications.commit(challengeID, func() error {
			return saveSession(verificationSession.page)
		})
		if saveErr != nil {
			logrus.WithField("errorType", fmt.Sprintf("%T", saveErr)).Warn(
				"工具账号验证 Cookie 保存失败",
			)
			return
		}
		if committed {
			s.resetReadBrowser()
		}
	}()

	return &response, nil
}

func (s *XiaohongshuService) LoginVerificationStatus(
	challengeID string,
) (*LoginVerificationResponse, error) {
	if !verificationChallengePattern.MatchString(challengeID) {
		return nil, &LoginVerificationError{
			Code:       "VERIFICATION_NOT_FOUND",
			Message:    "小红书工具账号验证会话不存在",
			HTTPStatus: 404,
		}
	}
	status, ok := s.verifications.status(challengeID)
	if !ok {
		return nil, &LoginVerificationError{
			Code:       "VERIFICATION_NOT_FOUND",
			Message:    "小红书工具账号验证会话不存在",
			HTTPStatus: 404,
		}
	}
	return &status, nil
}

func (s *XiaohongshuService) LoginVerificationQRCode(
	challengeID string,
) ([]byte, error) {
	if !verificationChallengePattern.MatchString(challengeID) {
		return nil, &LoginVerificationError{
			Code:       "VERIFICATION_NOT_FOUND",
			Message:    "小红书工具账号验证二维码不存在",
			HTTPStatus: 404,
		}
	}
	image, ok := s.verifications.qrcode(challengeID)
	if !ok {
		return nil, &LoginVerificationError{
			Code:       "VERIFICATION_QRCODE_GONE",
			Message:    "小红书工具账号验证二维码已失效",
			HTTPStatus: 410,
		}
	}
	return image, nil
}

func (s *XiaohongshuService) CancelLoginVerification(challengeID string) error {
	if !verificationChallengePattern.MatchString(challengeID) ||
		!s.verifications.cancel(challengeID) {
		return &LoginVerificationError{
			Code:       "VERIFICATION_NOT_FOUND",
			Message:    "小红书工具账号验证会话不存在或已结束",
			HTTPStatus: 404,
		}
	}
	return nil
}
