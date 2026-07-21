const TELEMETRY_KEY = 'hold_telemetry_samples';
const RECORDS_KEY = 'hold_measurement_records';
const WAVE_KEY = 'hold_wave_samples';
const SESSION_GAP_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;

const demoMeasurements = [
  {
    id: 'ppg-demo-001',
    title: 'HOLD 实时采集记录',
    startedAt: '--',
    durationLabel: '--',
    resultTag: '等待真实数据',
    summary: '连接设备后，这里会按 GitHub 最新版的摘要结构显示真实遥测。',
    metrics: [
      { label: '平均心率', value: '--', unit: 'bpm' },
      { label: '平均呼吸', value: '--', unit: '次/分' },
      { label: '信号质量', value: '等待', unit: '' }
    ],
    waveformSource: '等待实时波形',
    waveformMoments: emptyBars(6),
    readiness: { ppg: false, imu: false, pressure: false, haptic: false },
    comparison: pendingComparison(),
    reportSections: [
      { heading: '链路状态', text: '还没有可用于报告的真实遥测。' },
      { heading: '建议', text: '先进入调试页连接设备，再保持稳定佩戴。' }
    ]
  }
];

function storage(key, fallback) {
  if (typeof wx === 'undefined' || !wx.getStorageSync) return fallback;
  try {
    const value = wx.getStorageSync(key);
    return value || fallback;
  } catch (error) {
    return fallback;
  }
}

function save(key, value) {
  if (typeof wx === 'undefined' || !wx.setStorageSync) return;
  try {
    wx.setStorageSync(key, value);
  } catch (error) {}
}

function now() {
  return Date.now();
}

function asMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : now();
}

function formatDate(ms) {
  if (!ms) return '--';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDay(ms) {
  const date = new Date(ms || now());
  return `${date.getMonth() + 1}-${date.getDate()}`;
}

function payloadOf(sample) {
  if (!sample) return {};
  return sample.payload || sample;
}

function sampleTime(sample) {
  return asMs(sample && (sample.receivedAt || sample.ts || sample.time));
}

function telemetrySamples() {
  const samples = storage(TELEMETRY_KEY, []);
  return Array.isArray(samples) ? samples.filter(Boolean) : [];
}

function waveSamples() {
  const samples = storage(WAVE_KEY, []);
  return Array.isArray(samples) ? samples.filter(Boolean) : [];
}

function storedRecords() {
  const records = storage(RECORDS_KEY, []);
  return Array.isArray(records) ? records.filter(Boolean) : [];
}

function numberFrom(sample, key) {
  const value = Number(payloadOf(sample)[key]);
  return Number.isFinite(value) ? value : null;
}

function values(samples, key, min, max) {
  return samples
    .map((sample) => numberFrom(sample, key))
    .filter((value) => value !== null && value >= min && value <= max);
}

function average(list) {
  if (!list.length) return null;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function displayNumber(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--';
  const number = Number(value);
  return digits ? number.toFixed(digits) : String(Math.round(number));
}

function lastPayload(samples) {
  return payloadOf(samples[samples.length - 1]);
}

function latestSession(samples) {
  if (!samples.length) return [];
  const sorted = samples.slice().sort((a, b) => sampleTime(a) - sampleTime(b));
  const tail = [sorted[sorted.length - 1]];
  for (let index = sorted.length - 2; index >= 0; index -= 1) {
    const previous = tail[0];
    if (sampleTime(previous) - sampleTime(sorted[index]) > SESSION_GAP_MS) break;
    tail.unshift(sorted[index]);
  }
  return tail;
}

function emptyBars(count) {
  return Array.from({ length: count }, (_, index) => ({ label: index === 0 ? '开始' : index === count - 1 ? '当前' : `${index}`, value: 36 }));
}

function bucketAverages(list, count) {
  if (!list.length) return [];
  if (list.length <= count) return list.slice();
  const buckets = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * list.length / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * list.length / count));
    buckets.push(average(list.slice(start, end)));
  }
  return buckets;
}

function normalizeHeights(list, minHeight, maxHeight) {
  if (!list.length) return [];
  const min = Math.min.apply(null, list);
  const max = Math.max.apply(null, list);
  const range = Math.max(max - min, 1);
  return list.map((value) => Math.round(minHeight + (value - min) * (maxHeight - minHeight) / range));
}

