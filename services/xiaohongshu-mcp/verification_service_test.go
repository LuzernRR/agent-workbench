package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-rod/rod"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/xpzouying/headless_browser"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

func verificationPNGDataURL() (string, []byte) {
	data := append([]byte(nil), pngSignature...)
	data = append(data, make([]byte, 64)...)
	return verificationQRCodePrefix + base64.StdEncoding.EncodeToString(data), data
}

func verificationTestService(t *testing.T) *XiaohongshuService {
	t.Helper()
	service := NewXiaohongshuService()
	service.resolveVerificationUser = func(context.Context) (*LoginStatusResponse, error) {
		return &LoginStatusResponse{IsLoggedIn: true, UserID: "expected-user"}, nil
	}
	service.closeVerificationPage = func(*rod.Page, *headless_browser.Browser) {}
	service.stageVerificationSession(
		"run-one:tool-one",
		new(rod.Page),
		new(headless_browser.Browser),
	)
	image, _ := verificationPNGDataURL()
	service.fetchVerificationQRCode = func(context.Context, *rod.Page) (string, bool, error) {
		return image, false, nil
	}
	service.readVerificationUser = func(context.Context, *rod.Page) (*xiaohongshu.CurrentUser, error) {
		return &xiaohongshu.CurrentUser{UserID: "expected-user"}, nil
	}
	service.saveVerificationCookies = func(*rod.Page) error { return nil }
	service.verificationTimeout = time.Second
	return service
}

