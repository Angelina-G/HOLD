const { getMeasurementById } = require('../../utils/mock-health-data');

Page({
  data: {
    report: null
  },

  onLoad(options) {
    this.reportId = options.id;
    this.refreshReport();
  },

  onShow() {
    this.refreshReport();
    this.refreshTimer = setInterval(() => this.refreshReport(), 1000);
  },

  onHide() {
    clearInterval(this.refreshTimer);
  },

  onUnload() {
    clearInterval(this.refreshTimer);
  },

  refreshReport() {
    this.setData({ report: getMeasurementById(this.reportId) });
  },

  backToHistory() {
    wx.redirectTo({ url: '/pages/active-history/index' });
  }
});
