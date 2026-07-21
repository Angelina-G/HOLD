const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

let page;
let cached;
let bleNotifyHandler;
let archiveCount = 0;
const storage = {};
const app = { globalData: {} };

const context = {
  Page(config) { page = config; },
  require() {
    return { archiveLatestMeasurement() { archiveCount += 1; } };
  },
  wx: {
    onBLECharacteristicValueChange(handler) { bleNotifyHandler = handler; },
    onBLEConnectionStateChange() {},
    onBluetoothDeviceFound() {},
    stopBluetoothDevicesDiscovery(options) { if (options && options.complete) options.complete(); },
    setStorageSync(key, value) {
      storage[key] = value;
      if (key === 'hold_latest_telemetry') cached = value;
    },
    getStorageSync(key) { return storage[key]; }
  },
  getApp() { return app; },
  console,
  ArrayBuffer,
  Uint8Array,
  Date,
  JSON,
  Number,
  Boolean,
  String,
  setTimeout() {},
  clearTimeout() {}
};

vm.runInNewContext(fs.readFileSync('web/pages/index/index.js', 'utf8'), context);
page.setData = function setData(update) {
  Object.assign(this.data, update);
};
page.onLoad();

function feed(payload) {
  const text = JSON.stringify(payload);
  for (let offset = 0; offset < text.length; offset += 18) {
    const bytes = Uint8Array.from(Buffer.from(text.slice(offset, offset + 18)));
    bleNotifyHandler({ value: bytes.buffer });
  }
}

function feedWave(ir, pressure) {
  const bytes = Uint8Array.from(Buffer.from(`W,${ir},${pressure}`));
  bleNotifyHandler({ value: bytes.buffer });
}

const first = Date.now();
for (let index = 0; index < 8; index += 1) {
  feed({
    t: 'tel',
    seq: index + 1,
    pp: 1,
    p57: 1,
    ct: 1,
    mr: 1,
    mo: 'still',
    ps: 1,
    hp: 1,
    wear: 1,
    hr: 72 + (index % 2),
    br: 14,
    bs: 'imu',
    ir: 123000 + index * 100,
    red: 45600 + index * 80,
    pr: 860 + index,
    bt: 36.8
  });
}

assert.equal(cached.payload.ir, 123700);
assert.ok(storage.hold_telemetry_samples.length >= 1);
assert.equal(page.data.storagePath, 'hold_telemetry_samples');

feedWave(321000, 17);
assert.equal(app.globalData.liveWave.value, 321000);
assert.ok(app.globalData.liveWave.points.length > 0);
assert.ok(storage.hold_wave_samples.length > 0);

feed({ t: 'b_start', mode: 'timed' });
feed({ t: 'b_stop', reason: 'user' });
assert.equal(archiveCount, 1);
assert.ok(storage.hold_telemetry_samples.some((sample) => sample.payload.t === 'b_start'));
assert.ok(storage.hold_telemetry_samples.some((sample) => sample.payload.t === 'b_stop'));

page.data.calibrationRunning = true;
feed({ t: 'cal_done', cg: 0, cc: 1, pp: 0, p57: 0, mr: 1, ps: 1, hp: 1, wear: 0 });
assert.equal(page.data.calibrationRunning, false);
assert.ok(page.data.signalStatus.includes('校准已结束'));
assert.ok(page.data.signalStatus.includes('PPG'));

page.pageVisible = false;
feed({ t: 'tel', seq: 99, pp: 1, mr: 1, mo: 'still', ps: 1, hp: 1, wear: 1, hr: 73, br: 14, ir: 124000, red: 46000, pr: 900 });
assert.equal(cached.payload.seq, 99);
page.onUnload();

const summaryBase = Date.now() - 12000;
storage.hold_telemetry_samples = Array.from({ length: 8 }, (_, index) => ({
  receivedAt: summaryBase + index * 1000,
  sessionId: 'summary-session',
  payload: {
    t: 'tel',
    seq: index + 1,
    pp: 1,
    p57: 1,
    ct: 1,
    mr: 1,
    mo: 'still',
    ps: 1,
    hp: 1,
    wear: 1,
    hr: 72 + (index % 2),
    br: 14,
    ir: 123000 + index * 100,
    red: 45600 + index * 80,
    pr: 860 + index,
    bt: 36.8
  }
}));
storage.hold_wave_samples = storage.hold_telemetry_samples.map((sample) => ({
  receivedAt: sample.receivedAt,
  sessionId: sample.sessionId,
  source: 'ppg',
  value: sample.payload.ir
}));

global.wx = { getStorageSync: (key) => storage[key], setStorageSync: (key, value) => { storage[key] = value; } };
const healthData = require('../utils/mock-health-data');
const latestMeasurement = healthData.getLatestMeasurement();
const metricMap = Object.fromEntries(latestMeasurement.metrics.map((metric) => [metric.label, metric.value]));
assert.ok(latestMeasurement.id.startsWith('hold-live-'));
assert.equal(metricMap['平均心率'], '73');
assert.equal(metricMap['平均呼吸'], '14');
assert.equal(metricMap['PPG 红外'], '123350');
assert.equal(metricMap['PPG 红光'], '45880');
assert.equal(metricMap['压力等级'], '2');
assert.equal(latestMeasurement.waveformMoments.length, 6);
assert.equal(healthData.getLatestDailyAnalysis().heartRateAvg, '73');
assert.equal(healthData.getLatestDailyAnalysis().respirationAvg, '14');

delete global.wx;
console.log('BLE notify GitHub summary smoke: ok');
