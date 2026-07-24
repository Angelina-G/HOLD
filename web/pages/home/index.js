const {
  getHomeOverview,
  getLatestMeasurement,
  getLatestDailyAnalysis
} = require('../../utils/mock-health-data');

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function zoneItems(active) {
  return [
    { key: 'low', label: '低能量', active: active === 'low' },
    { key: 'peace', label: '平静', active: active === 'peace' },
    { key: 'bright', label: '轻快', active: active === 'bright' },
    { key: 'anxious', label: '紧绷', active: active === 'anxious' }
  ];
}

function buildWellbeing(latestDaily) {
  const heartRate = asNumber(latestDaily && latestDaily.heartRateAvg);
  const respiration = asNumber(latestDaily && latestDaily.respirationAvg);
  const score = asNumber(latestDaily && latestDaily.stabilityScore);
  const anxious = (heartRate !== null && heartRate >= 92) || (respiration !== null && respiration >= 19);
  const low = heartRate !== null && heartRate < 55 && (respiration === null || respiration <= 14);
  const peace = heartRate !== null && heartRate >= 55 && heartRate <= 82 &&
    respiration !== null && respiration >= 10 && respiration <= 16;
  const active = anxious ? 'anxious' : low ? 'low' : peace ? 'peace' : heartRate !== null || respiration !== null ? 'bright' : 'neutral';
  return {
    tone: anxious ? 'anxious' : low ? 'low' : peace ? 'peace' : 'neutral',
    title: anxious ? '身体信号偏紧绷' : low ? '低能量观察中' : peace ? '现在比较平稳' : '正在形成判断',
    score: score === null ? '--' : score,
    copy: anxious
      ? '心率或呼吸偏快，先稳定贴合，跟随一次慢呼吸后再看前后变化。'
      : peace
        ? '心率和呼吸落在较平稳区间，适合继续记录一段安静样本。'
        : '继续稳定佩戴，系统会用同一套摘要口径更新趋势。',
    breathText: respiration === null ? '等待呼吸样本。' : `当前呼吸约 ${respiration} 次/分。`,
    zoneItems: zoneItems(active)
  };
}

function homeState() {
  const latestMeasurement = getLatestMeasurement() || {};
  const latestDaily = Object.assign({}, getLatestDailyAnalysis());
  const homeOverview = typeof getHomeOverview === 'function' ? getHomeOverview() : {
    readinessScore: '--',
    trendSeries: [],
    recentAdvice: '',
    recommendationBullets: []
  };
  if (latestMeasurement.endedAtMs &&
      new Date(latestMeasurement.endedAtMs).toDateString() === new Date().toDateString()) {
    latestDaily.comparison = latestMeasurement.comparison || latestDaily.comparison;
  }
  return {
    latestMeasurement,
    latestDaily,
    wellbeing: buildWellbeing(latestDaily),
    homeOverview,
    readinessRing: homeOverview.readinessScore === '--' ? '--' : Math.max(0, Math.min(100, Number(homeOverview.readinessScore)))
  };
}

Page({
  data: {
    latestMeasurement: {},
    latestDaily: {},
    wellbeing: {},
    homeOverview: {},
    readinessRing: 0,
    trendMax: 100
  },

  onLoad() {
    this.setData(homeState());
  },

  onShow() {
    clearInterval(this.liveTimer);
    this.refreshLiveTelemetry();
    this.liveTimer = setInterval(this.refreshLiveTelemetry.bind(this), 1000);
  },

  onHide() {
    clearInterval(this.liveTimer);
  },

  onUnload() {
    clearInterval(this.liveTimer);
  },

  refreshLiveTelemetry() {
    this.setData(homeState());
  },

  selectChestMode() {
    wx.setStorageSync('hold_ppg_mode', 'chest');
    wx.showToast({ title: '胸口 PPG 连续观察中', icon: 'none' });
  },

  openFingerMode() {
    wx.setStorageSync('hold_ppg_mode', 'finger');
    wx.navigateTo({ url: '/pages/user-test/index?mode=finger' });
  },

  openActiveHistory() {
    wx.navigateTo({ url: '/pages/active-history/index' });
  },

  openUserTest() {
    wx.navigateTo({ url: '/pages/user-test/index' });
  },

  openLatestReport() {
    const latestMeasurement = this.data.latestMeasurement || {};
    if (!latestMeasurement.id) return;
    wx.navigateTo({ url: `/pages/active-report/index?id=${latestMeasurement.id}` });
  },

  openDailyAnalysis() {
    wx.navigateTo({ url: '/pages/daily-analysis/index' });
  },

  openDebugPage() {
    wx.navigateTo({ url: '/pages/index/index' });
  }
});
