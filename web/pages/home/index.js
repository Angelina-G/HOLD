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

    const payload = cached.payload;
    const heartRate = Number(payload.hr || payload.heart_rate_bpm || 0);
    const respiration = Number(payload.br || payload.respiration_bpm || 0);
    const latestMeasurement = JSON.parse(JSON.stringify(this.data.latestMeasurement));
    const latestDaily = Object.assign({}, this.data.latestDaily);

    latestMeasurement.resultTag = heartRate > 0 ? '实时采集中' : '等待有效 PPG';
    latestMeasurement.startedAt = new Date(cached.receivedAt).toLocaleString();
    if (latestMeasurement.metrics && latestMeasurement.metrics[0] && heartRate > 0) {
      latestMeasurement.metrics[0].value = heartRate.toFixed(0);
    }
    if (heartRate > 0) {
      latestDaily.heartRateAvg = heartRate.toFixed(0);
    }
    if (respiration > 0) {
      latestDaily.respirationAvg = respiration.toFixed(0);
    }

    this.setData({ latestMeasurement, latestDaily });
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