func waitVerificationStatus(
	t *testing.T,
	service *XiaohongshuService,
	challengeID string,
	want LoginVerificationStatus,
) LoginVerificationResponse {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		status, err := service.LoginVerificationStatus(challengeID)
		require.NoError(t, err)
		if status.Status == want {
			return *status
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("verification did not reach %s", want)
	return LoginVerificationResponse{}
}

func TestStartLoginVerificationKeepsQRCodeOutOfPublicResponse(t *testing.T) {
	service := verificationTestService(t)
	wait := make(chan struct{})
	service.waitVerificationLogin = func(ctx context.Context, _ *rod.Page) bool {
		select {
		case <-ctx.Done():
			return false
		case <-wait:
			return true
		}
	}
	t.Cleanup(func() {
		close(wait)
		service.Close()
	})
	_, expectedPNG := verificationPNGDataURL()

	started, err := service.StartLoginVerification(
		context.Background(),
		"run-one:tool-one",
	)
	require.NoError(t, err)
	assert.Equal(t, verificationPending, started.Status)
	image, err := service.LoginVerificationQRCode(started.ChallengeID)
	require.NoError(t, err)
	assert.Equal(t, expectedPNG, image)
	serialized, err := json.Marshal(started)
	require.NoError(t, err)
	assert.NotContains(t, string(serialized), base64.StdEncoding.EncodeToString(expectedPNG))
	assert.NotContains(t, string(serialized), "expected-user")
}

func TestLoginVerificationIsIdempotentWhilePending(t *testing.T) {
	service := verificationTestService(t)
	wait := make(chan struct{})
	service.waitVerificationLogin = func(ctx context.Context, _ *rod.Page) bool {
		select {
		case <-ctx.Done():
			return false
		case <-wait:
			return true
		}
	}
	t.Cleanup(func() {
		close(wait)
		service.Close()
	})

	first, err := service.StartLoginVerification(context.Background(), "run-one:tool-one")
	require.NoError(t, err)
	second, err := service.StartLoginVerification(context.Background(), "run-one:tool-one")
	require.NoError(t, err)

	assert.Equal(t, first.ChallengeID, second.ChallengeID)
}

func TestLoginVerificationRejectsMissingOrMismatchedStagedSession(t *testing.T) {
	t.Run("missing session", func(t *testing.T) {
		service := NewXiaohongshuService()
		_, err := service.StartLoginVerification(
			context.Background(),
			"run-one:tool-one",
		)

		var verificationError *LoginVerificationError
		require.ErrorAs(t, err, &verificationError)
		assert.Equal(t, "VERIFICATION_SESSION_UNAVAILABLE", verificationError.Code)
		service.Close()
	})

	t.Run("mismatched key does not consume the original session", func(t *testing.T) {
		service := verificationTestService(t)
		_, err := service.StartLoginVerification(
			context.Background(),
			"run-two:tool-two",
		)

		var verificationError *LoginVerificationError
		require.ErrorAs(t, err, &verificationError)
		assert.Equal(t, "VERIFICATION_SESSION_UNAVAILABLE", verificationError.Code)
		staged, ok := service.takeStagedVerificationSession("run-one:tool-one")
		require.True(t, ok)
		service.closeVerificationSession(staged)
		service.Close()
	})
}

func TestLoginVerificationUsesCaptchaSessionFromOriginalToolCall(t *testing.T) {
	service := verificationTestService(t)
	staged, ok := service.takeStagedVerificationSession("run-one:tool-one")
	require.True(t, ok)
	service.stageVerificationSession("run-one:tool-one", staged.page, staged.browser)
	service.fetchVerificationQRCode = func(_ context.Context, page *rod.Page) (string, bool, error) {
		require.Same(t, staged.page, page)
		image, _ := verificationPNGDataURL()
		return image, false, nil
	}
	wait := make(chan struct{})
	service.waitVerificationLogin = func(ctx context.Context, _ *rod.Page) bool {
		select {
		case <-ctx.Done():
			return false
		case <-wait:
			return true
		}
	}
	t.Cleanup(func() {
		close(wait)
		service.Close()
	})

	started, err := service.StartLoginVerification(context.Background(), "run-one:tool-one")

	require.NoError(t, err)
	assert.Equal(t, verificationPending, started.Status)
}

func TestLoginVerificationSavesOnlyMatchingAccount(t *testing.T) {
	t.Run("matching account succeeds", func(t *testing.T) {
		service := verificationTestService(t)
		service.waitVerificationLogin = func(context.Context, *rod.Page) bool { return true }
		var saves atomic.Int32
		service.saveVerificationCookies = func(*rod.Page) error {
			saves.Add(1)
			return nil
		}
		started, err := service.StartLoginVerification(context.Background(), "run-one:tool-one")
		require.NoError(t, err)

		status := waitVerificationStatus(t, service, started.ChallengeID, verificationSucceeded)
		assert.Equal(t, int32(1), saves.Load())
		assert.Empty(t, status.ReasonCode)
		service.Close()
	})

	t.Run("different account is rejected", func(t *testing.T) {
		service := verificationTestService(t)
		service.waitVerificationLogin = func(context.Context, *rod.Page) bool { return true }
		service.readVerificationUser = func(context.Context, *rod.Page) (*xiaohongshu.CurrentUser, error) {
			return &xiaohongshu.CurrentUser{UserID: "different-user"}, nil
		}
		var saves atomic.Int32
		service.saveVerificationCookies = func(*rod.Page) error {
			saves.Add(1)
			return nil
		}
		started, err := service.StartLoginVerification(context.Background(), "run-one:tool-one")
		require.NoError(t, err)

		status := waitVerificationStatus(t, service, started.ChallengeID, verificationAccountMismatch)
		assert.Equal(t, int32(0), saves.Load())
		assert.Equal(t, "ACCOUNT_MISMATCH", status.ReasonCode)
		service.Close()
	})
}

func TestLoginVerificationExpiresAndCanBeCancelled(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		service := verificationTestService(t)
		service.verificationTimeout = 20 * time.Millisecond
		service.waitVerificationLogin = func(ctx context.Context, _ *rod.Page) bool {
			<-ctx.Done()
			return false
		}
		started, err := service.StartLoginVerification(context.Background(), "run-one:tool-one")
		require.NoError(t, err)

		status := waitVerificationStatus(t, service, started.ChallengeID, verificationExpired)
		assert.Equal(t, "VERIFICATION_TIMEOUT", status.ReasonCode)
		service.Close()
	})

	t.Run("cancel", func(t *testing.T) {
		service := verificationTestService(t)
		service.waitVerificationLogin = func(ctx context.Context, _ *rod.Page) bool {
			<-ctx.Done()
			return false
		}
		started, err := service.StartLoginVerification(context.Background(), "run-one:tool-one")
		require.NoError(t, err)
		require.NoError(t, service.CancelLoginVerification(started.ChallengeID))

		status := waitVerificationStatus(t, service, started.ChallengeID, verificationCancelled)
		assert.Equal(t, "USER_CANCELLED", status.ReasonCode)
		service.Close()
	})

	t.Run("provider verification page failure", func(t *testing.T) {
		service := verificationTestService(t)
		service.waitVerificationLogin = func(context.Context, *rod.Page) bool {
			return false
		}
		started, err := service.StartLoginVerification(
			context.Background(),
			"run-one:tool-one",
		)
		require.NoError(t, err)

		status := waitVerificationStatus(
			t,
			service,
			started.ChallengeID,
			verificationFailed,
		)
		assert.Equal(t, "VERIFICATION_FAILED", status.ReasonCode)
		service.Close()
	})
}

func TestLoginVerificationFailsClosedWithoutStableCurrentAccount(t *testing.T) {
	service := verificationTestService(t)
	service.resolveVerificationUser = func(context.Context) (*LoginStatusResponse, error) {
		return &LoginStatusResponse{IsLoggedIn: true}, nil
	}

	_, err := service.StartLoginVerification(context.Background(), "run-one:tool-one")

	var verificationError *LoginVerificationError
	require.ErrorAs(t, err, &verificationError)
	assert.Equal(t, "ACCOUNT_ID_UNAVAILABLE", verificationError.Code)
	service.Close()
}
