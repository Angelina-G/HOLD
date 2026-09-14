/**
 * ppg-predict.js
 * ------------------------------------------------------------------
 * 封装 cloud_hosting/README.md 描述的 PPG 情感检测接口
 *   POST /api/ppg_predict  →  三分类结果（基线 / 压力 / 愉悦）
 *
 * 依赖：App.onLaunch 里已执行 wx.cloud.init（见 app.js）
 * 数据：t_ms 取设备时间戳（device_uptime_ms），sig 取 I6 去趋势波形
 */

const ENV_ID = 'hold-dev-env-d2gukfp01ac296189';
const SERVICE_NAME = 'ppg-predict';
const API_PATH = '/api/ppg_predict';

/** README：重采样取整会吃掉一点时长，30.5 秒起送更稳妥 */
const MIN_DURATION_MS = 30500;
/** label_id 与类别名的固定映射 */
const LABEL_ORDER = ['基线', '压力', '愉悦'];
/** 本地去直流时直流估计的时间常数（毫秒），与固件 dc_estimate_ 同量级 */
const DEFAULT_DC_TAU_MS = 1000;
/**
 * 是否允许在没有 detrended_ir 时退回设备 I6（filtered_ir）。
 * 实测 filtered_ir 与 detrended_ir 经服务端预处理后相关度仅 0.68、平均相对偏差 76%，
 * 默认关闭；仅联调期临时打开。
 */
const ALLOW_FILTERED_FALLBACK = false;

const LABEL_TONE = {
  基线: 'calm',
  压力: 'stress',
  愉悦: 'joy'
};

/** 信号来源的展示名，方便在界面上确认喂进去的到底是哪一路 */
const SIGNAL_SOURCE_LABEL = {
  detrended_ir: 'detrended_ir',
  raw_minus_avg: 'raw - avg',
  raw_detrended: 'raw 去直流',
  filtered_ir_fallback: 'filtered_ir 回退'
};

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * 去直流，等价于固件里的 `detrended_ir = raw_ir - dc_estimate_`。
 * dc_estimate_ 在固件里是慢跟随的一阶低通，这里用同构的 EMA 复刻：
 *   alpha = 1 - exp(-dt / tau)
 * 用前 1 秒的均值给 dc 播种，避免开头出现一大段虚假偏移。
 */
function detrendSignal(values, intervalMs, tauMs) {
  const tau = Number(tauMs) > 0 ? Number(tauMs) : DEFAULT_DC_TAU_MS;
  const alpha = intervalMs > 0 ? 1 - Math.exp(-intervalMs / tau) : 0;

  if (alpha <= 0) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return values.map((value) => value - mean);
  }

  const seedCount = Math.max(1, Math.min(values.length, Math.round(1000 / intervalMs)));
  let dc = 0;
  for (let index = 0; index < seedCount; index += 1) {
    dc += values[index];
  }
  dc /= seedCount;

  return values.map((value) => {
    dc += alpha * (value - dc);
    return value - dc;
  });
}

/**
 * 选出真正要送给接口的信号。
 *
 * 训练数据用的是 `detrended_ir`，而 BLE 的 `i6` 是固件 `filtered_ir`
 * （detrended 之后又做了一层平滑，是 beat 检测链的输入）。
 * 实测两者经服务端预处理后相关度只有 0.68，不能直接互换，所以这里严格按优先级取：
 *
 *   1. fullPpgDetrendedIr  固件直接上报的 detrended_ir
 *   2. fullPpgRawIr + fullPpgAvgIr  → raw - avg（与固件去趋势口径一致）
 *   3. fullPpgRawIr  → 本地 EMA 去直流
 *   4. fullPpgWavePoints（i6） 仅 ALLOW_FILTERED_FALLBACK 打开时使用
 */
