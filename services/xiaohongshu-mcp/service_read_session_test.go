package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/go-rod/rod"
	"github.com/stretchr/testify/require"
	"github.com/xpzouying/headless_browser"
)

func TestWithReadPageUsesFreshPagesInBoundedBrowserSession(t *testing.T) {
	var browserCreates int
	var pageCreates int
	var closes int
	closed := make(chan struct{}, 2)
	stamp := cookieStamp{exists: true, size: 1}

	service := &XiaohongshuService{
		newReadBrowser: func() (*headless_browser.Browser, error) {
			browserCreates++
			return new(headless_browser.Browser), nil
		},
		newReadPage: func(*headless_browser.Browser) (*rod.Page, error) {
			pageCreates++
			return new(rod.Page), nil
		},
		readPageHealthy: func(*rod.Page) bool { return true },
		readCookie:      func() cookieStamp { return stamp },
		closeReadSession: func(*rod.Page, *headless_browser.Browser) {
			closes++
			closed <- struct{}{}
		},
	}

	pages := make([]*rod.Page, 0, maxReadOperationsPerSession)
	for range maxReadOperationsPerSession {
		require.NoError(t, service.withReadPage(context.Background(), func(page *rod.Page) error {
			pages = append(pages, page)
			return nil
		}))
	}
	require.Equal(t, 1, browserCreates)
	require.Equal(t, maxReadOperationsPerSession, pageCreates)
	for index := 1; index < len(pages); index++ {
		require.NotSame(t, pages[index-1], pages[index])
	}
	require.Equal(t, 1, closes)
	<-closed
	require.Nil(t, service.readBrowser)
	require.Nil(t, service.readPage)

	var replacementPage *rod.Page
	require.NoError(t, service.withReadPage(context.Background(), func(page *rod.Page) error {
		replacementPage = page
		return nil
	}))
	require.NotSame(t, pages[0], replacementPage)
	require.Equal(t, 2, browserCreates)
	require.Equal(t, maxReadOperationsPerSession+1, pageCreates)

	wantErr := errors.New("read failed")
	err := service.withReadPage(context.Background(), func(page *rod.Page) error {
		require.NotSame(t, replacementPage, page)
		return wantErr
	})
	require.ErrorIs(t, err, wantErr)
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("discarded read session was not closed")
	}
	require.Equal(t, 2, closes)
	require.Nil(t, service.readBrowser)
	require.Nil(t, service.readPage)
}

func TestCaptchaReadSessionIsStagedForExactVerificationRequest(t *testing.T) {
	page := new(rod.Page)
	browserInstance := new(headless_browser.Browser)
	var closes int
	service := &XiaohongshuService{
		newReadBrowser: func() (*headless_browser.Browser, error) {
			return browserInstance, nil
		},
		newReadPage: func(*headless_browser.Browser) (*rod.Page, error) {
			return page, nil
		},
		readPageHealthy: func(*rod.Page) bool { return true },
		readCookie: func() cookieStamp {
			return cookieStamp{exists: true, size: 1}
		},
		closeReadSession: func(*rod.Page, *headless_browser.Browser) {
			closes++
		},
	}

	err := service.withFreshReadPageForVerification(
		context.Background(),
		"run-one:tool-one",
		func(*rod.Page) error { return errors.New("小红书要求安全验证") },
	)
	require.Error(t, err)
	require.Nil(t, service.readPage)
	require.Nil(t, service.readBrowser)
	require.Equal(t, 0, closes)

	_, ok := service.takeStagedVerificationSession("run-two:tool-two")
	require.False(t, ok)
	staged, ok := service.takeStagedVerificationSession("run-one:tool-one")
	require.True(t, ok)
	require.Same(t, page, staged.page)
	require.Same(t, browserInstance, staged.browser)
	service.closeVerificationSession(staged)
	require.Equal(t, 1, closes)
}

func TestWithFreshReadPageIsolatesDetailBrowserSessions(t *testing.T) {
	var browserCreates int
	var pageCreates int
	var closes int
	service := &XiaohongshuService{
		newReadBrowser: func() (*headless_browser.Browser, error) {
			browserCreates++
			return new(headless_browser.Browser), nil
		},
		newReadPage: func(*headless_browser.Browser) (*rod.Page, error) {
			pageCreates++
			return new(rod.Page), nil
		},
		readPageHealthy: func(*rod.Page) bool { return true },
		readCookie: func() cookieStamp {
			return cookieStamp{exists: true, size: 1}
		},
		closeReadSession: func(*rod.Page, *headless_browser.Browser) {
			closes++
		},
	}

	require.NoError(t, service.withReadPage(context.Background(), func(*rod.Page) error {
		return nil
	}))
	require.NoError(t, service.withFreshReadPage(context.Background(), func(*rod.Page) error {
		return nil
	}))
	require.NoError(t, service.withFreshReadPage(context.Background(), func(*rod.Page) error {
		return nil
	}))

	require.Equal(t, 3, browserCreates)
	require.Equal(t, 3, pageCreates)
	require.Equal(t, 2, closes)
}

