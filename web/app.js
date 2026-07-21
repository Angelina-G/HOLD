App({
  globalData: {
    bleSession: null,
    liveWave: null
  },

  onLaunch() {
    const storageSchemaVersion = 2;
    if (wx.getStorageSync('hold_storage_schema_version') !== storageSchemaVersion) {
      ['hold_latest_telemetry', 'hold_telemetry_samples', 'hold_wave_samples',
        'hold_measurement_records', 'hold_pending_intervention_stop', 'hold_ble_session_id']
        .forEach((key) => wx.removeStorageSync(key));
      wx.setStorageSync('hold_storage_schema_version', storageSchemaVersion);
    }

    if (!wx.cloud) {
      console.error('当前基础库不支持云开发');
      return;
    }

    wx.cloud.init({
      traceUser: true,
      env: 'hold-dev-env-d2gukfp01ac296189'
    });
  }
});