function resolveSignalSource(measurement) {
  const source = measurement || {};
  const expectedLength = Array.isArray(source.fullPpgWavePoints) ? source.fullPpgWavePoints.length : 0;

  if (Array.isArray(source.fullPpgDetrendedIr) && source.fullPpgDetrendedIr.length === expectedLength && expectedLength > 0) {
    return { sig: source.fullPpgDetrendedIr.map((value) => toNumber(value)), source: 'detrended_ir' };
  }

  const rawIr = Array.isArray(source.fullPpgRawIr) && source.fullPpgRawIr.length === expectedLength
    ? source.fullPpgRawIr.map((value) => toNumber(value))
    : null;
  const avgIr = Array.isArray(source.fullPpgAvgIr) && source.fullPpgAvgIr.length === expectedLength
    ? source.fullPpgAvgIr.map((value) => toNumber(value))
    : null;

  if (rawIr) {
    if (avgIr) {
      return { sig: rawIr.map((value, index) => value - avgIr[index]), source: 'raw_minus_avg' };
    }
    return {
      sig: detrendSignal(rawIr, toNumber(source.sampleIntervalMs), DEFAULT_DC_TAU_MS),
      source: 'raw_detrended'
    };
  }

  if (ALLOW_FILTERED_FALLBACK && expectedLength > 0) {
    return { sig: source.fullPpgWavePoints.map((value) => toNumber(value)), source: 'filtered_ir_fallback' };
  }

  throw new Error('设备未上报 detrended_ir / raw_ir，无法识别。需固件在 active_realtime_batch 中补充 i5（detrended_ir）或 raw_ir 字段');
}

/**
 * 判断时间戳数组能否直接用于重采样：
 * 长度一致、非负、单调不减、总跨度 > 0
 */
function isUsableTimestampSeries(series, expectedLength) {
  if (!Array.isArray(series) || series.length !== expectedLength || expectedLength < 2) {
    return false;
  }

  let previous = -1;
  for (let index = 0; index < series.length; index += 1) {
    const current = Number(series[index]);
    if (!Number.isFinite(current) || current < 0 || current < previous) {
      return false;
    }
    previous = current;
  }

  return previous > 0;
}

/**
 * 由一次主动检测记录构建接口入参。
 * 优先使用设备上报的时间戳；缺失时按采样间隔重建相对时间轴。
 */
function buildPredictSeries(measurement) {
  const source = measurement || {};
  const resolved = resolveSignalSource(source);
  const sig = resolved.sig;

  if (sig.length < 2) {
    throw new Error('本次检测没有可用的波形数据');
  }

  let tMs = null;
  if (isUsableTimestampSeries(source.fullPpgTsMs, sig.length)) {
    tMs = source.fullPpgTsMs.map((value) => toNumber(value));
  } else {
    const intervalMs = toNumber(source.sampleIntervalMs);
    const startTsMs = toNumber(source.sampleStartTsMs);
    const endTsMs = toNumber(source.sampleEndTsMs);
    const spanMs = endTsMs > startTsMs ? endTsMs - startTsMs : 0;

    if (intervalMs > 0) {
      const base = startTsMs > 0 ? startTsMs : 0;
      tMs = sig.map((value, index) => base + index * intervalMs);
    } else if (spanMs > 0) {
      tMs = sig.map((value, index) => startTsMs + (spanMs * index) / (sig.length - 1));
    } else {
      throw new Error('无法确定采样时间轴');
    }
  }

  const durationMs = tMs[tMs.length - 1] - tMs[0];
  if (durationMs < MIN_DURATION_MS) {
    throw new Error(`信号时长仅 ${(durationMs / 1000).toFixed(1)} 秒，至少需要 30 秒`);
  }

  return { tMs, sig, durationMs, signalSource: resolved.source };
}

/** 调用云托管服务，返回 data 字段 */
function callPpgPredict(tMs, sig) {
  if (!wx.cloud || typeof wx.cloud.callContainer !== 'function') {
    return Promise.reject(new Error('当前基础库不支持云托管调用'));
  }

  return wx.cloud.callContainer({
    config: { env: ENV_ID },
    path: API_PATH,
    method: 'POST',
    header: {
      'X-WX-SERVICE': SERVICE_NAME,
      'content-type': 'application/json'
    },
    data: { t_ms: tMs, sig }
  }).then((result) => {
    const statusCode = result && result.statusCode;
    const body = result && result.data;

    if (statusCode !== 200 || !body) {
      if (statusCode === 404) {
        throw new Error('云托管服务未就绪，请确认 ppg-predict 已部署');
      }
      throw new Error(`云托管返回 HTTP ${statusCode || 'unknown'}`);
    }

    if (body.code !== 0) {
      throw new Error(body.message || '识别失败');
    }

    return body.data || {};
  });
}

function toPercent(value) {
  const percent = Math.round(toNumber(value) * 100);
  return percent > 100 ? 100 : percent;
}

