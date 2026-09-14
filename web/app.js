const holdBleRuntime = require('./utils/hold-ble-runtime');
const holdAccount = require('./utils/hold-account');

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库不支持云开发');
      return;
    }

    wx.cloud.init({
      traceUser: true,
      env: 'hold-dev-env-d2gukfp01ac296189'
    });

    // 静默登录：首登自动建号，已登录则只刷新最近登录时间。
    // 失败不阻断启动，未登录时按设备共享读取，仍能看到设备已归档的数据。
    holdAccount.login().catch((error) => {
      console.warn('静默登录未完成', error && error.message ? error.message : error);
    });

    holdBleRuntime.init();
  },

  onHide() {
    // 进入后台前把防抖队列里没发出去的云端写入立即落库
    holdBleRuntime.flushCloudWrites();
  },

  globalData: {
    bleRuntime: holdBleRuntime,
    account: holdAccount
  }
});
