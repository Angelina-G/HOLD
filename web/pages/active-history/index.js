const { getMeasurements } = require('../../utils/mock-health-data');

Page({
  data: {
    activeMeasurements: []
  },

  onLoad() {
    this.refreshRecords();
  },

  onShow() {
    this.refreshRecords();
    this.refreshTimer = setInterval(() => this.refreshRecords(), 1000);
  },

  onHide() {
    clearInterval(this.refreshTimer);
  },

  onUnload() {
    clearInterval(this.refreshTimer);
  },

  refreshRecords() {
    this.setData({ activeMeasurements: getMeasurements() });
  },

  openReport(event) {
    const { id } = event.currentTarget.dataset;
    if (!id) {
      return;
    }

    wx.navigateTo({
      url: `/pages/active-report/index?id=${id}`
    });
  }
});
