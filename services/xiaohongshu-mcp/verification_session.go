package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"sync"
	"time"
)

type LoginVerificationStatus string

const (
	verificationPending         LoginVerificationStatus = "pending"
	verificationSucceeded       LoginVerificationStatus = "succeeded"
	verificationExpired         LoginVerificationStatus = "expired"
	verificationAccountMismatch LoginVerificationStatus = "account_mismatch"
	verificationFailed          LoginVerificationStatus = "failed"
	verificationCancelled       LoginVerificationStatus = "cancelled"
)

type LoginVerificationResponse struct {
	ChallengeID string                  `json:"challenge_id"`
	Status      LoginVerificationStatus `json:"status"`
	ExpiresAt   string                  `json:"expires_at"`
	RetryAfter  int                     `json:"retry_after_ms"`
	ReasonCode  string                  `json:"reason_code,omitempty"`
	Message     string                  `json:"message"`
}

type loginVerificationRecord struct {
	challengeID    string
	requestKey     string
	status         LoginVerificationStatus
	expiresAt      time.Time
	reasonCode     string
	message        string
	qrcodePNG      []byte
	expectedUserID string
	cancel         context.CancelFunc
}

func (r *loginVerificationRecord) public() LoginVerificationResponse {
	return LoginVerificationResponse{
		ChallengeID: r.challengeID,
		Status:      r.status,
		ExpiresAt:   r.expiresAt.UTC().Format(time.RFC3339),
		RetryAfter:  2000,
		ReasonCode:  r.reasonCode,
		Message:     r.message,
	}
}

type loginVerificationSessions struct {
	mu      sync.Mutex
	current *loginVerificationRecord
}

func newLoginVerificationID() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func (s *loginVerificationSessions) pendingForRequest(
	requestKey string,
	now time.Time,
) (LoginVerificationResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == nil ||
		s.current.requestKey != requestKey ||
		s.current.status != verificationPending ||
		!now.Before(s.current.expiresAt) {
		return LoginVerificationResponse{}, false
	}
	return s.current.public(), true
}

func (s *loginVerificationSessions) start(record *loginVerificationRecord) {
	s.mu.Lock()
	previous := s.current
	s.current = record
	s.mu.Unlock()

	if previous != nil && previous.cancel != nil {
		previous.cancel()
	}
}

func (s *loginVerificationSessions) status(challengeID string) (LoginVerificationResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == nil || s.current.challengeID != challengeID {
		return LoginVerificationResponse{}, false
	}
	return s.current.public(), true
}

func (s *loginVerificationSessions) qrcode(challengeID string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == nil ||
		s.current.challengeID != challengeID ||
		s.current.status != verificationPending ||
		len(s.current.qrcodePNG) == 0 {
		return nil, false
	}
	return append([]byte(nil), s.current.qrcodePNG...), true
}

func (s *loginVerificationSessions) transition(
	challengeID string,
	status LoginVerificationStatus,
	reasonCode string,
	message string,
) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == nil ||
		s.current.challengeID != challengeID ||
		s.current.status != verificationPending {
		return false
	}
	s.current.status = status
	s.current.reasonCode = reasonCode
	s.current.message = message
	s.current.qrcodePNG = nil
	s.current.cancel = nil
	return true
}

func (s *loginVerificationSessions) commit(
	challengeID string,
	save func() error,
) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == nil ||
		s.current.challengeID != challengeID ||
		s.current.status != verificationPending {
		return false, nil
	}
	if err := save(); err != nil {
		s.current.status = verificationFailed
		s.current.reasonCode = "VERIFICATION_SAVE_FAILED"
		s.current.message = "工具账号验证成功，但登录会话更新失败"
		s.current.qrcodePNG = nil
		s.current.cancel = nil
		return true, err
	}
	s.current.status = verificationSucceeded
	s.current.reasonCode = ""
	s.current.message = "小红书工具账号验证成功"
	s.current.qrcodePNG = nil
	s.current.cancel = nil
	return true, nil
}

func (s *loginVerificationSessions) cancel(challengeID string) bool {
	s.mu.Lock()
	if s.current == nil ||
		s.current.challengeID != challengeID ||
		s.current.status != verificationPending {
		s.mu.Unlock()
		return false
	}
	cancel := s.current.cancel
	s.current.status = verificationCancelled
	s.current.reasonCode = "USER_CANCELLED"
	s.current.message = "已取消小红书工具账号验证"
	s.current.qrcodePNG = nil
	s.current.cancel = nil
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	return true
}

func (s *loginVerificationSessions) close() {
	s.mu.Lock()
	current := s.current
	s.current = nil
	s.mu.Unlock()
	if current != nil && current.cancel != nil {
		current.cancel()
	}
}
