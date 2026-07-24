var SERVICE_UUID = '19b10010-e8f2-537e-4f6c-d104768a1214';
var EVENT_CHARACTERISTIC_UUID = '19b10011-e8f2-537e-4f6c-d104768a1214';
var COMMAND_CHARACTERISTIC_UUID = '19b10013-e8f2-537e-4f6c-d104768a1214';
var DEVICE_NAME_PREFIX = 'HOLD-LINK-TEST';
var DEVICE_NAME_PREFIXES = ['HOLD-LINK-TEST', 'HOLD-INTEGRATED'];
var archiveLatestMeasurement = require('../../utils/mock-health-data').archiveLatestMeasurement;
var lastWaveStoredAt = 0;

function holdLog(stage, detail) {
  console.info('[HOLD][' + stage + ']', detail || '');
}

function arrayBufferToString(buffer) {
  var bytes = new Uint8Array(buffer);
  var text = '';
  for (var index = 0; index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index]);
  }
  return text;
}

function stringToArrayBuffer(text) {
  var buffer = new ArrayBuffer(text.length);
  var view = new Uint8Array(buffer);
  for (var index = 0; index < text.length; index += 1) {
    view[index] = text.charCodeAt(index);
  }
  return buffer;
}

function getDeviceName(device) {
  return device.name || device.localName || '';
}

function isTargetDevice(device) {
  var name = getDeviceName(device);
  for (var index = 0; index < DEVICE_NAME_PREFIXES.length; index += 1) {
    if (name.indexOf(DEVICE_NAME_PREFIXES[index]) !== -1) {
      return true;
    }
  }
  return false;
}

function errorText(error) {
  return error.errCode || error.errMsg || 'unknown';
}

function present(value) {
  return value !== undefined && value !== null && value !== '' && value !== false;
}

function numericPositive(value) {
  return Number(value || 0) > 0;
}

function displayPositive(value) {
  var number = Number(value || 0);
  return number > 0 ? value : '--';
}

function displayBreath(payload) {
  var breathRate = Number(payload.br || 0);
  if (breathRate > 0) return payload.br;
  var candidateRate = Number(payload.bx || 0);
  return candidateRate > 0 ? candidateRate.toFixed(1) : '--';
}

function hasAny(payload, keys) {
  for (var index = 0; index < keys.length; index += 1) {
    if (present(payload[keys[index]])) {
      return true;
    }
  }
  return false;
}

function buildSignalSummary(payload) {
  var ppgLabel = present(payload.p57) && Number(payload.p57) !== 1 ? 'PPG（D4/D5 I2C 未响应）' : 'PPG';
  var checks = [
    ['佩戴', present(payload.wear) ? Number(payload.wear) === 1 : present(payload.contact)],
    [ppgLabel, Number(payload.pp || 0) === 1 && (numericPositive(payload.ir) || numericPositive(payload.red))],
    ['运动', present(payload.mr) ? Number(payload.mr) === 1 : hasAny(payload, ['motion', 'ax', 'ay', 'az'])],
    ['压力', present(payload.ps) ? Number(payload.ps) === 1 : hasAny(payload, ['pr', 'pl', 'pressure'])],
    ['震动', present(payload.hp) ? Number(payload.hp) === 1 : Boolean(payload.haptic_ready)]
  ];
  var ok = [];
  var missing = [];
  for (var index = 0; index < checks.length; index += 1) {
    if (checks[index][1]) {
      ok.push(checks[index][0]);
    } else {
      missing.push(checks[index][0]);
    }
  }
  return {
    text: missing.length ? '已到 ' + ok.length + '/5，缺少：' + missing.join('、') : '5/5 信号已到齐',
    okCount: ok.length
  };
}

