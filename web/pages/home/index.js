const {
  homeOverview,
  getLatestMeasurement,
  getLatestDailyAnalysis
} = require('../../utils/mock-health-data');

Page({
  data: {
    latestMeasurement: {},
    latestDaily: {},
    homeOverview: {},
    readinessRing: 0,
    trendMax: 100
  },

  onLoad() {
    const latestMeasurement = getLatestMeasurement();
    const latestDaily = getLatestDailyAnalysis();
    const readinessRing = Math.max(0, Math.min(100, homeOverview.readinessScore || 0));

    this.setData({
      latestMeasurement,
      latestDaily,
      homeOverview,
      readinessRing
    });
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
    const cached = wx.getStorageSync('hold_latest_telemetry');
    if (!cached || !cached.payload || Date.now() - cached.receivedAt > 10000) {
      return;
    }

    this.setData({
      latestMeasurement: getLatestMeasurement(),
      latestDaily: getLatestDailyAnalysis()
    });
  },

  openActiveHistory() {
    wx.navigateTo({ url: '/pages/active-history/index' });
  },

  openLatestReport() {
    const latestMeasurement = this.data.latestMeasurement || {};
    if (!latestMeasurement.id) {
      return;
    }

    wx.navigateTo({
      url: `/pages/active-report/index?id=${latestMeasurement.id}`
    });
  },

  openDailyAnalysis() {
    wx.navigateTo({ url: '/pages/daily-analysis/index' });
  },

  openDebugPage() {
    wx.navigateTo({ url: '/pages/index/index' });
  }
});
