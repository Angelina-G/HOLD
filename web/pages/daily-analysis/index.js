const { getDailyAnalyses } = require('../../utils/mock-health-data');

Page({
  data: {
    dailyAnalyses: [],
    activeIndex: 0,
    activeDay: null
  },

  onLoad() {
    this.refreshAnalysis();
  },

  onShow() {
    clearInterval(this.liveTimer);
    this.refreshAnalysis();
    this.liveTimer = setInterval(this.refreshAnalysis.bind(this), 1000);
  },

  onHide() {
    clearInterval(this.liveTimer);
  },

  onUnload() {
    clearInterval(this.liveTimer);
  },

  refreshAnalysis() {
    const dailyAnalyses = getDailyAnalyses();
    const activeIndex = Math.min(this.data.activeIndex, Math.max(0, dailyAnalyses.length - 1));
    this.setData({
      dailyAnalyses,
      activeIndex,
      activeDay: dailyAnalyses[activeIndex]
    });
  },

  switchDay(event) {
    const index = Number(event.currentTarget.dataset.index || 0);
    const activeDay = this.data.dailyAnalyses[index] || this.data.dailyAnalyses[0];
    this.setData({
      activeIndex: index,
      activeDay
    });
  }
});
