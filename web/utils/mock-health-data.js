const activeMeasurements = [
  {
    id: 'ppg-20260625-001',
    title: '指部主动检测',
    startedAt: '2026-06-25 21:08',
    durationLabel: '68 秒',
    resultTag: '状态平稳',
    summary: '本次指部 PPG 检测节律较稳定，建议继续保持相同贴合方式复测。',
    metrics: [
      { label: '平均心率', value: '74', unit: 'bpm' },
      { label: '节律稳定度', value: '88', unit: '/100' },
      { label: '信号质量', value: '良好', unit: '' }
    ],
    waveformMoments: [
      { label: '启动', value: 32 },
      { label: '10秒', value: 68 },
      { label: '20秒', value: 82 },
      { label: '30秒', value: 74 },
      { label: '40秒', value: 86 },
      { label: '结束', value: 78 }
    ],
    reportSections: [
      {
        heading: '结果摘要',
        text: '本次主动检测已成功形成完整节律片段，当前趋势更适合作为基线样本，不提示明显异常。'
      },
      {
        heading: '参数观察',
        text: '心率均值处于日常静息区间，节律波动不大，信号质量较好，适合作为后续模型侧对照样本。'
      },
      {
        heading: '建议',
        text: '保持同一手指、同一按压方式和坐姿，再补一到两次同条件检测，可提升报告对比价值。'
      }
    ]
  },
  {
    id: 'ppg-20260624-002',
    title: '指部主动检测',
    startedAt: '2026-06-24 20:31',
    durationLabel: '61 秒',
    resultTag: '轻微波动',
    summary: '检测期间存在一次短暂姿态变化，结果可参考但不建议直接作为最佳基线。',
    metrics: [
      { label: '平均心率', value: '79', unit: 'bpm' },
      { label: '节律稳定度', value: '74', unit: '/100' },
      { label: '信号质量', value: '中等', unit: '' }
    ],
    waveformMoments: [
      { label: '启动', value: 28 },
      { label: '10秒', value: 58 },
      { label: '20秒', value: 62 },
      { label: '30秒', value: 51 },
      { label: '40秒', value: 69 },
      { label: '结束', value: 60 }
    ],
    reportSections: [
      {
        heading: '结果摘要',
        text: '本次检测可以用于回看波形与触发点，但中段存在短暂扰动，结论可信度弱于稳定测量。'
      },
      {
        heading: '参数观察',
        text: '节律总体可识别，但局部信号质量下降，建议结合原始波形一起看。'
      },
      {
        heading: '建议',
        text: '后续主动检测开始后尽量减少手指微动，并维持固定按压深度。'
      }
    ]
  },
  {
    id: 'ppg-20260623-003',
    title: '指部主动检测',
    startedAt: '2026-06-23 15:37',
    durationLabel: '60 秒',
    resultTag: '可作对照',
    summary: '这是一份较早的稳定手指数据，可继续作为胸口模式对比参考。',
    metrics: [
      { label: '平均心率', value: '72', unit: 'bpm' },
      { label: '节律稳定度', value: '83', unit: '/100' },
      { label: '信号质量', value: '良好', unit: '' }
    ],
    waveformMoments: [
      { label: '启动', value: 30 },
      { label: '10秒', value: 61 },
      { label: '20秒', value: 77 },
      { label: '30秒', value: 72 },
      { label: '40秒', value: 79 },
      { label: '结束', value: 76 }
    ],
    reportSections: [
      {
        heading: '结果摘要',
        text: '这次结果适合作为手指模式基础样本，用来对比后续参数迭代。'
      },
      {
        heading: '参数观察',
        text: '整体节律较稳定，波形完整，适合作为首轮展示结果。'
      },
      {
        heading: '建议',
        text: '后续可以继续在该口径下补不同时间段数据，形成更完整历史。'
      }
    ]
  }
];

const dailyAnalyses = [
  {
    day: '06-25',
    title: '今日分析',
    respirationAvg: 15,
    heartRateAvg: 76,
    stabilityScore: 84,
    alertCount: 1,
    insight: '呼吸节律平稳，心率位于常见静息区间，晚间检测信号质量优于白天。',
    respirationBars: [52, 58, 54, 61, 57, 63, 59],
    heartRateBars: [68, 71, 74, 76, 73, 78, 75],
    timeline: [
      { time: '09:00', label: '上午稳定', tone: 'soft' },
      { time: '14:20', label: '心率轻升', tone: 'warm' },
      { time: '21:10', label: '主动检测完成', tone: 'strong' }
    ]
  },
  {
    day: '06-24',
    title: '昨日分析',
    respirationAvg: 16,
    heartRateAvg: 79,
    stabilityScore: 71,
    alertCount: 2,
    insight: '白天存在姿态变化带来的局部波动，夜间段整体恢复稳定。',
    respirationBars: [48, 50, 62, 59, 55, 53, 57],
    heartRateBars: [72, 74, 83, 85, 80, 77, 76],
    timeline: [
      { time: '10:40', label: '呼吸波动', tone: 'warm' },
      { time: '16:30', label: '短时扰动', tone: 'warm' },
      { time: '20:31', label: '主动检测', tone: 'strong' }
    ]
  },
  {
    day: '06-23',
    title: '历史分析',
    respirationAvg: 15,
    heartRateAvg: 73,
    stabilityScore: 80,
    alertCount: 0,
    insight: '整日趋势平缓，适合作为近期对照日。',
    respirationBars: [51, 55, 57, 56, 58, 54, 52],
    heartRateBars: [69, 71, 73, 72, 74, 73, 70],
    timeline: [
      { time: '11:00', label: '节律稳定', tone: 'soft' },
      { time: '15:37', label: '手指样本采集', tone: 'strong' }
    ]
  }
];

