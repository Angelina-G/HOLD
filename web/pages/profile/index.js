const holdBleRuntime = require('../../utils/hold-ble-runtime');
const holdAccount = require('../../utils/hold-account');

const NICKNAME_MAX = 20;

function formatDateTime(ts) {
  const value = Number(ts || 0);
  if (!value) {
    return '--';
  }

  const date = new Date(value);
  const pad = (input) => `${input}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortenUserId(userId) {
  const value = `${userId || ''}`;
  if (value.length <= 12) {
    return value || '--';
  }
  return `${value.slice(0, 6)}···${value.slice(-4)}`;
}

Page({
  data: {
    accountStatus: 'anonymous',
    accountError: '',
    logged: false,

    nickname: '',
    avatarUrl: '',
    avatarLetter: '微',
    userIdText: '--',
    openidTail: '--',
    createdAtText: '--',
    lastLoginText: '--',
    loginCount: 0,

    editing: false,
    draftNickname: '',
    nicknameMax: NICKNAME_MAX,
    saving: false,

    stats: [],

    cloudReadyText: '--',
    scopeText: '--'
  },

  onLoad() {
    this.unsubscribeAccount = holdAccount.subscribe((state) => {
      this.applyAccountState(state);
    });

    this.unsubscribeRuntime = holdBleRuntime.subscribe((state) => {
      this.applyRuntimeState(state);
    });
  },

  onShow() {
    this.refreshStats();
  },

  onUnload() {
    if (this.unsubscribeAccount) {
      this.unsubscribeAccount();
      this.unsubscribeAccount = null;
    }
    if (this.unsubscribeRuntime) {
      this.unsubscribeRuntime();
      this.unsubscribeRuntime = null;
    }
  },

  applyAccountState(state) {
    const user = state.user || {};
    const nickname = user.nickname || '';
    const logged = state.status === 'ready' && !!state.user;

    this.setData({
      accountStatus: state.status,
      accountError: state.error || '',
      logged,

      nickname: nickname || '未登录',
      avatarUrl: user.avatarUrl || '',
      avatarLetter: nickname ? nickname.slice(0, 1) : '微',
      userIdText: shortenUserId(user.userId),
      openidTail: user.openidTail || '--',
      createdAtText: formatDateTime(user.createdAtMs),
      lastLoginText: formatDateTime(user.lastLoginAtMs),
      loginCount: user.loginCount || 0,

      editing: logged ? this.data.editing : false
    });

    if (logged) {
      this.refreshStats();
    } else {
      this.setData({ stats: [] });
    }
  },

  applyRuntimeState(state) {
    const statusMap = {
      idle: '等待同步',
      loading: '正在从云端恢复',
      ready: '云端已连接',
      error: '云端异常',
      unavailable: '不支持云开发'
    };

    const totalDays = (state.dailyAnalyses || []).length;
    const scope = state.scope === 'shared' ? '包含本机设备全部记录' : '仅当前账号记录';

    this.setData({
      cloudReadyText: statusMap[state.cloudStatus] || state.cloudStatus || '--',
      scopeText: `${scope} · 日级 ${totalDays} 天`
    });
  },

  refreshStats() {
    holdAccount.fetchStats().then((counts) => {
      if (!counts) {
        return;
      }

      this.setData({
        stats: [
          { key: 'measurement', label: '主动检测', value: `${counts.measurements}` },
          { key: 'daily', label: '监测日数', value: `${counts.dailyAnalyses}` }
        ]
      });
    });
  },

  startLogin() {
    holdAccount.login({ force: true }).then(() => {
      wx.showToast({ title: '已登录', icon: 'success', duration: 1500 });
      this.refreshStats();
    }).catch((error) => {
      wx.showToast({
        title: (error && error.message) || '登录失败',
        icon: 'none',
        duration: 2200
      });
    });
  },

  startEditNickname() {
    this.setData({
      editing: true,
      draftNickname: this.data.nickname === '未登录' ? '' : this.data.nickname
    });
  },

  cancelEditNickname() {
    this.setData({ editing: false, draftNickname: '' });
  },

  onNicknameInput(event) {
    this.setData({ draftNickname: (event.detail.value || '').slice(0, NICKNAME_MAX) });
  },

  async saveNickname() {
    const nickname = (this.data.draftNickname || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none', duration: 1800 });
      return;
    }

    this.setData({ saving: true });
    try {
      await holdAccount.updateProfile({ nickname });
      this.setData({ editing: false, draftNickname: '' });
      wx.showToast({ title: '已保存', icon: 'success', duration: 1500 });
    } catch (error) {
      wx.showToast({
        title: (error && error.message) || '保存失败',
        icon: 'none',
        duration: 2200
      });
    } finally {
      this.setData({ saving: false });
    }
  },

  async onChooseAvatar(event) {
    const avatarUrl = event.detail && event.detail.avatarUrl ? event.detail.avatarUrl : '';
    if (!avatarUrl) {
      return;
    }

    // 先本地回显，再把临时文件交给云函数转存到云存储
    this.setData({ avatarUrl });
    wx.showLoading({ title: '上传头像', mask: true });

    try {
      await holdAccount.updateProfile({ avatarUrl });
      wx.hideLoading();
      wx.showToast({ title: '头像已更新', icon: 'success', duration: 1500 });
    } catch (error) {
      wx.hideLoading();
      wx.showToast({
        title: (error && error.message) || '头像上传失败',
        icon: 'none',
        duration: 2200
      });
    }
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后本机将回到未登录状态，云端记录不会删除，重新登录即可恢复。',
      confirmColor: '#2F5D3A',
      success: (result) => {
        if (!result.confirm) {
          return;
        }
        holdAccount.logout();
        wx.showToast({ title: '已退出登录', icon: 'success', duration: 1600 });
      }
    });
  },

  openDebugPage() {
    wx.navigateTo({ url: '/pages/debug/index' });
  }
});
