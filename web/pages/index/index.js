var SERVICE_UUID = '19b10010-e8f2-537e-4f6c-d104768a1214';
var EVENT_CHARACTERISTIC_UUID = '19b10011-e8f2-537e-4f6c-d104768a1214';
var COMMAND_CHARACTERISTIC_UUID = '19b10013-e8f2-537e-4f6c-d104768a1214';
var DEVICE_NAME_PREFIX = 'HOLD-LINK-TEST';
var DEVICE_NAME_PREFIXES = ['HOLD-LINK-TEST', 'HOLD-INTEGRATED'];

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

function hasAny(payload, keys) {
  for (var index = 0; index < keys.length; index += 1) {
    if (present(payload[keys[index]])) {
      return true;
    }
  }
  return false;
}

function buildSignalSummary(payload) {
  var checks = [
    ['佩戴', present(payload.wear) ? Number(payload.wear) === 1 : present(payload.contact)],
    ['PPG', numericPositive(payload.ir) || numericPositive(payload.red)],
    ['运动', hasAny(payload, ['motion', 'mo', 'ax', 'ay', 'az'])],
    ['压力', hasAny(payload, ['pr', 'pl', 'pressure'])],
    ['震动', hasAny(payload, ['hp', 'haptic_ready'])]
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
    pressCount: 0,
    signalStatus: '等待硬件数据',
    lastEventTime: '暂无',
    lastEventRaw: '等待硬件通知...',
    cloudStatus: '未提交',
    storagePath: '暂无',
    llmReply: '暂无'
  },

  onLoad: function () {
    var self = this;
    self.connecting = false;
    self.notifyBuffer = '';
    wx.onBLECharacteristicValueChange(function (result) {
      self.handleNotifyMessage(result);
    });
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

  onUnload: function () {
    this.stopDiscovery();
  },

  handleScanAndConnect: function () {
    this.connecting = false;
    this.setData({
      adapterStatus: '准备蓝牙',
      connectionStatus: '未连接',
      scanning: true,
      canSendCommand: false
    });
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
        self.setData({
          adapterStatus: '扫描中，等待 HOLD-LINK-TEST / HOLD-INTEGRATED',
          scanning: true
        });
      },
      fail: function (error) {
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
        self.connecting = false;
        self.setData({ connectionStatus: '已连接，获取服务中' });
        self.fetchServices(deviceId);
      },
      fail: function (error) {
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
          canSendCommand: true
        });
        self.enableNotify(deviceId, serviceId, eventCharacteristic.uuid);
      },
      fail: function (error) {
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
        self.setData({
          connectionStatus: '已订阅硬件通知',
          adapterStatus: '链路已打通，可发送呼吸或校准命令'
        });
      },
      fail: function (error) {
        self.setData({ connectionStatus: '订阅失败: ' + errorText(error) });
      }
    });
  },

  sendCommand: function (command) {
    if (!this.data.canSendCommand) {
      this.setData({ connectionStatus: '未连接命令特征，不能发送' });
      return;
    }
    wx.writeBLECharacteristicValue({
      deviceId: this.data.deviceId,
      serviceId: this.data.serviceId,
      characteristicId: this.data.commandCharacteristicId,
      value: stringToArrayBuffer(command),
      success: this.setData.bind(this, { connectionStatus: '已发送 ' + command }),
      fail: function (error) {
        this.setData({ connectionStatus: '发送失败: ' + errorText(error) });
      }.bind(this)
    });
  },

  toggleBreath: function () {
    this.sendCommand(this.data.breathRunning ? 'breath_stop' : 'breath_start');
  },

  startCalibration: function () {
    this.setData({
      calibrationRunning: true,
      signalStatus: '校准命令已发送，等待硬件回传'
    });
    this.sendCommand('calibrate_start');
  },

  handleNotifyMessage: function (result) {
    var rawText = arrayBufferToString(result.value);
    if (this.notifyBuffer && rawText.charAt(0) === '{') {
      this.notifyBuffer = '';
    }
    var batch = takeJsonMessages(this.notifyBuffer, rawText);
    var self = this;
    this.notifyBuffer = batch.rest.slice(-2048);

    if (!batch.messages.length) {
      this.setData({
        lastEventRaw: '接收分片: ' + this.notifyBuffer,
        connectionStatus: this.notifyBuffer.length > 160 ? '硬件通知被截断，需更新固件分片发送' : '正在接收硬件数据'
      });
      return;
    }

    batch.messages.forEach(function (message) {
      var payload = null;
      try {
        payload = JSON.parse(message);
      } catch (error) {
        self.setData({
          lastEventRaw: '通知解析失败: ' + message,
          connectionStatus: '收到损坏的硬件通知'
        });
        return;
      }

      var eventType = payload.event_type || payload.t || '';
      var calibrationRunning = present(payload.cg)
        ? Number(payload.cg) === 1
        : Boolean(payload.calibration_running);
      if (eventType === 'cal_done' || eventType === 'calibration_done') {
        calibrationRunning = false;
      }

      self.setData({
        pressCount: Number(payload.press_count || payload.bc || self.data.pressCount || 0),
        breathRunning: present(payload.bg) ? Number(payload.bg) === 1 : Boolean(payload.breath_enabled),
        calibrationRunning: calibrationRunning,
        hapticReady: hasAny(payload, ['hp', 'haptic_ready']),
        signalStatus: eventType === 'cal_done' || eventType === 'calibration_done' ? '基础校准完成，数据链路已解析' : buildSignalSummary(payload).text,
        lastEventTime: new Date().toLocaleString(),
        lastEventRaw: message,
        connectionStatus: '已收到硬件数据'
      });

      if (eventType === 'button_press') {
        self.submitEventToCloud(payload);
      }
    });
  },

  submitEventToCloud: function (eventPayload) {
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
        this.setData({
          cloudStatus: payload.code === 200 ? '成功' : '失败: ' + (payload.msg || 'unknown'),
          storagePath: payload.storage_cloud_path || payload.storage_file_id || '未写入',
          llmReply: payload.llm_reply || '未返回文本'
        });
      }.bind(this),
      fail: function (error) {
        this.setData({
          cloudStatus: '调用失败: ' + error.errMsg,
          llmReply: '云函数调用失败'
        });
      }.bind(this)
    });
  },

  disconnectDevice: function () {
    var self = this;
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
      }
    });
  }
});