const homeOverview = {
  recentAdviceTitle: '近期综合建议',
  recentAdvice: '最近三次测量中，指部主动检测稳定性持续优于胸口模式。建议在等待物料阶段优先积累更多同条件指部基线数据，同时保留每日呼吸与心率摘要，后续再将胸口模式纳入联合分析。',
  recommendationBullets: ['优先保留晚间稳定样本', '主动检测建议固定手指与按压方式', '胸口模式继续以算法摸底为主'],
  readinessScore: 82,
  trendSeries: [68, 72, 79, 76, 81, 84, 82]
};

function storedSamples() {
  if (typeof wx === 'undefined' || !wx.getStorageSync) {
    return [];
  }
  return wx.getStorageSync('hold_telemetry_samples') || [];
}

function positiveAverage(samples, key) {
  const values = samples.map((item) => Number(item.payload[key] || 0)).filter((value) => value > 0);
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function recentSamples() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return storedSamples().filter((item) => item && item.payload && item.receivedAt >= cutoff);
}

function currentSessionSamples() {
  const samples = recentSamples();
  let start = samples.length ? samples.length - 1 : 0;
  while (start > 0 && samples[start].receivedAt - samples[start - 1].receivedAt <= 10000) {
    start -= 1;
  }
  return samples.slice(start);
}

function chartMoments(samples) {
  if (!samples.length) {
    return [];
  }
  const indexes = [0, 1, 2, 3, 4, 5].map((step) => Math.min(samples.length - 1, Math.round(step * (samples.length - 1) / 5)));
  const values = indexes.map((index) => Number(samples[index].payload.ir || samples[index].payload.pr || 0));
  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  return values.map((value, index) => ({
    label: index === 0 ? '开始' : index === 5 ? '当前' : `${index * 10}秒`,
    value: max === min ? 50 : Math.round(30 + (value - min) * 60 / (max - min))
  }));
}

function buildLiveMeasurement() {
  const samples = currentSessionSamples();
  if (!samples.length) {
    return null;
  }
  const latest = samples[samples.length - 1];
  const first = samples[0];
  const heartRate = positiveAverage(samples, 'hr');
  const respiration = positiveAverage(samples, 'br');
  const ppgReady = Number(latest.payload.pp || 0) === 1 && Number(latest.payload.ir || 0) > 0;
  const durationSeconds = Math.max(1, Math.round((latest.receivedAt - first.receivedAt) / 1000));

  return {
    id: 'live-latest',
    title: 'HOLD 实时采集记录',
    startedAt: new Date(latest.receivedAt).toLocaleString(),
    durationLabel: `${durationSeconds} 秒`,
    resultTag: ppgReady ? '实时数据' : '等待 PPG',
    summary: ppgReady ? '设备实时数据已同步，可继续保持佩戴以形成稳定记录。' : '蓝牙链路已通，但 PPG 传感器尚未返回有效原始值。',
    metrics: [
      { label: '平均心率', value: heartRate ? heartRate.toFixed(0) : '--', unit: heartRate ? ' bpm' : '' },
      { label: '平均呼吸', value: respiration ? respiration.toFixed(0) : '--', unit: respiration ? ' 次/分' : '' },
      { label: 'PPG 原始值', value: Number(latest.payload.ir || 0) || '--', unit: '' }
    ],
    waveformMoments: chartMoments(samples),
    reportSections: [
      { heading: '链路状态', text: `最近收到序号 ${latest.payload.seq || '--'} 的完整硬件遥测。` },
      { heading: '传感器状态', text: ppgReady ? 'PPG 已初始化并返回红外原始数据。' : `PPG 未就绪：${latest.payload.pe || '未收到 I2C 数据'}。` },
      { heading: '建议', text: ppgReady ? '保持传感器贴合并减少移动，继续采集至少 60 秒。' : '检查 MAX30102 的 3V3、GND、SDA 与 SCL 接线。' }
    ]
  };
}

function getMeasurements() {
  const live = buildLiveMeasurement();
  return live ? [live].concat(activeMeasurements) : activeMeasurements;
}

function getDailyAnalyses() {
  const samples = recentSamples();
  if (!samples.length) {
    return dailyAnalyses;
  }
  const heartRate = positiveAverage(samples, 'hr');
  const respiration = positiveAverage(samples, 'br');
  const liveDay = Object.assign({}, dailyAnalyses[0], {
    day: new Date().toLocaleDateString(),
    title: '今日实时',
    heartRateAvg: heartRate ? heartRate.toFixed(0) : '--',
    respirationAvg: respiration ? respiration.toFixed(0) : '--',
    insight: heartRate || respiration ? '今日实时遥测已同步，继续稳定佩戴可提高统计可靠性。' : '数据链路已建立，正在等待有效的 PPG 与呼吸数据。'
  });
  return [liveDay].concat(dailyAnalyses);
}

function getLatestMeasurement() {
  return buildLiveMeasurement() || activeMeasurements[0];
}

function getMeasurementById(id) {
  return getMeasurements().find((item) => item.id === id) || getLatestMeasurement();
}

function getLatestDailyAnalysis() {
  return getDailyAnalyses()[0];
}

module.exports = {
  activeMeasurements,
  dailyAnalyses,
  homeOverview,
  getMeasurements,
  getDailyAnalyses,
  getLatestMeasurement,
  getMeasurementById,
  getLatestDailyAnalysis
};
