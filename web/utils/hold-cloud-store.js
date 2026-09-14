/**
 * 云端存储访问层。
 *
 * 小程序不再使用本地 Storage 作为数据归宿，所有归档数据都写到微信云开发数据库，
 * 通过云函数 health_store 读写，按 openid 隔离。
 *
 * 写入策略：
 * - 大段波形（wave）与轻量记录（record）分开存放，列表拉取不带波形，
 *   打开具体报告时再按需 loadDetail，避免单次拉取过大。
 * - 所有写入做防抖合并，避免蓝牙高频事件把请求打爆。
 */

const FUNCTION_NAME = 'health_store';
const STATE_DEBOUNCE_MS = 1500;
const RECORD_DEBOUNCE_MS = 800;
const RETRY_DELAY_MS = 2000;

const pending = {
  state: {},
  measurements: {},
  dailies: {}
};

const timers = {
  state: {},
  measurements: {},
  dailies: {}
};

let lastError = '';

function isCloudReady() {
  return !!(wx.cloud && typeof wx.cloud.callFunction === 'function');
}

function callStore(data) {
  if (!isCloudReady()) {
    return Promise.reject(new Error('cloud-unavailable'));
  }

  return wx.cloud
    .callFunction({
      name: FUNCTION_NAME,
      data
    })
    .then((response) => response && response.result ? response.result : {})
    .then((result) => {
      if (result.code && Number(result.code) !== 200) {
        throw new Error(result.error_message || `cloud error ${result.code}`);
      }
      return result;
    });
}

function sendWithRetry(buildData, payload) {
  return callStore(buildData(payload)).catch(() => {
    // 失败后重试一次，仍失败则丢弃本次写入，等待下一次数据变化再补上
    return new Promise((resolve) => {
      setTimeout(resolve, RETRY_DELAY_MS);
    })
      .then(() => callStore(buildData(payload)))
      .catch((retryError) => {
        lastError = retryError && retryError.message ? retryError.message : 'unknown';
        console.error('hold cloud store write failed', lastError);
        return null;
      });
  });
}

function schedule(bucket, key, delay, buildData) {
  if (timers[bucket][key]) {
    clearTimeout(timers[bucket][key]);
  }

  timers[bucket][key] = setTimeout(() => {
    delete timers[bucket][key];
    if (!pending[bucket][key]) {
      return;
    }

    const payload = pending[bucket][key];
    delete pending[bucket][key];
    sendWithRetry(buildData, payload);
  }, delay);
}

function flushBucket(bucket, buildData) {
  Object.keys(pending[bucket]).forEach((key) => {
    if (timers[bucket][key]) {
      clearTimeout(timers[bucket][key]);
      delete timers[bucket][key];
    }

    const payload = pending[bucket][key];
    delete pending[bucket][key];
    if (payload) {
      sendWithRetry(buildData, payload);
    }
  });
}

function clearBucket(bucket) {
  Object.keys(timers[bucket]).forEach((key) => {
    clearTimeout(timers[bucket][key]);
    delete timers[bucket][key];
  });
  Object.keys(pending[bucket]).forEach((key) => {
    delete pending[bucket][key];
  });
}

function buildStateData(payload) {
  return {
    action: 'save_state',
    payload
  };
}

function buildMeasurementData(payload) {
  return {
    action: 'save_measurement',
    recordId: payload.recordId,
    record: payload.record,
    wave: payload.wave,
    keepWave: !!payload.keepWave
  };
}

function buildDailyData(payload) {
  return {
    action: 'save_daily',
    dayKey: payload.dayKey,
    record: payload.record,
    wave: payload.wave,
    keepWave: !!payload.keepWave
  };
}

function saveState(payload) {
  if (!isCloudReady() || !payload) {
    return;
  }

  pending.state.state = payload;
  schedule('state', 'state', STATE_DEBOUNCE_MS, buildStateData);
}

function saveMeasurement(recordId, record, wave, keepWave) {
  if (!isCloudReady() || !recordId) {
    return;
  }

  pending.measurements[recordId] = {
    recordId,
    record: record || {},
    wave: wave || {},
    keepWave: !!keepWave
  };
  schedule('measurements', recordId, RECORD_DEBOUNCE_MS, buildMeasurementData);
}

function saveDaily(dayKey, record, wave, keepWave) {
  if (!isCloudReady() || !dayKey) {
    return;
  }

  pending.dailies[dayKey] = {
    dayKey,
    record: record || {},
    wave: wave || {},
    keepWave: !!keepWave
  };
  schedule('dailies', dayKey, RECORD_DEBOUNCE_MS, buildDailyData);
}

function deleteMeasurement(recordId) {
  if (!isCloudReady() || !recordId) {
    return Promise.resolve(null);
  }

  if (timers.measurements[recordId]) {
    clearTimeout(timers.measurements[recordId]);
    delete timers.measurements[recordId];
  }
  delete pending.measurements[recordId];

  return callStore({ action: 'delete_measurement', recordId }).catch((error) => {
    lastError = error && error.message ? error.message : 'unknown';
    return null;
  });
}

function deleteDaily(dayKey) {
  if (!isCloudReady() || !dayKey) {
    return Promise.resolve(null);
  }

  if (timers.dailies[dayKey]) {
    clearTimeout(timers.dailies[dayKey]);
    delete timers.dailies[dayKey];
  }
  delete pending.dailies[dayKey];

  return callStore({ action: 'delete_daily', dayKey }).catch((error) => {
    lastError = error && error.message ? error.message : 'unknown';
    return null;
  });
}

function clearAll() {
  clearBucket('state');
  clearBucket('measurements');
  clearBucket('dailies');

  if (!isCloudReady()) {
    return Promise.resolve(null);
  }

  return callStore({ action: 'clear_all' }).catch((error) => {
    lastError = error && error.message ? error.message : 'unknown';
    return null;
  });
}

function pull(options = {}) {
  return callStore({ action: 'pull', scope: options.scope || 'mine' });
}

function loadDetail(kind, key, options = {}) {
  if (!key) {
    return Promise.resolve(null);
  }

  return callStore({
    action: 'load_detail',
    kind,
    key,
    scope: options.scope || 'mine'
  }).catch((error) => {
    lastError = error && error.message ? error.message : 'unknown';
    return null;
  });
}

/** 页面进入后台前把防抖队列里没发出去的写入立刻落库 */
function flush() {
  flushBucket('state', buildStateData);
  flushBucket('measurements', buildMeasurementData);
  flushBucket('dailies', buildDailyData);
}

function bootstrap() {
  if (!isCloudReady()) {
    return Promise.resolve(null);
  }

  return callStore({ action: 'bootstrap' }).catch((error) => {
    lastError = error && error.message ? error.message : 'unknown';
    return null;
  });
}

module.exports = {
  isCloudReady,
  pull,
  loadDetail,
  saveState,
  saveMeasurement,
  saveDaily,
  deleteMeasurement,
  deleteDaily,
  clearAll,
  bootstrap,
  flush,
  getLastError: () => lastError
};