function breathDetectorText(payload) {
  var labels = {
    warmup: '预热并选择呼吸轴',
    motion: '检测到移动，请保持稳定',
    cycle: '正在寻找完整呼吸周期',
    confirm: '已找到周期，正在确认稳定性',
    valid: '呼吸率有效'
  };
  var label = labels[payload.bd] || '等待呼吸算法状态';
  if (payload.bd === 'confirm' && Number(payload.bx || 0) > 0) {
    label += '（候选 ' + Number(payload.bx).toFixed(1) + ' 次/分）';
  }
  return label;
}

function motionText(payload) {
  if (Number(payload.mr || 0) !== 1) return 'IMU 未就绪';
  return { still: '静止', moving: '移动中', active: '活跃' }[payload.mo] || payload.mo || '--';
}

function takeJsonMessages(buffer, chunk) {
  var text = String(buffer || '') + String(chunk || '');
  var firstBrace = text.indexOf('{');
  if (firstBrace === -1) {
    return { messages: [], rest: '' };
  }
  text = text.slice(firstBrace);

  var messages = [];
  var start = 0;
  var depth = 0;
  var inString = false;
  var escaped = false;

  for (var index = 0; index < text.length; index += 1) {
    var char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        messages.push(text.slice(start, index + 1));
        start = index + 1;
        while (text[start] && text[start] !== '{') {
          start += 1;
        }
        index = start - 1;
      }
    }
  }

  return { messages: messages, rest: text.slice(start) };
}

function cacheTelemetry(payload) {
  var now = Date.now();
  var sessionId = wx.getStorageSync('hold_ble_session_id') || '';
  wx.setStorageSync('hold_latest_telemetry', { payload: payload, receivedAt: now, sessionId: sessionId });

  var samples = wx.getStorageSync('hold_telemetry_samples') || [];
  var eventType = String(payload.t || payload.event_type || '');
  var isControlEvent = eventType && eventType !== 'tel';
  if (isControlEvent || !samples.length || now - samples[samples.length - 1].receivedAt >= 1000) {
    samples.push({ payload: payload, receivedAt: now, sessionId: sessionId });
    wx.setStorageSync('hold_telemetry_samples', samples.slice(-700));
  }
  return now;
}

function cacheLiveWave(app, waveIr, wavePressure) {
  if (!app || !app.globalData) {
    return;
  }
  var now = Date.now();
  var latest = wx.getStorageSync('hold_latest_telemetry') || {};
  var telemetry = latest.payload || {};
  var fresh = latest.receivedAt && now - latest.receivedAt <= 2000;
  var ppgReady = fresh && Number(telemetry.pp || 0) === 1 && Number(waveIr || 0) > 0;
  var pressureReady = fresh && Number(telemetry.ps || 0) === 1 && isFinite(Number(wavePressure));
  if (!ppgReady && !pressureReady) return null;
  var source = ppgReady ? 'PPG 红外实时波形' : '压力实时波形';
  var value = Number(ppgReady ? waveIr : wavePressure);
  if (!isFinite(value)) {
    return;
  }
  var current = app.globalData.liveWave || {};
  var points = current.source === source ? (current.points || []) : [];
  points.push(value);
  app.globalData.liveWave = {
    source: source,
    value: Math.round(value),
    points: points.slice(-120),
    updatedAt: now
  };
  if (now - lastWaveStoredAt >= 500) {
    lastWaveStoredAt = now;
    var samples = wx.getStorageSync('hold_wave_samples') || [];
    samples.push({
      receivedAt: now,
      sessionId: wx.getStorageSync('hold_ble_session_id') || '',
      source: ppgReady ? 'ppg' : 'pressure',
      value: value
    });
    wx.setStorageSync('hold_wave_samples', samples.slice(-1400));
  }
  return { pp: ppgReady ? 1 : 0, ps: pressureReady ? 1 : 0, ir: waveIr, pr: wavePressure };
}

