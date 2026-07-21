const assert = require('assert');

const storage = {};
global.wx = {
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => { storage[key] = value; }
};

const health = require('../utils/mock-health-data');

function tel(receivedAt, payload) {
  return {
    receivedAt,
    sessionId: 'summary-session',
    payload: Object.assign({
      t: 'tel',
      pp: 1,
      p57: 1,
      ct: 1,
      mr: 1,
      mo: 'still',
      ps: 1,
      hp: 1,
      wear: 1
    }, payload)
  };
}

const base = Date.now() - 12000;
storage.hold_telemetry_samples = Array.from({ length: 12 }, (_, index) => tel(base + index * 1000, {
  seq: index + 1,
  hr: 70 + (index % 3),
  br: 13 + (index % 2),
  ir: 200000 + index * 120,
  red: 170000 + index * 90,
  pr: 900 + index,
  bt: 37 + index * 0.01
}));
storage.hold_wave_samples = storage.hold_telemetry_samples.map((sample) => ({
  receivedAt: sample.receivedAt,
  sessionId: sample.sessionId,
  source: 'ppg',
  value: sample.payload.ir
}));

const measurement = health.getLatestMeasurement();
const metrics = Object.fromEntries(measurement.metrics.map((metric) => [metric.label, metric.value]));

assert.equal(measurement.resultTag, 'PPG 实时数据');
assert.equal(measurement.waveformSource, 'PPG 红外真实波形');
assert.equal(measurement.waveformMoments.length, 6);
assert.equal(metrics['平均心率'], '71');
assert.equal(metrics['平均呼吸'], '14');
assert.equal(metrics['信号质量'], '良好');
assert.equal(metrics['PPG 红外'], '200660');
assert.equal(metrics['PPG 红光'], '170495');
assert.equal(metrics['压力等级'], '2');

const daily = health.getLatestDailyAnalysis();
assert.equal(daily.heartRateAvg, '71');
assert.equal(daily.respirationAvg, '14');
assert.equal(daily.stabilityScore, 100);
assert.equal(daily.heartRateBars.length, 7);
assert.equal(daily.respirationBars.length, 7);

const overview = health.getHomeOverview();
assert.equal(overview.readinessScore, 100);
assert.ok(overview.trendSeries.length > 0);

const archived = health.archiveLatestMeasurement(base + 9000);
assert.ok(archived.id.startsWith('hold-'));
assert.equal(storage.hold_measurement_records.length, 1);
assert.equal(archived.comparison.ready, true);

storage.hold_telemetry_samples = [];
storage.hold_measurement_records = [];
assert.equal(health.getLatestMeasurement().resultTag, '等待真实数据');
assert.equal(health.getLatestDailyAnalysis().heartRateAvg, '--');

delete global.wx;
console.log('github summary health smoke: ok');
