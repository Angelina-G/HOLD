const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

let page;
let cached;
const storage = {};
const context = {
  Page(config) {
    page = config;
  },
  wx: {
    onBLECharacteristicValueChange() {},
    onBluetoothDeviceFound() {},
    setStorageSync(key, value) {
      storage[key] = value;
      if (key === 'hold_latest_telemetry') cached = value;
    },
    getStorageSync(key) {
      return storage[key];
    }
  },
  console,
  ArrayBuffer,
  Uint8Array,
  Date,
  JSON,
  Number,
  Boolean,
  String,
  setTimeout
};

vm.runInNewContext(fs.readFileSync('web/pages/index/index.js', 'utf8'), context);
page.setData = function setData(update) {
  Object.assign(this.data, update);
};
page.notifyBuffer = '';

function feed(payload) {
  const text = JSON.stringify(payload);
  for (let offset = 0; offset < text.length; offset += 18) {
    const bytes = Uint8Array.from(Buffer.from(text.slice(offset, offset + 18)));
    page.handleNotifyMessage({ value: bytes.buffer });
  }
}

feed({ t: 'tel', pp: 1, p57: 1, mr: 1, ir: 123, red: 456, pr: 0, pl: 0, hp: 1, wear: 1 });
assert.strictEqual(cached.payload.ir, 123);
assert.ok(!page.data.signalStatus.includes('缺少'));

feed({ t: 'tel', pp: 0, p57: 0, pe: 'part-id-read-failed', mr: 0, mo: 'imu-miss', pr: 1, hp: 1, wear: 1 });
assert.ok(page.data.signalStatus.includes('PPG（D4/D5 I2C 未响应）'));
assert.ok(page.data.signalStatus.includes('运动'));

storage.hold_telemetry_samples[storage.hold_telemetry_samples.length - 1].receivedAt -= 1001;
feed({ t: 'tel', pp: 1, p57: 1, mr: 1, ir: 123, red: 456, hr: 72, br: 14, pr: 1, hp: 1, wear: 1 });
let homePage;
vm.runInNewContext(fs.readFileSync('web/pages/home/index.js', 'utf8'), {
  Page(config) {
    homePage = config;
  },
  require() {
    return {
      homeOverview: { readinessScore: 80 },
      getLatestMeasurement() {
        return { metrics: [{ value: '0' }] };
      },
      getLatestDailyAnalysis() {
        return { heartRateAvg: 0, respirationAvg: 0 };
      }
    };
  },
  wx: {
    getStorageSync() {
      return cached;
    }
  },
  Date,
  JSON,
  Number,
  Object,
  Math,
  clearInterval,
  setInterval
});
homePage.setData = function setData(update) {
  Object.assign(this.data, update);
};
homePage.data.latestMeasurement = { metrics: [{ value: '0' }] };
homePage.data.latestDaily = { heartRateAvg: 0, respirationAvg: 0 };
homePage.refreshLiveTelemetry();
assert.strictEqual(homePage.data.latestMeasurement.metrics[0].value, '72');
assert.strictEqual(homePage.data.latestDaily.respirationAvg, '14');

global.wx = { getStorageSync: (key) => storage[key] };
const healthData = require('../utils/mock-health-data');
assert.strictEqual(healthData.getMeasurements()[0].id, 'live-latest');
assert.strictEqual(healthData.getLatestDailyAnalysis().heartRateAvg, '72');
delete global.wx;

console.log('BLE notify smoke test passed');