Page({
  data: {
    adapterStatus: '未初始化',
    connectionStatus: '未连接',
    deviceName: '未发现',
    deviceId: '',
    serviceId: '',
    eventCharacteristicId: '',
    commandCharacteristicId: '',
    scanning: false,
    canSendCommand: false,
    breathRunning: false,
    calibrationRunning: false,
    hapticReady: false,
    breathRate: '--',
    heartRate: '--',
    motionState: '--',
    pressureRaw: '--',
    pressureLevel: '--',
    ppgIr: '--',
    ppgRed: '--',
    bodyTemperature: '--',
    wearState: '等待数据',
    pressCount: 0,
    waveSource: '等待硬件数据',
    waveValue: '--',
    waveUnit: '',
    localRecordStatus: '等待硬件遥测',
    signalStatus: '等待硬件数据',
    calibrationGuide: '校准前：戴稳设备，让胸口传感器贴合，保持自然呼吸。',
    lastEventTime: '暂无',
    lastEventRaw: '等待硬件通知...',
    cloudStatus: '未提交',
    storagePath: '暂无',
    llmReply: '暂无'
  },

  onLoad: function () {
    var self = this;
    self.pageVisible = true;
    self.app = typeof getApp === 'function' ? getApp() : null;
    if (self.app && self.app.globalData) {
      self.app.globalData.blePage = self;
      var savedSession = self.app.globalData.bleSession;
      if (savedSession && savedSession.deviceId) {
        self.setData(savedSession);
      }
    }
    self.connecting = false;
    self.notifyBuffer = '';
    self.completePacketCount = 0;
    self.lastTelemetryLogAt = 0;
    self.wavePoints = [];
    self.wavePointSource = '';
    holdLog('PAGE', '调试链路台已加载；遥测写入本地缓存，只有 button_press 事件提交云函数');
    wx.onBLECharacteristicValueChange(function (result) {
      if (self.app && self.app.globalData.blePage !== self) {
        return;
      }
      self.handleNotifyMessage(result);
    });
    if (wx.onBLEConnectionStateChange) {
      wx.onBLEConnectionStateChange(function (result) {
        holdLog('CONNECTION_STATE', result);
        if (result.deviceId === self.data.deviceId && !result.connected) {
          clearTimeout(self.calibrationTimeout);
          self.connecting = false;
          if (self.app && self.app.globalData) {
            self.app.globalData.bleSession = null;
          }
          wx.removeStorageSync('hold_ble_session_id');
          wx.removeStorageSync('hold_pending_intervention_stop');
          self.setData({
            deviceId: '',
            serviceId: '',
            eventCharacteristicId: '',
            commandCharacteristicId: '',
            canSendCommand: false,
            calibrationRunning: false
          });
          if (self.pageVisible) {
            self.setData({
              connectionStatus: '设备连接已断开',
              signalStatus: '校准已停止：蓝牙连接中断',
              calibrationGuide: '请重新连接设备后再开始基础校准。'
            });
          }
        }
      });
    }
    wx.onBluetoothDeviceFound(function (result) {
      var devices = result.devices || [];
      var target = null;
      if (self.connecting || self.data.deviceId) {
        return;
      }
      for (var index = 0; index < devices.length; index += 1) {
        if (isTargetDevice(devices[index])) {
          target = devices[index];
          break;
        }
      }
      if (!target) {
        return;
      }

      holdLog('SCAN', { name: getDeviceName(target), deviceId: target.deviceId });
      self.connecting = true;
      self.setData({
        deviceName: getDeviceName(target) || DEVICE_NAME_PREFIX,
        deviceId: target.deviceId,
        adapterStatus: '已发现目标设备',
        connectionStatus: '正在连接'
      });
      wx.stopBluetoothDevicesDiscovery({
        complete: function () {
          self.setData({ scanning: false });
          setTimeout(function () {
            self.connectDevice(target.deviceId);
          }, 300);
        }
      });
    });
  },

  onShow: function () {
    this.pageVisible = true;
  },

  onHide: function () {
    this.pageVisible = false;
  },

  onUnload: function () {
    this.pageVisible = false;
    clearTimeout(this.calibrationTimeout);
    this.stopDiscovery();
  },

  handleScanAndConnect: function () {
    holdLog('BLE', '开始安卓权限检查与扫描');
    var oldDeviceId = this.data.deviceId;
    this.connecting = false;
    this.setData({
      adapterStatus: '准备蓝牙',
      connectionStatus: '未连接',
      scanning: true,
      canSendCommand: false,
      deviceId: '',
      serviceId: '',
      eventCharacteristicId: '',
      commandCharacteristicId: ''
    });
    if (this.app && this.app.globalData) {
      this.app.globalData.bleSession = null;
    }
    if (oldDeviceId) {
      wx.closeBLEConnection({ deviceId: oldDeviceId });
    }
    this.ensureAndroidScanReady(this.openAdapterAndScan.bind(this));
  },

  ensureAndroidScanReady: function (next) {
    var systemInfo = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
    if ((systemInfo.platform || '').toLowerCase() !== 'android') {
      next();
      return;
    }
    wx.authorize({
      scope: 'scope.userLocation',
      complete: function () {
        next();
      }
    });
  },

  openAdapterAndScan: function () {
    var self = this;
    wx.openBluetoothAdapter({
      success: function () {
        holdLog('ADAPTER', 'openBluetoothAdapter success');
        wx.getBluetoothAdapterState({
          success: function (state) {
            if (!state.available) {
              self.setData({ adapterStatus: '蓝牙不可用，请打开系统蓝牙', scanning: false });
              return;
            }
            self.setData({ adapterStatus: '蓝牙已开启，开始扫描' });
            self.startDiscovery();
          },
          fail: function () {
            self.startDiscovery();
          }
        });
      },
      fail: function (error) {
        holdLog('ADAPTER_ERROR', error);
        self.setData({
          adapterStatus: '蓝牙初始化失败: ' + errorText(error),
          scanning: false
        });
      }
    });
  },

  startDiscovery: function () {
    var self = this;
    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: true,
      interval: 0,
      success: function () {
        holdLog('DISCOVERY', 'startBluetoothDevicesDiscovery success');
        self.setData({
          adapterStatus: '扫描中，等待 HOLD-LINK-TEST / HOLD-INTEGRATED',
          scanning: true
        });
      },
      fail: function (error) {
        holdLog('DISCOVERY_ERROR', error);
        self.setData({
          adapterStatus: '扫描失败: ' + errorText(error),
          scanning: false
        });
      }
    });
  },

  stopDiscovery: function () {
    var self = this;
    wx.stopBluetoothDevicesDiscovery({
      complete: function () {
        if (self.data.scanning) {
          self.setData({ scanning: false });
        }
      }
    });
  },

  connectDevice: function (deviceId) {
    var self = this;
    wx.createBLEConnection({
      deviceId: deviceId,
      timeout: 10000,
      success: function () {
        holdLog('CONNECT', { deviceId: deviceId });
        self.connecting = false;
        self.setData({ connectionStatus: '已连接，获取服务中' });
        self.fetchServices(deviceId);
      },
      fail: function (error) {
        holdLog('CONNECT_ERROR', error);
        self.connecting = false;
        self.setData({
          canSendCommand: false,
          connectionStatus: '连接失败: ' + errorText(error)
        });
      }
    });
  },

  fetchServices: function (deviceId) {
    var self = this;
    wx.getBLEDeviceServices({
      deviceId: deviceId,
      success: function (result) {
        var services = result.services || [];
        holdLog('SERVICES', services.map(function (item) { return item.uuid; }));
        var service = null;
        for (var index = 0; index < services.length; index += 1) {
          if (services[index].uuid.toLowerCase() === SERVICE_UUID) {
            service = services[index];
            break;
          }
        }
        if (!service) {
          self.setData({ connectionStatus: '未找到 HOLD 服务' });
          return;
        }
        self.setData({ serviceId: service.uuid, connectionStatus: '服务已找到，获取特征中' });
        self.fetchCharacteristics(deviceId, service.uuid);
      },
      fail: function (error) {
        holdLog('SERVICES_ERROR', error);
        self.setData({ connectionStatus: '获取服务失败: ' + errorText(error) });
      }
    });
  },

  fetchCharacteristics: function (deviceId, serviceId) {
    var self = this;
    wx.getBLEDeviceCharacteristics({
      deviceId: deviceId,
      serviceId: serviceId,
      success: function (result) {
        var characteristics = result.characteristics || [];
        holdLog('CHARACTERISTICS', characteristics.map(function (item) {
          return { uuid: item.uuid, properties: item.properties };
        }));
        var eventCharacteristic = null;
        var commandCharacteristic = null;
        for (var index = 0; index < characteristics.length; index += 1) {
          var uuid = characteristics[index].uuid.toLowerCase();
          if (uuid === EVENT_CHARACTERISTIC_UUID) {
            eventCharacteristic = characteristics[index];
          } else if (uuid === COMMAND_CHARACTERISTIC_UUID) {
            commandCharacteristic = characteristics[index];
          }
        }
        if (!eventCharacteristic || !commandCharacteristic) {
          self.setData({ connectionStatus: '缺少通知或命令特征，请确认固件版本' });
          return;
        }
        self.setData({
          eventCharacteristicId: eventCharacteristic.uuid,
          commandCharacteristicId: commandCharacteristic.uuid,
          canSendCommand: false
        });
        self.enableNotify(deviceId, serviceId, eventCharacteristic.uuid);
      },
      fail: function (error) {
        holdLog('CHARACTERISTICS_ERROR', error);
        self.setData({ connectionStatus: '获取特征失败: ' + errorText(error) });
      }
    });
  },

  enableNotify: function (deviceId, serviceId, characteristicId) {
    var self = this;
    wx.notifyBLECharacteristicValueChange({
      deviceId: deviceId,
      serviceId: serviceId,
      characteristicId: characteristicId,
      state: true,
      success: function () {
        holdLog('NOTIFY', '通知订阅成功，等待完整 JSON 帧');
        self.setData({
          connectionStatus: '已订阅硬件通知',
          adapterStatus: '链路已打通，可发送呼吸或校准命令',
          canSendCommand: true
        });
        var sessionId = String(Date.now());
        wx.setStorageSync('hold_ble_session_id', sessionId);
        if (self.app && self.app.globalData) {
          self.app.globalData.bleSession = {
            deviceName: self.data.deviceName,
            deviceId: deviceId,
            serviceId: serviceId,
            eventCharacteristicId: characteristicId,
            commandCharacteristicId: self.data.commandCharacteristicId,
            adapterStatus: '链路已打通，可发送呼吸或校准命令',
            connectionStatus: '已订阅硬件通知',
            canSendCommand: true,
            sessionId: sessionId
          };
        }
      },
      fail: function (error) {
        holdLog('NOTIFY_ERROR', error);
        self.setData({ connectionStatus: '订阅失败: ' + errorText(error), canSendCommand: false });
        if (self.app && self.app.globalData) self.app.globalData.bleSession = null;
      }
    });
  },

  sendCommand: function (command, callbacks) {
    callbacks = callbacks || {};
    if (!this.data.canSendCommand) {
      this.setData({ connectionStatus: '未连接命令特征，不能发送' });
      if (callbacks.fail) callbacks.fail({ errMsg: 'BLE command characteristic unavailable' });
      return;
    }
    wx.writeBLECharacteristicValue({
      deviceId: this.data.deviceId,
      serviceId: this.data.serviceId,
      characteristicId: this.data.commandCharacteristicId,
      value: stringToArrayBuffer(command),
      success: function () {
        holdLog('COMMAND', command);
        if (this.pageVisible) this.setData({ connectionStatus: '已发送 ' + command });
        if (callbacks.success) callbacks.success();
      }.bind(this),
      fail: function (error) {
        holdLog('COMMAND_ERROR', { command: command, error: error });
        if (this.pageVisible) this.setData({ connectionStatus: '发送失败: ' + errorText(error) });
        if (callbacks.fail) callbacks.fail(error);
      }.bind(this)
    });
  },

  toggleBreath: function () {
    this.sendCommand(this.data.breathRunning ? 'breath_stop' : 'breath_start');
  },

  startCalibration: function () {
    clearTimeout(this.calibrationTimeout);
    this.setData({
      signalStatus: '正在发送校准命令',
      calibrationGuide: '请保持坐姿稳定，不要说话或大幅移动，等待设备震动提示。'
    });
    this.sendCommand('calibrate_start', {
      success: function () {
        this.setData({
          calibrationRunning: true,
          signalStatus: '校准命令已发送，等待硬件回传',
          calibrationGuide: '校准中：保持佩戴贴合，自然呼吸 10-15 秒；完成后这里会显示结果。'
        });
        this.calibrationTimeout = setTimeout(function () {
          if (!this.data.calibrationRunning) return;
          this.setData({
            calibrationRunning: false,
            signalStatus: '校准已超时：未收到硬件结束通知',
            calibrationGuide: '请查看实时指标：若 PPG、运动或压力仍为“未就绪”，请检查对应传感器；若数据正常，请重新连接后再校准。'
          });
        }.bind(this), 18000);
      }.bind(this),
      fail: function (error) {
        this.setData({
          calibrationRunning: false,
          signalStatus: '校准发送失败：' + errorText(error),
          calibrationGuide: '没有写入命令。请先确认蓝牙仍连接，再重新点基础校准。'
        });
      }.bind(this)
    });
  },

  handleNotifyMessage: function (result) {
    var rawText = arrayBufferToString(result.value);
    if (rawText.indexOf('W,') === 0) {
      var waveParts = rawText.split(',');
      var waveIr = Number(waveParts[1] || 0);
      var wavePressure = Number(waveParts[2]);
      var wavePayload = cacheLiveWave(this.app, waveIr, wavePressure);
      if (wavePayload && this.pageVisible) {
        this.appendWavePoint(wavePayload);
      }
      return;
    }
    var batch = takeJsonMessages(this.notifyBuffer, rawText);
    var self = this;
    this.notifyBuffer = batch.rest.slice(-2048);

    if (!batch.messages.length) {
      return;
    }

    batch.messages.forEach(function (message) {
      var payload = null;
      try {
        payload = JSON.parse(message);
      } catch (error) {
        if (self.pageVisible) {
          self.setData({
            lastEventRaw: '通知解析失败: ' + message,
            connectionStatus: '收到损坏的硬件通知'
          });
        }
        return;
      }

      var eventType = payload.event_type || payload.t || '';
      var calibrationRunning = present(payload.cg)
        ? Number(payload.cg) === 1
        : Boolean(payload.calibration_running);
      if (eventType === 'cal_done' || eventType === 'calibration_done') {
        clearTimeout(self.calibrationTimeout);
        calibrationRunning = false;
      }

      var cachedAt = cacheTelemetry(payload);
      cacheLiveWave(self.app, payload.ir, payload.pr);
      if (self.pageVisible) {
        self.appendWavePoint(payload);
      }
      self.completePacketCount = Number(self.completePacketCount || 0) + 1;
      var now = Date.now();
      if (eventType !== 'tel' || !self.lastTelemetryLogAt || now - self.lastTelemetryLogAt >= 5000) {
        self.lastTelemetryLogAt = now;
        holdLog('FRAME', {
          count: self.completePacketCount,
          type: eventType,
          seq: payload.seq,
          ppg: payload.pp,
          imu: payload.mr,
          pressure: payload.pr,
          breath: payload.br,
          breathSource: payload.bs,
          cached: true,
          cloud: eventType === 'button_press' ? 'submit' : 'not-used'
        });
      }

      if (self.pageVisible) {
        var signalSummary = buildSignalSummary(payload);
        var calibrationDone = eventType === 'cal_done' || eventType === 'calibration_done';
        self.setData({
          pressCount: Number(payload.press_count || payload.bc || self.data.pressCount || 0),
          breathRunning: present(payload.bg) ? Number(payload.bg) === 1 : Boolean(payload.breath_enabled),
          calibrationRunning: calibrationRunning,
          hapticReady: present(payload.hp) ? Number(payload.hp) === 1 : Boolean(payload.haptic_ready),
          breathRate: displayBreath(payload),
          heartRate: displayPositive(payload.hr),
          motionState: motionText(payload),
          pressureRaw: present(payload.pr) ? payload.pr : '--',
          pressureLevel: present(payload.pl) ? payload.pl : '--',
          ppgIr: present(payload.ir) ? payload.ir : '--',
          ppgRed: present(payload.red) ? payload.red : '--',
          bodyTemperature: Number(payload.mr || 0) === 1 && present(payload.bt) ? payload.bt : '--',
          wearState: present(payload.wear) ? (Number(payload.wear) === 1 ? '已佩戴' : '未佩戴') : '等待数据',
          signalStatus: calibrationDone
            ? (signalSummary.okCount === 5 ? '校准完成，5/5 信号正常' : '校准已结束，但' + signalSummary.text)
            : signalSummary.text + '；呼吸：' + breathDetectorText(payload),
          calibrationGuide: calibrationDone
            ? (signalSummary.okCount === 5
              ? '校准成功：现在可以开始测试或呼吸引导。'
              : '校准未完全通过。请按上方“缺少”项检查佩戴或对应传感器，然后重新校准。')
            : (calibrationRunning ? '校准中：继续自然呼吸，尽量不要移动设备。' : self.data.calibrationGuide),
          lastEventTime: new Date().toLocaleString(),
          lastEventRaw: message,
          localRecordStatus: '已写入本地记录，序号 ' + (payload.seq || '--'),
          cloudStatus: eventType === 'button_press' ? self.data.cloudStatus : '遥测无需云函数',
          storagePath: eventType === 'button_press' ? self.data.storagePath : 'hold_telemetry_samples',
          connectionStatus: '已收到硬件数据'
        });
      }

      if (eventType === 'button_press') {
        self.submitEventToCloud(payload);
      }
      if (eventType === 'b_stop' || eventType === 'breath_stop' || eventType === 'breath_stopped') {
        wx.setStorageSync('hold_pending_intervention_stop', {
          stopAt: cachedAt,
          sessionId: wx.getStorageSync('hold_ble_session_id') || ''
        });
        archiveLatestMeasurement(cachedAt);
      } else if (eventType === 'tel') {
        var pending = wx.getStorageSync('hold_pending_intervention_stop') || {};
        var pendingStop = Number(pending.stopAt || pending || 0);
        var currentSessionId = wx.getStorageSync('hold_ble_session_id') || '';
        if (pendingStop && pending.sessionId && pending.sessionId !== currentSessionId) {
          wx.removeStorageSync('hold_pending_intervention_stop');
        } else if (pendingStop && cachedAt - pendingStop >= 30000) {
          var archived = archiveLatestMeasurement(pendingStop);
          if (archived && archived.comparison && archived.comparison.ready) {
            wx.removeStorageSync('hold_pending_intervention_stop');
          }
        }
      }
    });
  },

  appendWavePoint: function (payload) {
    var hasPpg = Number(payload.pp || 0) === 1 && numericPositive(payload.ir);
    var hasPressure = Number(payload.ps || 0) === 1 && isFinite(Number(payload.pr));
    if (!hasPpg && !hasPressure) return;
    var source = hasPpg ? 'PPG 红外原始波形' : '压力原始波形';
    var value = Number(hasPpg ? payload.ir : payload.pr);
    if (!isFinite(value)) {
      return;
    }

    if (this.wavePointSource !== source) {
      this.wavePointSource = source;
      this.wavePoints = [];
    }
    this.wavePoints.push(value);
    this.wavePoints = this.wavePoints.slice(-80);
    this.setData({
      waveSource: source,
      waveValue: String(Math.round(value)),
      waveUnit: hasPpg ? 'IR' : 'ADC'
    });
    this.drawLiveWave();
  },

  drawLiveWave: function () {
    if (!wx.createCanvasContext || !this.wavePoints || !this.wavePoints.length) {
      return;
    }

    var width = 300;
    var height = 140;
    var padding = 12;
    var points = this.wavePoints;
    var minimum = Math.min.apply(null, points);
    var maximum = Math.max.apply(null, points);
    var range = Math.max(maximum - minimum, 1);
    var context = wx.createCanvasContext('liveWaveCanvas', this);

    context.setFillStyle('#fffaf8');
    context.fillRect(0, 0, width, height);
    context.setStrokeStyle('rgba(105, 83, 116, 0.12)');
    context.setLineWidth(1);
    for (var gridLine = 1; gridLine < 4; gridLine += 1) {
      var gridY = (height / 4) * gridLine;
      context.beginPath();
      context.moveTo(padding, gridY);
      context.lineTo(width - padding, gridY);
      context.stroke();
    }

    context.setStrokeStyle(this.wavePointSource.indexOf('PPG') === 0 ? '#ef7f89' : '#9675d8');
    context.setLineWidth(2);
    context.setLineJoin('round');
    context.beginPath();
    for (var index = 0; index < points.length; index += 1) {
      var x = padding + (width - padding * 2) * (points.length === 1 ? 1 : index / (points.length - 1));
      var y = height - padding - ((points[index] - minimum) / range) * (height - padding * 2);
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
    context.draw();
  },

  submitEventToCloud: function (eventPayload) {
    holdLog('CLOUD_REQUEST', eventPayload);
    this.setData({ cloudStatus: '提交云函数中...' });
    wx.cloud.callFunction({
      name: 'link_test_ingest',
      data: {
        device_id: eventPayload.device_id || DEVICE_NAME_PREFIX,
        event_type: eventPayload.event_type || eventPayload.t || 'button_press',
        press_count: eventPayload.press_count || eventPayload.bc || 0,
        device_timestamp: eventPayload.device_timestamp || eventPayload.ts,
        miniapp_timestamp: Date.now()
      },
      success: function (result) {
        var payload = result.result || {};
        holdLog('CLOUD_SUCCESS', payload);
        this.setData({
          cloudStatus: payload.code === 200 ? '成功' : '失败: ' + (payload.msg || 'unknown'),
          storagePath: payload.storage_cloud_path || payload.storage_file_id || '未写入',
          llmReply: payload.llm_reply || '未返回文本'
        });
      }.bind(this),
      fail: function (error) {
        holdLog('CLOUD_ERROR', error);
        this.setData({
          cloudStatus: '调用失败: ' + error.errMsg,
          llmReply: '云函数调用失败'
        });
      }.bind(this)
    });
  },

  disconnectDevice: function () {
    var self = this;
    clearTimeout(this.calibrationTimeout);
    this.connecting = false;
    this.stopDiscovery();
    if (!this.data.deviceId) {
      return;
    }
    wx.closeBLEConnection({
      deviceId: this.data.deviceId,
      complete: function () {
        self.setData({
          connectionStatus: '已断开',
          deviceId: '',
          serviceId: '',
          eventCharacteristicId: '',
          commandCharacteristicId: '',
          canSendCommand: false,
          breathRunning: false,
          calibrationRunning: false
        });
        if (self.app && self.app.globalData) {
          self.app.globalData.bleSession = null;
        }
        wx.removeStorageSync('hold_ble_session_id');
        wx.removeStorageSync('hold_pending_intervention_stop');
      }
    });
  }
});

