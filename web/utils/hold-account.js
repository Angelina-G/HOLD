/**
 * 微信登录 / 账号档案。
 *
 * 登录方式：wx.login 换 code，交给云函数换 openid（openid 不经过小程序端，
 * 由云函数用 getWXContext 直接取，避免被伪造），首登即自动建号。
 *
 * 说明：wx.getUserProfile / open-data 已经无法拿到真实昵称头像，
 * 这里默认用「微信用户 + 可编辑昵称」，头像走 chooseAvatar 按钮。
 */

const STORE_FUNCTION = 'health_store';
const PROFILE_FUNCTION = 'health_account';

const listeners = [];

const account = {
  status: 'anonymous', // anonymous | signing | ready | error
  user: null,
  error: '',
  lastSyncedAt: 0
};

function notify() {
  const snapshot = {
    status: account.status,
    user: account.user ? Object.assign({}, account.user) : null,
    error: account.error,
    lastSyncedAt: account.lastSyncedAt
  };
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      console.error('account listener error', error);
    }
  });
}

function subscribe(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }

  listeners.push(listener);
  listener({
    status: account.status,
    user: account.user ? Object.assign({}, account.user) : null,
    error: account.error,
    lastSyncedAt: account.lastSyncedAt
  });

  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) {
      listeners.splice(index, 1);
    }
  };
}

function getState() {
  return {
    status: account.status,
    user: account.user ? Object.assign({}, account.user) : null,
    error: account.error,
    lastSyncedAt: account.lastSyncedAt
  };
}

function isCloudReady() {
  return !!(wx.cloud && typeof wx.cloud.callFunction === 'function');
}

function callStore(data) {
  return wx.cloud
    .callFunction({ name: STORE_FUNCTION, data })
    .then((response) => (response && response.result ? response.result : {}))
    .then((result) => {
      if (result.code && Number(result.code) !== 200) {
        throw new Error(result.error_message || `cloud error ${result.code}`);
      }
      return result;
    });
}

/**
 * 登录时优先用云开发的登录云函数；没部署就退回 health_store，
 * 这样少部署一个云函数也能跑通。
 */
function callLogin(profile) {
  return wx.cloud
    .callFunction({ name: PROFILE_FUNCTION, data: { action: 'login', profile } })
    .then((response) => (response && response.result ? response.result : {}))
    .then((result) => {
      if (result.code && Number(result.code) !== 200) {
        return callStore({ action: 'user_sync', profile });
      }
      return result;
    })
    .catch(() => callStore({ action: 'user_sync', profile }));
}

function applyUser(user) {
  if (!user) {
    return;
  }

  account.user = {
    userId: user.userId || '',
    nickname: user.nickname || '微信用户',
    avatarUrl: user.avatarUrl || '',
    createdAtMs: Number(user.createdAtMs || 0),
    lastLoginAtMs: Number(user.lastLoginAtMs || 0),
    loginCount: Number(user.loginCount || 1),
    openidTail: user.openidTail || ''
  };
  account.lastSyncedAt = Date.now();
}

/**
 * 登录。已登录时直接返回缓存结果，force 为 true 时重新走一遍。
 */
function login(options = {}) {
  if (!isCloudReady()) {
    account.status = 'error';
    account.error = '当前环境不支持云开发，无法登录';
    notify();
    return Promise.reject(new Error(account.error));
  }

  if (account.status === 'ready' && account.user && !options.force) {
    return Promise.resolve(account.user);
  }

  account.status = 'signing';
  account.error = '';
  notify();

  return callLogin(options.profile)
    .then((result) => {
      applyUser(result.user);
      account.status = 'ready';
      account.error = '';
      notify();
      return account.user;
    })
    .catch((error) => {
      account.status = 'error';
      account.error = (error && error.message) || 'unknown';
      notify();
      throw error;
    });
}

/** 刷新昵称/头像 */
function updateProfile(profile) {
  if (!isCloudReady()) {
    return Promise.reject(new Error('cloud-unavailable'));
  }

  const payload = {};
  if (profile && typeof profile.nickname === 'string') {
    payload.nickname = profile.nickname.trim().slice(0, 20);
  }
  if (profile && typeof profile.avatarUrl === 'string') {
    payload.avatarUrl = profile.avatarUrl;
  }

  if (account.status !== 'ready') {
    return login({ force: true, profile: payload });
  }

  return callStore({ action: 'user_profile', profile: payload })
    .then((result) => {
      applyUser(result.user);
      notify();
      return account.user;
    })
    .catch((error) => {
      account.error = (error && error.message) || 'unknown';
      notify();
      throw error;
    });
}

function fetchStats() {
  if (!isCloudReady() || account.status !== 'ready') {
    return Promise.resolve(null);
  }

  return callStore({ action: 'user_stats' })
    .then((result) => result.counts || null)
    .catch(() => null);
}

/**
 * 退出登录：清掉本地账号态。
 * 注意这不删数据 —— 云端记录仍绑定微信身份，重新登录即可恢复。
 */
function logout() {
  account.status = 'anonymous';
  account.user = null;
  account.error = '';
  account.lastSyncedAt = 0;
  notify();
}

module.exports = {
  subscribe,
  getState,
  login,
  updateProfile,
  fetchStats,
  logout,
  isReady: () => account.status === 'ready' && !!account.user,
  isCloudReady
};
