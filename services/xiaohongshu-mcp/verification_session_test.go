package main

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func verificationRecord(t *testing.T, requestKey string) *loginVerificationRecord {
	t.Helper()
	id, err := newLoginVerificationID()
	require.NoError(t, err)
	_, cancel := context.WithCancel(context.Background())
	return &loginVerificationRecord{
		challengeID:    id,
		requestKey:     requestKey,
		status:         verificationPending,
		expiresAt:      time.Now().Add(time.Minute),
		message:        "等待验证",
		qrcodePNG:      []byte("png"),
		expectedUserID: "expected-user",
		cancel:         cancel,
	}
}

func TestLoginVerificationIDsAreHighEntropyAndURLSafe(t *testing.T) {
	seen := map[string]bool{}
	for range 64 {
		id, err := newLoginVerificationID()
		require.NoError(t, err)
		assert.Regexp(t, `^[A-Za-z0-9_-]{43}$`, id)
		assert.False(t, seen[id])
		seen[id] = true
	}
}

func TestLoginVerificationSessionIsIdempotentAndSingleActive(t *testing.T) {
	var sessions loginVerificationSessions
	first := verificationRecord(t, "run-one:tool-one")
	firstCancelled := false
	first.cancel = func() { firstCancelled = true }
	sessions.start(first)

	pending, ok := sessions.pendingForRequest(first.requestKey, time.Now())
	require.True(t, ok)
	assert.Equal(t, first.challengeID, pending.ChallengeID)
	assert.NotContains(t, pending.Message, first.expectedUserID)

	second := verificationRecord(t, "run-two:tool-two")
	sessions.start(second)
	assert.True(t, firstCancelled)
	_, ok = sessions.status(first.challengeID)
	assert.False(t, ok)
	current, ok := sessions.status(second.challengeID)
	require.True(t, ok)
	assert.Equal(t, verificationPending, current.Status)
}

func TestLoginVerificationTerminalStateClearsQRCode(t *testing.T) {
	var sessions loginVerificationSessions
	record := verificationRecord(t, "run-one:tool-one")
	sessions.start(record)

	image, ok := sessions.qrcode(record.challengeID)
	require.True(t, ok)
	assert.Equal(t, []byte("png"), image)
	require.True(t, sessions.transition(
		record.challengeID,
		verificationSucceeded,
		"",
		"验证成功",
	))

	_, ok = sessions.qrcode(record.challengeID)
	assert.False(t, ok)
	status, ok := sessions.status(record.challengeID)
	require.True(t, ok)
	assert.Equal(t, verificationSucceeded, status.Status)
}

func TestLoginVerificationCancelIsImmediateAndIdempotent(t *testing.T) {
	var sessions loginVerificationSessions
	record := verificationRecord(t, "run-one:tool-one")
	cancelled := false
	record.cancel = func() { cancelled = true }
	sessions.start(record)

	require.True(t, sessions.cancel(record.challengeID))
	assert.True(t, cancelled)
	assert.False(t, sessions.cancel(record.challengeID))
	status, ok := sessions.status(record.challengeID)
	require.True(t, ok)
	assert.Equal(t, verificationCancelled, status.Status)
	assert.Equal(t, "USER_CANCELLED", status.ReasonCode)
}

func TestLoginVerificationCommitCannotOverwriteReplacedChallenge(t *testing.T) {
	var sessions loginVerificationSessions
	first := verificationRecord(t, "run-one:tool-one")
	sessions.start(first)
	second := verificationRecord(t, "run-two:tool-two")
	sessions.start(second)
	saved := false

	committed, err := sessions.commit(first.challengeID, func() error {
		saved = true
		return nil
	})

	require.NoError(t, err)
	assert.False(t, committed)
	assert.False(t, saved)
}