function barsFromValues(list, count) {
  const bucketed = bucketAverages(list, count);
  const heights = normalizeHeights(bucketed, 32, 88);
  const labels = count === 6 ? ['开始', '20秒', '40秒', '60秒', '80秒', '当前'] : [];
  return Array.from({ length: count }, (_, index) => ({
    label: labels[index] || `${index + 1}`,
    value: heights[index] || 36
  }));
}

function simpleHeightArray(list, count) {
  const bucketed = bucketAverages(list, count);
  const heights = normalizeHeights(bucketed, 34, 78);
  return Array.from({ length: count }, (_, index) => heights[index] || 38);
}

function waveValues(samples) {
  const recentStart = samples.length ? sampleTime(samples[0]) - 1000 : now() - DAY_MS;
  const recentEnd = samples.length ? sampleTime(samples[samples.length - 1]) + 1000 : now();
  const ppgWaves = waveSamples()
    .filter((item) => sampleTime(item) >= recentStart && sampleTime(item) <= recentEnd)
    .filter((item) => item.source === 'ppg' && Number.isFinite(Number(item.value)))
    .map((item) => Number(item.value));
  if (ppgWaves.length >= 4) return { source: 'PPG 红外真实波形', list: ppgWaves };

  const ir = values(samples, 'ir', 1, 1000000);
  if (ir.length >= 4) return { source: 'PPG 红外真实波形', list: ir };

  const pressure = values(samples, 'pr', 1, 4095);
  if (pressure.length >= 4) return { source: '压力真实波形', list: pressure };

  return { source: '等待实时波形', list: [] };
}

function readinessFrom(samples) {
  const latest = lastPayload(samples);
  return {
    ppg: Number(latest.pp || 0) === 1 || Number(latest.ir || 0) > 0 || Number(latest.red || 0) > 0,
    imu: Number(latest.mr || 0) === 1 || String(latest.mo || '') === 'still',
    pressure: Number(latest.ps || 0) === 1 || Number(latest.pr || 0) > 0,
    haptic: Number(latest.hp || 0) === 1 || String(latest.haptic || '').toLowerCase() === 'ok'
  };
}

function readinessScore(readiness) {
  const keys = ['ppg', 'imu', 'pressure', 'haptic'];
  return Math.round(keys.filter((key) => readiness[key]).length * 100 / keys.length);
}

function qualityLabel(readiness, hrAvg) {
  const score = readinessScore(readiness);
  if (hrAvg === null) return '等待心率';
  if (score >= 75) return '良好';
  if (score >= 50) return '可用';
  return '需复测';
}

function pendingComparison() {
  return {
    ready: false,
    tone: 'neutral',
    stateLabel: '等待完成一次引导',
    verdict: '开始并结束一次呼吸引导后，这里会自动比较使用前后。',
    hasCompositeScore: false
  };
}

function buildComparison(samples, stopReceivedAt) {
  const stopAt = Number(stopReceivedAt || 0);
  if (!stopAt || samples.length < 8) return pendingComparison();
  const before = samples.filter((sample) => sampleTime(sample) < stopAt);
  const after = samples.filter((sample) => sampleTime(sample) >= stopAt);
  const beforeHr = average(values(before, 'hr', 35, 220));
  const afterHr = average(values(after, 'hr', 35, 220));
  const beforeBr = average(values(before, 'br', 6, 45));
  const afterBr = average(values(after, 'br', 6, 45));
  const ready = before.length >= 3 && after.length >= 3 && (beforeHr !== null || beforeBr !== null) && (afterHr !== null || afterBr !== null);
  if (!ready) return pendingComparison();

  const hrDelta = beforeHr !== null && afterHr !== null ? afterHr - beforeHr : null;
  const brDelta = beforeBr !== null && afterBr !== null ? afterBr - beforeBr : null;
  const score = Math.max(0, Math.min(100, Math.round(70 - Math.max(0, hrDelta || 0) * 2 - Math.max(0, brDelta || 0) * 2 + Math.max(0, -(hrDelta || 0)) * 1.5)));
  const peace = (hrDelta === null || hrDelta <= 2) && (brDelta === null || brDelta <= 1);
  return {
    ready: true,
    tone: peace ? 'peace' : 'warm',
    stateLabel: peace ? '引导后更平稳' : '引导后仍需观察',
    score,
    hasCompositeScore: true,
    beforeHr: displayNumber(beforeHr),
    afterHr: displayNumber(afterHr),
    beforeBr: displayNumber(beforeBr),
    afterBr: displayNumber(afterBr),
    hrDeltaLabel: hrDelta === null ? '--' : `${hrDelta > 0 ? '+' : ''}${Math.round(hrDelta)}`,
    brDeltaLabel: brDelta === null ? '--' : `${brDelta > 0 ? '+' : ''}${Math.round(brDelta)}`,
    confidenceLabel: `样本 ${before.length + after.length} 条`,
    validSampleLabel: '按 GitHub 摘要口径',
    verdict: peace ? '本次引导后心率或呼吸没有继续升高，可作为一次有效体验样本。' : '本次引导后指标仍有起伏，建议稳定佩戴后再测一次。'
  };
}