func TestWithReadPageRebuildsDeadIdlePageBeforeOperation(t *testing.T) {
	var browserCreates int
	var pageCreates int
	var healthChecks int
	var closes int
	service := &XiaohongshuService{
		newReadBrowser: func() (*headless_browser.Browser, error) {
			browserCreates++
			return new(headless_browser.Browser), nil
		},
		newReadPage: func(*headless_browser.Browser) (*rod.Page, error) {
			pageCreates++
			return new(rod.Page), nil
		},
		readPageHealthy: func(*rod.Page) bool {
			healthChecks++
			return false
		},
		readCookie: func() cookieStamp {
			return cookieStamp{exists: true, size: 1}
		},
		closeReadSession: func(*rod.Page, *headless_browser.Browser) {
			closes++
		},
	}

	var firstPage *rod.Page
	require.NoError(t, service.withReadPage(context.Background(), func(page *rod.Page) error {
		firstPage = page
		return nil
	}))

	var replacementPage *rod.Page
	require.NoError(t, service.withReadPage(context.Background(), func(page *rod.Page) error {
		replacementPage = page
		return nil
	}))

	require.NotSame(t, firstPage, replacementPage)
	require.Equal(t, 1, healthChecks)
	require.Equal(t, 2, browserCreates)
	require.Equal(t, 2, pageCreates)
	require.Equal(t, 1, closes)
}

func TestWithReadPageSynchronouslyRebuildsWhenCookiesChange(t *testing.T) {
	var browserCreates int
	var pageCreates int
	var closes int
	stamp := cookieStamp{exists: true, size: 1}

	service := &XiaohongshuService{
		newReadBrowser: func() (*headless_browser.Browser, error) {
			browserCreates++
			return new(headless_browser.Browser), nil
		},
		newReadPage: func(*headless_browser.Browser) (*rod.Page, error) {
			pageCreates++
			return new(rod.Page), nil
		},
		readPageHealthy: func(*rod.Page) bool { return true },
		readCookie:      func() cookieStamp { return stamp },
		closeReadSession: func(*rod.Page, *headless_browser.Browser) {
			closes++
		},
	}

	var firstPage *rod.Page
	require.NoError(t, service.withReadPage(context.Background(), func(page *rod.Page) error {
		firstPage = page
		return nil
	}))

	stamp.size = 2
	var replacementPage *rod.Page
	require.NoError(t, service.withReadPage(context.Background(), func(page *rod.Page) error {
		replacementPage = page
		return nil
	}))

	require.NotSame(t, firstPage, replacementPage)
	require.Equal(t, 2, browserCreates)
	require.Equal(t, 2, pageCreates)
	require.Equal(t, 1, closes)
}

func TestWithReadPageWaitsForFailedSessionCleanupBeforeReplacement(t *testing.T) {
	created := make(chan struct{}, 2)
	cleanupStarted := make(chan struct{})
	releaseCleanup := make(chan struct{})
	service := &XiaohongshuService{
		newReadBrowser: func() (*headless_browser.Browser, error) {
			created <- struct{}{}
			return new(headless_browser.Browser), nil
		},
		newReadPage: func(*headless_browser.Browser) (*rod.Page, error) {
			return new(rod.Page), nil
		},
		readPageHealthy: func(*rod.Page) bool { return true },
		readCookie: func() cookieStamp {
			return cookieStamp{exists: true, size: 1}
		},
		closeReadSession: func(*rod.Page, *headless_browser.Browser) {
			close(cleanupStarted)
			<-releaseCleanup
		},
	}

	wantErr := errors.New("renderer disconnected")
	require.ErrorIs(t, service.withReadPage(
		context.Background(),
		func(*rod.Page) error { return wantErr },
	), wantErr)
	<-created
	<-cleanupStarted

	secondDone := make(chan error, 1)
	go func() {
		secondDone <- service.withReadPage(
			context.Background(),
			func(*rod.Page) error { return nil },
		)
	}()
	select {
	case <-created:
		t.Fatal("replacement browser started before failed session cleanup")
	case <-time.After(50 * time.Millisecond):
	}

	close(releaseCleanup)
	select {
	case <-created:
	case <-time.After(time.Second):
		t.Fatal("replacement browser did not start after cleanup")
	}
	require.NoError(t, <-secondDone)
}
