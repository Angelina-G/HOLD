const SERVICE_UUID = '19b10010-e8f2-537e-4f6c-d104768a1214';
const EVENT_CHARACTERISTIC_UUID = '19b10011-e8f2-537e-4f6c-d104768a1214';
const COMMAND_CHARACTERISTIC_UUID = '19b10013-e8f2-537e-4f6c-d104768a1214';
const DEVICE_NAME_PREFIX = 'HOLD-LINK-TEST';

function arrayBufferToString(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let index = 0; index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index]);
  }
  return text;
}

function stringToArrayBuffer(text) {
  const buffer = new ArrayBuffer(text.length);
  const view = new Uint8Array(buffer);
  for (let index = 0; index < text.length; index += 1) {
    view[index] = text.charCodeAt(index);
  }
  return buffer;
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
    lastEventTime: '暂无',
    lastEventRaw: '等待硬件通知...',
    cloudStatus: '未提交',
    storagePath: '暂无',
    llmReply: '暂无'
  },

  onLoad() {
    wx.onBLECharacteristicValueChange((result) => this.handleNotifyMessage(result));
    wx.onBluetoothDeviceFound((result) => {
      const target = (result.devices || []).find((item) => (
        item.name || item.localName || ''
      ).indexOf(DEVICE_NAME_PREFIX) !== -1);

      if (!target) {
        return;
      }

      this.stopDiscovery();
      this.setData({
        deviceName: target.name || target.localName || DEVICE_NAME_PREFIX,
        deviceId: target.deviceId,
        adapterStatus: '已发现目标设备',
        connectionStatus: '正在连接'
      });
      this.connectDevice(target.deviceId);
    });
  },

  onUnload() {
    this.stopDiscovery();
    if (this.data.deviceId) {
      wx.closeBLEConnection({ deviceId: this.data.deviceId });
    }
    wx.closeBluetoothAdapter({});
  },

  handleScanAndConnect() {
    this.setData({
      adapterStatus: '初始化蓝牙中',
      connectionStatus: '未连接',
      scanning: true
    });

    wx.openBluetoothAdapter({
      success: () => {
        this.setData({ adapterStatus: '蓝牙已开启，开始扫描' });
        this.startDiscovery();
      },
      fail: (error) => {
        this.setData({
          adapterStatus: `蓝牙初始化失败: ${error.errCode || error.errMsg}`,
          scanning: false
        });
      }
    });
  },

  startDiscovery() {
    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      success: () => this.setData({ adapterStatus: '扫描中，等待 HOLD-LINK-TEST...', scanning: true }),
      fail: (error) => this.setData({
        adapterStatus: `扫描失败: ${error.errCode || error.errMsg}`,
        scanning: false
      })
    });
  },

  stopDiscovery() {
    wx.stopBluetoothDevicesDiscovery({
      complete: () => {
        if (this.data.scanning) {
          this.setData({ scanning: false });
        }
      }
    });
  },

  connectDevice(deviceId) {
    wx.createBLEConnection({
      deviceId,
      timeout: 10000,
      success: () => {
        this.setData({ connectionStatus: '已连接，获取服务中' });
        this.fetchServices(deviceId);
      },
      fail: (error) => this.setData({ connectionStatus: `连接失败: ${error.errCode || error.errMsg}` })
    });
  },

  fetchServices(deviceId) {
    wx.getBLEDeviceServices({
      deviceId,
      success: (result) => {
        const service = (result.services || []).find((item) => item.uuid.toLowerCase() === SERVICE_UUID);
        if (!service) {
          this.setData({ connectionStatus: '未找到 HOLD 服务' });
          return;
        }

        this.setData({ serviceId: service.uuid, connectionStatus: '服务已找到，获取特征中' });
        this.fetchCharacteristics(deviceId, service.uuid);
      },
      fail: (error) => this.setData({ connectionStatus: `获取服务失败: ${error.errCode || error.errMsg}` })
    });
  },

  fetchCharacteristics(deviceId, serviceId) {
    wx.getBLEDeviceCharacteristics({
      deviceId,
      serviceId,
      success: (result) => {
        const characteristics = result.characteristics || [];
        const eventCharacteristic = characteristics.find((item) => item.uuid.toLowerCase() === EVENT_CHARACTERISTIC_UUID);
        const commandCharacteristic = characteristics.find((item) => item.uuid.toLowerCase() === COMMAND_CHARACTERISTIC_UUID);

        if (!eventCharacteristic || !commandCharacteristic) {
          this.setData({ connectionStatus: '缺少通知或命令特征，请重新烧录最新固件' });
          return;
        }

        this.setData({
          eventCharacteristicId: eventCharacteristic.uuid,
          commandCharacteristicId: commandCharacteristic.uuid,
          canSendCommand: true
        });
        this.enableNotify(deviceId, serviceId, eventCharacteristic.uuid);
      },
      fail: (error) => this.setData({ connectionStatus: `获取特征失败: ${error.errCode || error.errMsg}` })
    });
  },

  enableNotify(deviceId, serviceId, characteristicId) {
    wx.notifyBLECharacteristicValueChange({
      deviceId,
      serviceId,
      characteristicId,
      state: true,
      success: () => this.setData({
        connectionStatus: '已订阅硬件通知',
        adapterStatus: '链路已打通，可发送呼吸或校准命令'
      }),
      fail: (error) => this.setData({ connectionStatus: `订阅失败: ${error.errCode || error.errMsg}` })
    });
  },

  sendCommand(command) {
    if (!this.data.canSendCommand) {
      this.setData({ connectionStatus: '未连接命令特征，不能发送' });
      return;
    }

    wx.writeBLECharacteristicValue({
      deviceId: this.data.deviceId,
      serviceId: this.data.serviceId,
      characteristicId: this.data.commandCharacteristicId,
      value: stringToArrayBuffer(command),
      success: () => this.setData({ connectionStatus: `已发送: ${command}` }),
      fail: (error) => this.setData({ connectionStatus: `发送失败: ${error.errCode || error.errMsg}` })
    });
  },

  toggleBreath() {
    this.sendCommand(this.data.breathRunning ? 'breath_stop' : 'breath_start');
  },

  startCalibration() {
    this.sendCommand('calibrate_start');
  },

  handleNotifyMessage(result) {
    const rawText = arrayBufferToString(result.value);
    let payload = null;

    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      this.setData({
        lastEventRaw: `通知解析失败: ${rawText}`,
        connectionStatus: '收到无法解析的通知'
      });
      return;
    }

    this.setData({
      pressCount: Number(payload.press_count || this.data.pressCount || 0),
      breathRunning: Boolean(payload.breath_enabled),
      calibrationRunning: Boolean(payload.calibration_running),
      hapticReady: Boolean(payload.haptic_ready),
      lastEventTime: new Date().toLocaleString(),
      lastEventRaw: rawText
    });

    if (payload.event_type === 'button_press') {
      this.submitEventToCloud(payload);
    }
  },

  submitEventToCloud(eventPayload) {
    this.setData({ cloudStatus: '提交云函数中...' });
    wx.cloud.callFunction({
      name: 'link_test_ingest',
      data: {
        device_id: eventPayload.device_id,
        event_type: eventPayload.event_type,
        press_count: eventPayload.press_count,
        device_timestamp: eventPayload.device_timestamp,
        miniapp_timestamp: Date.now()
      },
      success: (result) => {
        const payload = result.result || {};
        this.setData({
          cloudStatus: payload.code === 200 ? '成功' : `失败: ${payload.msg || 'unknown'}`,
          storagePath: payload.storage_cloud_path || payload.storage_file_id || '未写入',
          llmReply: payload.llm_reply || '未返回文本'
        });
      },
      fail: (error) => this.setData({
        cloudStatus: `调用失败: ${error.errMsg}`,
        llmReply: '云函数调用失败'
      })
    });
  },

  disconnectDevice() {
    if (!this.data.deviceId) {
      return;
    }

    wx.closeBLEConnection({
      deviceId: this.data.deviceId,
      complete: () => this.setData({
        connectionStatus: '已断开',
        deviceId: '',
        serviceId: '',
        eventCharacteristicId: '',
        commandCharacteristicId: '',
        canSendCommand: false,
        breathRunning: false,
        calibrationRunning: false
      })
    });
  }
});
