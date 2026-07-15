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