function titleFrom(samples) {
  const latest = lastPayload(samples);
  if (typeof wx !== 'undefined' && wx.getStorageSync && wx.getStorageSync('hold_ppg_mode') === 'finger') return '指部 PPG 主动检测';
  if (Number(latest.wear || 0) === 1) return 'HOLD 实时采集记录';
  return 'HOLD 遥测记录';
}

function buildMeasurement(samples, options) {
  const safeSamples = samples && samples.length ? samples : [];
  if (!safeSamples.length) return demoMeasurements[0];
  const startedAtMs = sampleTime(safeSamples[0]);
  const endedAtMs = sampleTime(safeSamples[safeSamples.length - 1]);
  const durationSeconds = Math.max(1, Math.round((endedAtMs - startedAtMs) / 1000));
  const hrAvg = average(values(safeSamples, 'hr', 35, 220));
  const brAvg = average(values(safeSamples, 'br', 6, 45));
  const irAvg = average(values(safeSamples, 'ir', 1, 1000000));
  const redAvg = average(values(safeSamples, 'red', 1, 1000000));
  const prAvg = average(values(safeSamples, 'pr', 0, 4095));
  const tempAvg = average(values(safeSamples, 'bt', 20, 60));
  const latest = lastPayload(safeSamples);
  const readiness = readinessFrom(safeSamples);
  const score = readinessScore(readiness);
  const wave = waveValues(safeSamples);
  const comparison = buildComparison(safeSamples, options && options.stopReceivedAt);
  const resultTag = hrAvg !== null || brAvg !== null || wave.list.length ? 'PPG 实时数据' : '暂无真实数据';

  return {
    id: options && options.id ? options.id : `hold-live-${startedAtMs}`,
    title: titleFrom(safeSamples),
    startedAt: formatDate(startedAtMs),
    startedAtMs,
    endedAtMs,
    durationLabel: `${durationSeconds} 秒`,
    resultTag,
    summary: score >= 75
      ? '已收到真实遥测：PPG、IMU、压力、震动。'
      : '已收到部分真实遥测，建议减少移动并检查贴合。',
    metrics: [
      { label: '平均心率', value: displayNumber(hrAvg), unit: 'bpm' },
      { label: '平均呼吸', value: displayNumber(brAvg), unit: '次/分' },
      { label: '信号质量', value: qualityLabel(readiness, hrAvg), unit: '' },
      { label: 'PPG 红外', value: displayNumber(irAvg), unit: '' },
      { label: 'PPG 红光', value: displayNumber(redAvg), unit: '' },
      { label: '压力等级', value: displayNumber(prAvg === null ? null : Math.round(prAvg / 409.5)), unit: '/10' },
      { label: '设备温度', value: displayNumber(tempAvg, 1), unit: '°C' },
      { label: '佩戴状态', value: Number(latest.wear || 0) === 1 ? '已佩戴' : '未确认', unit: '' }
    ],
    waveformSource: wave.source,
    waveformMoments: wave.list.length ? barsFromValues(wave.list, 6) : emptyBars(6),
    readiness,
    comparison,
    reportSections: [
      { heading: '链路状态', text: `最近收到序号 ${latest.seq || '--'} 的硬件遥测。` },
      { heading: '传感器状态', text: `PPG ${readiness.ppg ? '就绪' : '未就绪'} · IMU ${readiness.imu ? '就绪' : '未就绪'} · 压力 ${readiness.pressure ? '就绪' : '未就绪'} · 震动 ${readiness.haptic ? '就绪' : '未就绪'}` },
      { heading: '建议', text: hrAvg === null ? 'PPG 有原始波形但心率尚不稳定，先固定传感器并保持 20 秒。' : '当前数据已经可以进入展示和报告链路。' }
    ]
  };
}

