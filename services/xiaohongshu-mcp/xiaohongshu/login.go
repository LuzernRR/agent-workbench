package xiaohongshu

import (
	"context"
	"encoding/json"
	"time"

	"github.com/go-rod/rod"
	"github.com/pkg/errors"
)

type LoginAction struct {
	page *rod.Page
}

func NewLogin(page *rod.Page) *LoginAction {
	return &LoginAction{page: page}
}

func (a *LoginAction) CheckLoginStatus(ctx context.Context) (bool, error) {
	// Page.Navigate 在收到主文档响应头后已经返回。搜索页包含持续请求，
	// WaitLoad 在容器里可能永远等不到；登录态只依赖用户 State 或明确的
	// 登录/个人主页元素，因此等待这些信号即可。
	pp := a.page.Context(ctx)
	if err := pp.Timeout(10 * time.Second).Navigate(
		"https://www.xiaohongshu.com/explore",
	); err != nil {
		return false, errors.Wrap(err, "navigate for login status failed")
	}

	const statusReady = `() => {
		const user = window.__INITIAL_STATE__?.user;
		const raw = user?.userInfo;
		const info = raw?.value !== undefined ? raw.value : (raw?._value !== undefined ? raw._value : raw);
		if (info && typeof info.guest === "boolean") return true;
		if (document.querySelector('a[href*="/user/profile/"], .main-container .user .link-wrapper .channel')) return true;
		return Boolean(document.querySelector('.login-container, [class*="login-container"], [class*="login-modal"]'));
	}`
	if err := rod.Try(func() {
		pp.Timeout(12 * time.Second).MustWait(statusReady)
	}); err != nil {
		return false, errors.Wrap(err, "login status signal unavailable")
	}

	result, err := pp.Timeout(3 * time.Second).Eval(`() => {
		const user = window.__INITIAL_STATE__?.user;
		const raw = user?.userInfo;
		const info = raw?.value !== undefined ? raw.value : (raw?._value !== undefined ? raw._value : raw);
		if (info && typeof info.guest === "boolean") return info.guest ? "logged_out" : "logged_in";
		if (document.querySelector('a[href*="/user/profile/"], .main-container .user .link-wrapper .channel')) return "logged_in";
		if (document.querySelector('.login-container, [class*="login-container"], [class*="login-modal"]')) return "logged_out";
		return "unknown";
	}`)
	if err != nil {
		return false, errors.Wrap(err, "read login status failed")
	}
	switch result.Value.String() {
	case "logged_in":
		return true, nil
	case "logged_out":
		return false, nil
	default:
		return false, errors.New("login status remained unknown")
	}
}

// CurrentUser 当前登录用户的基础信息。
type CurrentUser struct {
	Nickname string `json:"nickname"`
	UserID   string `json:"userId"`
}

// CurrentUser 从当前页面的 __INITIAL_STATE__ 读取登录用户信息。
// 需在 CheckLoginStatus 之后调用：复用已加载的 explore 页，不做额外导航。
func (a *LoginAction) CurrentUser(ctx context.Context) (*CurrentUser, error) {
	pp := a.page.Context(ctx).Timeout(10 * time.Second)

	res, err := pp.Eval(`() => {
		const u = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user;
		const info = u && u.userInfo && u.userInfo.value !== undefined ? u.userInfo.value : (u && u.userInfo);
		if (!info || info.guest) return "";
		return JSON.stringify({nickname: info.nickname, userId: info.userId || info.user_id});
	}`)
	if err != nil {
		return nil, errors.Wrap(err, "read current user state failed")
	}

	raw := res.Value.String()
	if raw == "" {
		return nil, errors.New("current user not found in page state")
	}

	var user CurrentUser
	if err := json.Unmarshal([]byte(raw), &user); err != nil {
		return nil, errors.Wrap(err, "unmarshal current user failed")
	}

	return &user, nil
}

func (a *LoginAction) Login(ctx context.Context) error {
	pp := a.page.Context(ctx)

	// 导航到小红书首页，这会触发二维码弹窗
	pp.MustNavigate("https://www.xiaohongshu.com/explore").MustWaitLoad()

	time.Sleep(2 * time.Second)

	if exists, _, _ := pp.Has(".main-container .user .link-wrapper .channel"); exists {
		return nil
	}

	pp.MustElement(".main-container .user .link-wrapper .channel")

	return nil
}

func (a *LoginAction) FetchQrcodeImage(ctx context.Context) (string, bool, error) {
	pp := a.page.Context(ctx)

	// 导航到小红书首页，这会触发二维码弹窗
	pp.MustNavigate("https://www.xiaohongshu.com/explore").MustWaitLoad()

	time.Sleep(2 * time.Second)

	if exists, _, _ := pp.Has(".main-container .user .link-wrapper .channel"); exists {
		return "", true, nil
	}

	src, err := pp.MustElement(".login-container .qrcode-img").Attribute("src")
	if err != nil {
		return "", false, errors.Wrap(err, "get qrcode src failed")
	}
	if src == nil || len(*src) == 0 {
		return "", false, errors.New("qrcode src is empty")
	}

	return *src, false, nil
}

func (a *LoginAction) WaitForLogin(ctx context.Context) bool {
	pp := a.page.Context(ctx)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			el, err := pp.Element(".main-container .user .link-wrapper .channel")
			if err == nil && el != nil {
				return true
			}
		}
	}
}