/** 把接口返回整理成页面可直接渲染的视图模型 */
function summarizePredictResult(data, seriesInfo) {
  const predictions = Array.isArray(data.predictions) ? data.predictions : [];
  if (!predictions.length) {
    throw new Error('接口未返回任何识别结果');
  }

  const totals = { 基线: 0, 压力: 0, 愉悦: 0 };
  const segments = predictions.map((item) => {
    const probabilities = item.probabilities || {};
    LABEL_ORDER.forEach((name) => {
      totals[name] += toNumber(probabilities[name]);
    });

    let topName = LABEL_ORDER[0];
    let topValue = -1;
    LABEL_ORDER.forEach((name) => {
      const value = toNumber(probabilities[name]);
      if (value > topValue) {
        topValue = value;
        topName = name;
      }
    });

    return {
      index: Number(item.index || 0),
      label: item.label || topName,
      labelId: Number(item.label_id === undefined ? LABEL_ORDER.indexOf(topName) : item.label_id),
      confidencePercent: toPercent(topValue)
    };
  });

  const segmentCount = segments.length || 1;
  let overallLabel = LABEL_ORDER[0];
  let overallValue = -1;
  const bars = LABEL_ORDER.map((name) => {
    const average = totals[name] / segmentCount;
    if (average > overallValue) {
      overallValue = average;
      overallLabel = name;
    }
    return {
      name,
      percent: `${toPercent(average)}%`,
      width: toPercent(average)
    };
  });

  const windowSec = Number(data.window_sec || 0);
  const metaParts = [];
  if (windowSec > 0) {
    metaParts.push(`窗口 ${windowSec} 秒`);
  }
  metaParts.push(`${segments.length} 段`);
  metaParts.push(`${seriesInfo.sig.length} 点`);
  if (SIGNAL_SOURCE_LABEL[seriesInfo.signalSource]) {
    metaParts.push(SIGNAL_SOURCE_LABEL[seriesInfo.signalSource]);
  }

  return {
    label: overallLabel,
    signalSource: seriesInfo.signalSource,
    labelId: LABEL_ORDER.indexOf(overallLabel),
    tone: LABEL_TONE[overallLabel] || 'calm',
    confidence: overallValue,
    confidenceText: `${toPercent(overallValue)}%`,
    bars,
    segments,
    windowSec,
    segmentsCount: segments.length,
    durationSec: Number((seriesInfo.durationMs / 1000).toFixed(1)),
    pointCount: seriesInfo.sig.length,
    metaText: metaParts.join(' · '),
    raw: data
  };
}

/**
 * 对一条主动检测记录做情感识别。
 * @param {object} measurement holdBleRuntime 中的 activeMeasurement
 * @returns {Promise<object>} summarizePredictResult 的视图模型
 */
function predictFromMeasurement(measurement) {
  let seriesInfo = null;

  try {
    seriesInfo = buildPredictSeries(measurement);
  } catch (error) {
    return Promise.reject(error);
  }

  return callPpgPredict(seriesInfo.tMs, seriesInfo.sig)
    .then((data) => summarizePredictResult(data, seriesInfo))
    .catch((error) => {
      const message = error && error.message ? error.message : '识别失败';
      // -601034 是云开发/云托管未开通，单独给一句人话
      if (message.indexOf('-601034') >= 0) {
        throw new Error('未开通云托管服务，请在云开发控制台开通后重试');
      }
      throw error instanceof Error ? error : new Error(message);
    });
}

/** 服务健康检查，用于排查部署状态 */
function checkHealth() {
  if (!wx.cloud || typeof wx.cloud.callContainer !== 'function') {
    return Promise.reject(new Error('当前基础库不支持云托管调用'));
  }

  return wx.cloud.callContainer({
    config: { env: ENV_ID },
    path: '/health',
    method: 'GET',
    header: { 'X-WX-SERVICE': SERVICE_NAME }
  }).then((result) => (result && result.data) || null);
}

module.exports = {
  ENV_ID,
  SERVICE_NAME,
  MIN_DURATION_MS,
  LABEL_ORDER,
  SIGNAL_SOURCE_LABEL,
  detrendSignal,
  resolveSignalSource,
  buildPredictSeries,
  callPpgPredict,
  predictFromMeasurement,
  checkHealth
};