function liveMeasurement() {
  return buildMeasurement(latestSession(telemetrySamples()));
}

function getMeasurements() {
  const live = liveMeasurement();
  const records = storedRecords();
  if (live.id === demoMeasurements[0].id) return records.length ? records : demoMeasurements;
  const withoutDuplicate = records.filter((record) => record.id !== live.id);
  return [live].concat(withoutDuplicate).slice(0, 20);
}

function getLatestMeasurement() {
  return getMeasurements()[0];
}

function getMeasurementById(id) {
  return getMeasurements().find((item) => item.id === id) || getLatestMeasurement();
}

function buildDailyAnalysis(samples) {
  const hrValues = values(samples, 'hr', 35, 220);
  const brValues = values(samples, 'br', 6, 45);
  const readiness = readinessFrom(samples);
  const score = samples.length ? readinessScore(readiness) : '--';
  const hrAvg = average(hrValues);
  const brAvg = average(brValues);
  const anxious = (hrAvg !== null && hrAvg >= 92) || (brAvg !== null && brAvg >= 19);
  const peace = (hrAvg !== null && hrAvg >= 50 && hrAvg <= 82) && (brAvg !== null && brAvg >= 8 && brAvg <= 16);
  return {
    day: formatDay(sampleTime(samples[0] || {})),
    title: '今日实时',
    respirationAvg: displayNumber(brAvg),
    heartRateAvg: displayNumber(hrAvg),
    stabilityScore: score,
    alertCount: anxious ? 1 : 0,
    insight: samples.length
      ? (peace ? '心率和呼吸落在较平稳区间，适合继续记录一段安静样本。' : anxious ? '心率或呼吸偏快，建议先做一次慢呼吸引导后再对比。' : '实时遥测已同步，继续稳定佩戴会提高趋势可靠性。')
      : '连接设备后，这里会显示实时心率、呼吸和趋势。',
    respirationBars: simpleHeightArray(brValues, 7),
    heartRateBars: simpleHeightArray(hrValues, 7),
    comparison: getLatestMeasurement().comparison || pendingComparison(),
    timeline: [
      { time: '现在', label: samples.length ? '实时遥测同步' : '等待设备连接', tone: samples.length ? 'strong' : 'soft' },
      { time: '建议', label: '保持传感器贴合', tone: 'warm' }
    ]
  };
}

function getDailyAnalyses() {
  const samples = telemetrySamples().filter((sample) => now() - sampleTime(sample) < DAY_MS);
  return [buildDailyAnalysis(samples.length ? samples : latestSession(telemetrySamples()))];
}

function getLatestDailyAnalysis() {
  return getDailyAnalyses()[0];
}

function archiveLatestMeasurement(stopReceivedAt) {
  const samples = latestSession(telemetrySamples());
  if (!samples.length) return null;
  const measurement = buildMeasurement(samples, {
    id: `hold-${now()}`,
    stopReceivedAt
  });
  const records = [measurement].concat(storedRecords().filter((item) => item.id !== measurement.id)).slice(0, 20);
  save(RECORDS_KEY, records);
  return measurement;
}

function getHomeOverview() {
  const latest = getLatestDailyAnalysis();
  return {
    recentAdviceTitle: '近期综合建议',
    recentAdvice: latest.stabilityScore === '--'
      ? '连接设备后，首页会优先显示真实遥测。'
      : Number(latest.stabilityScore) >= 75 ? '当前链路较完整，可以做一次引导前后对比。' : '先固定传感器贴合，再开始正式测试。',
    recommendationBullets: ['胸口 PPG 默认常开', '指部 PPG 长按 3 秒开始', '报告只做体验趋势，不做医学诊断'],
    readinessScore: latest.stabilityScore,
    trendSeries: latest.heartRateBars || []
  };
}

const homeOverview = getHomeOverview();

module.exports = {
  activeMeasurements: demoMeasurements,
  dailyAnalyses: [],
  homeOverview,
  getHomeOverview,
  getMeasurements,
  getDailyAnalyses,
  getLatestMeasurement,
  getMeasurementById,
  getLatestDailyAnalysis,
  archiveLatestMeasurement
};
