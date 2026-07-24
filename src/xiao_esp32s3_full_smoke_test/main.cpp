/*
 * 创建时间: 2026-06-28
 * 文件主要职责: 提供 IMU + PPG + 压力 + DRV2605L + 热反馈控制脚 的整机冒烟测试入口。
 * 核心函数输入输出:
 * - setup(): 初始化主 I2C、MPU6050/MPU6500、MAX30102、压力传感器、DRV2605L 与加热控制 PWM，并打印统一接线提示。
 * - loop(): 周期读取 IMU、PPG、压力，驱动规律震动，并持续输出一行整机状态日志。
 * 最后更改时间: 2026-06-28
 * 累加式更改日志:
 * - 2026-06-28: 新建完整小 Demo 冒烟测试环境，优先验证多模块同时上电、读取、震动与 PWM 控制是否跑通。
 * - 2026-06-28: 兼容 MPU6500/MPU9250 系列 WHO_AM_I，避免新换 IMU 模块在整机版中被误判为失联。
 * 注意事项:
 * - D1(GPIO2) 在本工程中只输出 PWM 控制信号，必须接到逻辑级 N-MOSFET Gate，不能直接驱动加热片负载。
 * - 本入口目标是“整机是否同时跑通”，不是最终产品算法或安全闭环控制。
 */

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <math.h>
#include <Wire.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include <Adafruit_DRV2605.h>

#include "heart_rate_estimator.h"
#include "imu_respiration_estimator.h"
#include "max30102_raw_reader.h"
#include "pressure_film_raw_reader.h"
#include "project_config.h"

namespace {

constexpr uint32_t kSerialBaudRate = 115200;
constexpr char kBleDeviceName[] = "HOLD-INTEGRATED";
constexpr char kBleServiceUuid[] = "19B10010-E8F2-537E-4F6C-D104768A1214";
constexpr char kBleEventUuid[] = "19B10011-E8F2-537E-4F6C-D104768A1214";
constexpr char kBleCommandUuid[] = "19B10013-E8F2-537E-4F6C-D104768A1214";
constexpr unsigned long kStartupDelayMs = 300;
constexpr unsigned long kSerialAttachWaitMs = 1500;
constexpr unsigned long kStatusLogIntervalMs = 200;
constexpr unsigned long kBleNotifyIntervalMs = 500;
constexpr unsigned long kBleWaveNotifyIntervalMs = 200;
constexpr size_t kBleNotifyChunkBytes = 18;
constexpr unsigned long kBleNotifyChunkGapMs = 12;
constexpr unsigned long kMpuPollIntervalMs = 20;
constexpr unsigned long kPpgPollIntervalMs = project_config::kSensorPollIntervalMs;
constexpr unsigned long kPressurePollIntervalMs = project_config::kPressurePollIntervalMs;
constexpr unsigned long kReconnectIntervalMs = 1500;
constexpr uint32_t kI2cTimeoutMs = 20;

constexpr uint8_t kMpuAddressLow = 0x68;
constexpr uint8_t kMpuAddressHigh = 0x69;
constexpr uint8_t kDrv2605Address = 0x5A;
constexpr uint8_t kMpuRegisterWhoAmI = 0x75;
constexpr uint8_t kMpuRegisterPowerManagement1 = 0x6B;
constexpr uint8_t kMpuRegisterAccelXoutH = 0x3B;
constexpr float kAccelScaleLsbPerG = 16384.0f;
constexpr float kGyroScaleLsbPerDps = 131.0f;

constexpr unsigned long kHapticToggleIntervalMs = 700;
constexpr unsigned long kBreathHapticStepMs = 120;
constexpr unsigned long kBreathGuideDurationMs = 60000;
constexpr unsigned long kCalibrationDurationMs = 12000;
constexpr unsigned long kCalibrationPulseMs = 250;
constexpr unsigned long kFingerPressureHoldMs = 3000;
constexpr uint8_t kFingerPressureLevelThreshold = 6;
constexpr uint16_t kFingerPressureRawThreshold = 3500;
constexpr uint8_t kSecondaryI2cSdaPin = 43;
constexpr uint8_t kSecondaryI2cSclPin = 44;
constexpr uint8_t kLegacyI2cSdaPin = 3;
constexpr uint8_t kLegacyI2cSclPin = 4;

constexpr uint8_t kHeaterControlPin = 2;   // D1/A1
constexpr uint8_t kHeaterPwmChannel = 2;
constexpr uint32_t kHeaterPwmFrequencyHz = 5000;
constexpr uint8_t kHeaterPwmResolutionBits = 8;
constexpr uint32_t kHeaterPwmDuty80Percent = 204;
constexpr unsigned long kHeaterEnableDelayMs = 5000;

constexpr uint8_t kRgbRedPin = 7;    // D8
constexpr uint8_t kRgbGreenPin = 8;  // D9
constexpr uint8_t kRgbBluePin = 9;   // D10
constexpr unsigned long kLedRunnerIntervalMs = 280;
constexpr unsigned long kRgbSelfTestHoldMs = 700;
constexpr unsigned long kBoardHeartbeatIntervalMs = 500;
constexpr unsigned long kStagePulseOnMs = 80;
constexpr unsigned long kStagePulseOffMs = 120;
constexpr unsigned long kStagePulseGapMs = 260;

struct MpuSample {
  int16_t accelX = 0;
  int16_t accelY = 0;
  int16_t accelZ = 0;
  int16_t temperatureRaw = 0;
  int16_t gyroX = 0;
  int16_t gyroY = 0;
  int16_t gyroZ = 0;
  unsigned long capturedAtMs = 0;
};

struct MpuMetrics {
  float accelXg = 0.0f;
  float accelYg = 0.0f;
  float accelZg = 0.0f;
  float gyroXdps = 0.0f;
  float gyroYdps = 0.0f;
  float gyroZdps = 0.0f;
  float temperatureC = 0.0f;
};

struct ImuIdentity {
  uint8_t whoAmI;
  const char* modelName;
  float temperatureScale;
  float temperatureOffset;
};

class PressureRespirationEstimator {
 public:
  void reset() {
    initialized_ = false;
    belowThresholdArmed_ = false;
    baselineSignal_ = 0.0f;
    smoothedSignal_ = 0.0f;
    lastCrossingAtMs_ = 0;
    bpm_ = 0.0f;
  }

  void addPressureSample(const PressureFilmRawReader::Sample& sample, uint16_t peakDeltaRaw) {
    const float rawSignal = static_cast<float>(sample.rawAverage);
    if (!initialized_) {
      initialized_ = true;
      baselineSignal_ = rawSignal;
      smoothedSignal_ = 0.0f;
      return;
    }

    baselineSignal_ += (rawSignal - baselineSignal_) * 0.002f;
    const float signal = rawSignal - baselineSignal_;
    smoothedSignal_ = smoothedSignal_ * 0.88f + signal * 0.12f;
    const float threshold = constrain(static_cast<float>(peakDeltaRaw) * 0.015f, 8.0f, 40.0f);
    if (smoothedSignal_ <= -threshold) {
      belowThresholdArmed_ = true;
    }
    const bool crossedUp = belowThresholdArmed_ && smoothedSignal_ >= threshold;
    if (!crossedUp) {
      if (lastCrossingAtMs_ > 0 && sample.capturedAtMs - lastCrossingAtMs_ > 15000UL) {
        bpm_ = 0.0f;
      }
      return;
    }
    belowThresholdArmed_ = false;

    if (lastCrossingAtMs_ > 0) {
      const unsigned long periodMs = sample.capturedAtMs - lastCrossingAtMs_;
      if (periodMs >= 2500UL && periodMs <= 10000UL) {
        const float instantBpm = 60000.0f / static_cast<float>(periodMs);
        bpm_ = bpm_ <= 0.0f ? instantBpm : bpm_ * 0.70f + instantBpm * 0.30f;
      }
    }
    lastCrossingAtMs_ = sample.capturedAtMs;
  }

  float bpm() const {
    return bpm_;
  }

 private:
  bool initialized_ = false;
  bool belowThresholdArmed_ = false;
  float baselineSignal_ = 0.0f;
  float smoothedSignal_ = 0.0f;
  unsigned long lastCrossingAtMs_ = 0;
  float bpm_ = 0.0f;
};

Max30102RawReader ppgReader;
HeartRateEstimator heartRateEstimator;
ImuRespirationEstimator imuRespirationEstimator;
PressureRespirationEstimator pressureRespirationEstimator;
PressureFilmRawReader pressureReader;
Adafruit_DRV2605 hapticDriver;
TwoWire secondaryWire(1);
TwoWire* sensorWire = &Wire;
TwoWire* hapticWire = &Wire;
BLECharacteristic* bleEventCharacteristic = nullptr;
BLECharacteristic* bleCommandCharacteristic = nullptr;
SemaphoreHandle_t bleNotifyMutex = nullptr;

bool mpuReady = false;
bool ppgReady = false;
bool pressureReady = false;
bool hapticReady = false;
volatile bool bleClientConnected = false;
uint8_t activeMpuAddress = 0;
bool hapticOutputEnabled = false;
volatile bool breathGuideEnabled = false;
volatile bool calibrationRunning = false;
volatile bool calibrationCompleted = false;
uint8_t currentHapticRtp = 0;
uint8_t breathHapticStep = 0;
uint8_t activeLedIndex = 0;
bool heaterEnabled = false;
bool boardHeartbeatOn = false;
bool mpuAddressLowSeen = false;
bool mpuAddressHighSeen = false;
bool max30102Seen = false;
bool drv2605Seen = false;
uint8_t activeMpuWhoAmI = 0;
const char* activeMpuModelName = "MISS";

unsigned long lastMpuPollAtMs = 0;
unsigned long lastPpgPollAtMs = 0;
unsigned long lastPressurePollAtMs = 0;
unsigned long lastStatusLogAtMs = 0;
unsigned long lastBleNotifyAtMs = 0;
unsigned long lastBleWaveNotifyAtMs = 0;
unsigned long lastReconnectAtMs = 0;
unsigned long lastHapticToggleAtMs = 0;
volatile unsigned long breathGuideStartedAtMs = 0;
volatile unsigned long calibrationStartedAtMs = 0;
unsigned long lastLedRunnerAtMs = 0;
unsigned long lastBoardHeartbeatAtMs = 0;
uint32_t lastPpgSequence = 0;
uint32_t bleNotifySequence = 0;
unsigned long fingerPressureStartedAtMs = 0;
bool fingerPressureReady = false;

bool runImuRespirationSelfTest() {
  ImuRespirationEstimator estimator;
  estimator.reset(0);
  for (uint32_t atMs = 0; atMs <= 35000; atMs += kMpuPollIntervalMs) {
    ImuRespirationEstimator::Sample sample;
    sample.capturedAtMs = atMs;
    sample.accelZg = 1.0f + 0.02f * sinf(2.0f * PI * static_cast<float>(atMs) / 5000.0f);
    estimator.addSample(sample);
  }
  const bool detected = estimator.bpm() >= 11.0f && estimator.bpm() <= 13.0f;
  ImuRespirationEstimator::Sample motionSample;
  motionSample.capturedAtMs = 35020;
  motionSample.accelZg = 1.0f;
  motionSample.gyroXdps = 50.0f;
  estimator.addSample(motionSample);
  const bool motionRejected = estimator.bpm() == 0.0f;

  ImuRespirationEstimator crossAxisEstimator;
  crossAxisEstimator.reset(0);
  for (uint32_t atMs = 0; atMs <= 35000; atMs += kMpuPollIntervalMs) {
    ImuRespirationEstimator::Sample sample;
    sample.capturedAtMs = atMs;
    sample.accelXg = 0.02f * sinf(2.0f * PI * static_cast<float>(atMs) / 5000.0f);
    sample.accelZg = 1.0f;
    crossAxisEstimator.addSample(sample);
  }
  ImuRespirationEstimator lowAmplitudeEstimator;
  lowAmplitudeEstimator.reset(0);
  for (uint32_t atMs = 0; atMs <= 40000; atMs += kMpuPollIntervalMs) {
    ImuRespirationEstimator::Sample sample;
    sample.capturedAtMs = atMs;
    sample.accelZg = 1.0f + 0.003f * sinf(2.0f * PI * static_cast<float>(atMs) / 5000.0f);
    lowAmplitudeEstimator.addSample(sample);
  }
  const bool lowAmplitudeDetected = lowAmplitudeEstimator.bpm() >= 11.0f &&
      lowAmplitudeEstimator.bpm() <= 13.0f;
  ImuRespirationEstimator fastBreathEstimator;
  fastBreathEstimator.reset(0);
  for (uint32_t atMs = 0; atMs <= 25000; atMs += kMpuPollIntervalMs) {
    ImuRespirationEstimator::Sample sample;
    sample.capturedAtMs = atMs;
    sample.accelZg = 1.0f + 0.02f * sinf(2.0f * PI * static_cast<float>(atMs) / 1667.0f);
    fastBreathEstimator.addSample(sample);
  }
  const bool fastBreathRejected = fastBreathEstimator.bpm() == 0.0f;

  ImuRespirationEstimator staleEstimator;
  staleEstimator.reset(0);
  for (uint32_t atMs = 0; atMs <= 35000; atMs += kMpuPollIntervalMs) {
    ImuRespirationEstimator::Sample sample;
    sample.capturedAtMs = atMs;
    sample.accelZg = 1.0f + 0.02f * sinf(2.0f * PI * static_cast<float>(atMs) / 5000.0f);
    staleEstimator.addSample(sample);
  }
  for (uint32_t atMs = 35020; atMs <= 52000; atMs += kMpuPollIntervalMs) {
    ImuRespirationEstimator::Sample sample;
    sample.capturedAtMs = atMs;
    sample.accelZg = 1.0f;
    staleEstimator.addSample(sample);
  }
  const bool staleCandidateExpired = staleEstimator.bpm() == 0.0f &&
      staleEstimator.candidateBpm() == 0.0f && staleEstimator.consistentCycleCount() == 0;

  ImuRespirationEstimator relearnEstimator;
  relearnEstimator.reset(0);
  for (uint32_t atMs = 0; atMs <= 36000; atMs += kMpuPollIntervalMs) {
    ImuRespirationEstimator::Sample sample;
    sample.capturedAtMs = atMs;
    if (atMs <= 3000) {
      sample.accelXg = 0.03f * sinf(2.0f * PI * static_cast<float>(atMs) / 400.0f);
    } else {
      sample.accelZg = 1.0f + 0.012f * sinf(2.0f * PI * static_cast<float>(atMs) / 5000.0f);
    }
    relearnEstimator.addSample(sample);
  }
  const bool relearnedAxis = relearnEstimator.axis() == 'z' &&
      relearnEstimator.bpm() >= 11.0f && relearnEstimator.bpm() <= 13.0f;
  return detected && motionRejected && crossAxisEstimator.axis() == 'x' &&
      crossAxisEstimator.bpm() >= 11.0f && crossAxisEstimator.bpm() <= 13.0f &&
      lowAmplitudeDetected && fastBreathRejected && staleCandidateExpired && relearnedAxis;
}

MpuSample lastMpuSample{};
MpuMetrics lastMpuMetrics{};
Max30102RawReader::Sample lastPpgSample{};
PressureFilmRawReader::Sample lastPressureSample{};

constexpr ImuIdentity kSupportedImuIdentities[] = {
  {0x68, "MPU6050/MPU6000", 340.0f, 36.53f},
  {0x70, "MPU6500", 333.87f, 21.0f},
  {0x71, "MPU9250/MPU9255-family", 333.87f, 21.0f},
  {0x73, "MPU9255", 333.87f, 21.0f},
};

float convertAccelToG(int16_t rawAcceleration) {
  return static_cast<float>(rawAcceleration) / kAccelScaleLsbPerG;
}

float convertGyroToDegreesPerSecond(int16_t rawGyro) {
  return static_cast<float>(rawGyro) / kGyroScaleLsbPerDps;
}

const ImuIdentity* identifyImu(uint8_t whoAmI) {
  for (const ImuIdentity& identity : kSupportedImuIdentities) {
    if (identity.whoAmI == whoAmI) {
      return &identity;
    }
  }

  return nullptr;
}

float convertTemperatureCelsius(int16_t rawTemperature) {
  const ImuIdentity* identity = identifyImu(activeMpuWhoAmI);
  if (identity == nullptr) {
    return static_cast<float>(rawTemperature) / 340.0f + 36.53f;
  }

  return static_cast<float>(rawTemperature) / identity->temperatureScale + identity->temperatureOffset;
}

const char* currentLedLabel() {
  switch (activeLedIndex) {
    case 0:
      return "R";
    case 1:
      return "G";
    case 2:
      return "B";
    default:
      return "-";
  }
}

char visibleFlag(bool visible) {
  return visible ? 'Y' : 'N';
}

void setHapticRtp(uint8_t rtp) {
  currentHapticRtp = rtp;
  hapticOutputEnabled = rtp > 0;
  if (hapticReady) {
    hapticDriver.setRealtimeValue(rtp);
  }
}

const char* motionLabel() {
  const float gx = fabs(lastMpuMetrics.gyroXdps);
  const float gy = fabs(lastMpuMetrics.gyroYdps);
  const float gz = fabs(lastMpuMetrics.gyroZdps);
  float strongestGyro = gx;
  if (gy > strongestGyro) {
    strongestGyro = gy;
  }
  if (gz > strongestGyro) {
    strongestGyro = gz;
  }
  if (!mpuReady) {
    return "imu-miss";
  }
  if (strongestGyro > 80.0f) {
    return "active";
  }
  if (strongestGyro > 25.0f) {
    return "moving";
  }
  return "still";
}

const char* guidePhaseLabel() {
  if (calibrationRunning) {
    return "c";
  }
  if (!breathGuideEnabled) {
    return "n";
  }
  return (breathHapticStep % 40) < 20 ? "i" : "e";
}

const char* packetTypeAlias(const char* packetType) {
  if (strcmp(packetType, "telemetry") == 0) return "tel";
  if (strcmp(packetType, "breath_started") == 0) return "b_start";
  if (strcmp(packetType, "breath_stopped") == 0) return "b_stop";
  if (strcmp(packetType, "calibration_started") == 0) return "cal_start";
  if (strcmp(packetType, "calibration_done") == 0) return "cal_done";
  return packetType;
}

String buildBleStatusJson(const char* packetType) {
  String payload = "{";
  payload += "\"t\":\"";
  payload += packetTypeAlias(packetType);
  payload += "\",\"seq\":";
  payload += String(++bleNotifySequence);
  payload += ",\"br\":";
  const float imuBreathBpm = mpuReady && !breathGuideEnabled && !calibrationRunning && !hapticOutputEnabled
      ? imuRespirationEstimator.bpm()
      : 0.0f;
  const bool wearSignalPresent = heartRateEstimator.contactPresent() || lastPressureSample.level > 0 || imuBreathBpm > 0.0f;
  const float pressureBreathBpm = pressureReady && wearSignalPresent && !breathGuideEnabled && !calibrationRunning && !hapticOutputEnabled
      ? pressureRespirationEstimator.bpm()
      : 0.0f;
  const float breathBpm = imuBreathBpm > 0.0f ? imuBreathBpm : pressureBreathBpm;
  payload += (breathBpm > 0.0f ? String(breathBpm, 1) : "0");
  payload += ",\"bs\":\"";
  payload += imuBreathBpm > 0.0f ? "imu" : (pressureBreathBpm > 0.0f ? "pressure" : "none");
  payload += "\"";
  payload += ",\"bd\":\"";
  payload += imuRespirationEstimator.status();
  payload += "\",\"bx\":";
  payload += String(imuRespirationEstimator.candidateBpm(), 1);
  payload += ",\"bn\":";
  payload += String(imuRespirationEstimator.consistentCycleCount());
  payload += ",\"ba\":";
  payload += String(imuRespirationEstimator.cycleThresholdG(), 4);
  payload += ",\"hr\":";
  payload += (heartRateEstimator.bpm() > 0.0f ? String(heartRateEstimator.bpm(), 1) : "0");
  payload += ",\"bt\":";
  payload += String(lastMpuMetrics.temperatureC, 1);
  payload += ",\"bc\":";
  payload += String(heartRateEstimator.beatCount());
  payload += ",\"ph\":\"";
  payload += guidePhaseLabel();
  payload += "\",\"hp\":";
  payload += (hapticReady ? "1" : "0");
  payload += ",\"bg\":";
  payload += (breathGuideEnabled ? "1" : "0");
  payload += ",\"cg\":";
  payload += (calibrationRunning ? "1" : "0");
  payload += ",\"mo\":\"";
  payload += motionLabel();
  payload += "\",\"mr\":";
  payload += (mpuReady ? "1" : "0");
  payload += ",\"pp\":";
  payload += (ppgReady ? "1" : "0");
  payload += ",\"p57\":";
  payload += (max30102Seen ? "1" : "0");
  payload += ",\"pid\":";
  payload += String(ppgReader.partId());
  payload += ",\"pe\":\"";
  payload += ppgReader.lastError();
  payload += "\"";
  payload += ",\"ps\":";
  payload += (pressureReady ? "1" : "0");
  payload += ",\"pr\":";
  payload += String(lastPressureSample.rawAverage);
  payload += ",\"pl\":";
  payload += String(lastPressureSample.level);
  payload += ",\"fp\":";
  payload += (fingerPressureReady ? "1" : "0");
  payload += ",\"ir\":";
  payload += String(lastPpgSample.ir);
  payload += ",\"red\":";
  payload += String(lastPpgSample.red);
  payload += ",\"ct\":";
  payload += (heartRateEstimator.contactPresent() ? "1" : "0");
  payload += ",\"wear\":";
  payload += (wearSignalPresent ? "1" : "0");
  payload += ",\"cc\":";
  payload += (calibrationCompleted ? "1" : "0");
  payload += "}";
  return payload;
}

void notifyBlePayload(const String& payload) {
  if (bleEventCharacteristic == nullptr || !bleClientConnected) {
    return;
  }

  if (bleNotifyMutex != nullptr && xSemaphoreTake(bleNotifyMutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
    Serial.println("[ble][warn] notify mutex timeout");
    return;
  }

  for (size_t offset = 0; offset < payload.length(); offset += kBleNotifyChunkBytes) {
    const String chunk = payload.substring(offset, offset + kBleNotifyChunkBytes);
    bleEventCharacteristic->setValue(chunk.c_str());
    bleEventCharacteristic->notify();
    delay(kBleNotifyChunkGapMs);
  }
  if (bleNotifyMutex != nullptr) {
    xSemaphoreGive(bleNotifyMutex);
  }
}

void notifyBleStatus(const char* packetType) {
  notifyBlePayload(buildBleStatusJson(packetType));
}

void notifyBleWave() {
  const String payload = "W," + String(lastPpgSample.ir) + "," + String(lastPressureSample.rawAverage);
  notifyBlePayload(payload);
}

void notifyCalibrationDoneBurst() {
  const String payload = buildBleStatusJson("calibration_done");
  for (uint8_t index = 0; index < 3; ++index) {
    notifyBlePayload(payload);
    delay(35);
  }
}

void stopGuidedFeedback() {
  breathGuideEnabled = false;
  breathGuideStartedAtMs = 0;
  calibrationRunning = false;
  setHapticRtp(0);
}

void handleBleCommand(const String& command) {
  Serial.println("[ble][cmd] " + command);
  if (command.indexOf("breath_start") >= 0) {
    calibrationRunning = false;
    calibrationCompleted = false;
    imuRespirationEstimator.reset(millis());
    pressureRespirationEstimator.reset();
    breathGuideEnabled = true;
    breathGuideStartedAtMs = millis();
    breathHapticStep = 0;
    lastHapticToggleAtMs = 0;
    notifyBleStatus("breath_started");
    return;
  }

  if (command.indexOf("breath_stop") >= 0) {
    stopGuidedFeedback();
    notifyBleStatus("breath_stopped");
    return;
  }

  if (command.indexOf("calibrate_start") >= 0) {
    breathGuideEnabled = false;
    calibrationCompleted = false;
    imuRespirationEstimator.reset(millis());
    pressureRespirationEstimator.reset();
    calibrationStartedAtMs = millis();
    lastHapticToggleAtMs = 0;
    calibrationRunning = true;
    notifyBleStatus("calibration_started");
    return;
  }

  notifyBleStatus("unknown_command");
}

class IntegratedCommandCallbacks final : public BLECharacteristicCallbacks {
 public:
  void onWrite(BLECharacteristic* characteristic) override {
    const std::string value = characteristic->getValue();
    String command(value.c_str());
    command.trim();
    handleBleCommand(command);
  }
};

class IntegratedServerCallbacks final : public BLEServerCallbacks {
 public:
  void onConnect(BLEServer*) override {
    bleClientConnected = true;
    Serial.println("[ble] client connected");
    notifyBleStatus("connected");
  }

  void onDisconnect(BLEServer*) override {
    bleClientConnected = false;
    stopGuidedFeedback();
    Serial.println("[ble] client disconnected, restart advertising");
    BLEDevice::startAdvertising();
  }
};

void setupBle() {
  BLEDevice::init(kBleDeviceName);
  BLEDevice::setMTU(247);

  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new IntegratedServerCallbacks());

  BLEService* service = server->createService(kBleServiceUuid);
  bleEventCharacteristic = service->createCharacteristic(kBleEventUuid, BLECharacteristic::PROPERTY_NOTIFY);
  bleEventCharacteristic->addDescriptor(new BLE2902());

  bleCommandCharacteristic = service->createCharacteristic(
      kBleCommandUuid,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  bleCommandCharacteristic->setCallbacks(new IntegratedCommandCallbacks());

  service->start();
  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(service->getUUID());
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("[ble] advertising HOLD-INTEGRATED");
}

void logBootStage(const char* stage) {
  Serial.printf("[smoke][boot] %s\n", stage);
}

void writeBoardLed(bool turnOn) {
  digitalWrite(
      project_config::kUserLedPin,
      turnOn ? project_config::kLedOnLevel : project_config::kLedOffLevel);
  boardHeartbeatOn = turnOn;
}

void pulseBoardLed(uint8_t count) {
  for (uint8_t index = 0; index < count; ++index) {
    writeBoardLed(true);
    delay(kStagePulseOnMs);
    writeBoardLed(false);
    delay(kStagePulseOffMs);
  }

  delay(kStagePulseGapMs);
}

void logWiringGuide() {
  Serial.println("[smoke][wiring] 主 I2C: D4(GPIO5)=SDA, D5(GPIO6)=SCL -> MPU6050 + MAX30102 + DRV2605L");
  Serial.println("[smoke][wiring] 压力 AO: D0/A0(GPIO1)");
  Serial.println("[smoke][wiring] 热反馈控制: D1/A1(GPIO2) -> MOSFET Gate，仅 PWM 控制，禁止直驱加热片");
  Serial.println("[smoke][wiring] RGB 流水灯: D8(GPIO7)=R, D9(GPIO8)=G, D10(GPIO9)=B，共阴极接 GND");
  Serial.println("[smoke][wiring] 板载状态灯: GPIO21，低电平点亮，用于阶段报码与运行心跳");
}

bool probeI2cAddress(TwoWire& wireBus, uint8_t address) {
  wireBus.beginTransmission(address);
  return wireBus.endTransmission() == 0;
}

void scanI2cPins(uint8_t sdaPin, uint8_t sclPin, const char* label) {
  Wire.begin(sdaPin, sclPin);
  Wire.setClock(project_config::kI2cClockHz);
  Wire.setTimeOut(kI2cTimeoutMs);
  delay(25);

  String foundAddresses;
  for (uint8_t address = 0x08; address <= 0x77; ++address) {
    if (!probeI2cAddress(Wire, address)) {
      continue;
    }
    if (!foundAddresses.isEmpty()) {
      foundAddresses += ',';
    }
    char hexAddress[5];
    snprintf(hexAddress, sizeof(hexAddress), "0x%02X", address);
    foundAddresses += hexAddress;
  }
  if (foundAddresses.isEmpty()) {
    foundAddresses = "none";
  }

  Serial.printf(
      "[smoke][i2c-scan] %s SDA=GPIO%u SCL=GPIO%u | found=%s | 57=%c 68=%c 69=%c 5A=%c | idle SDA=%c SCL=%c\n",
      label,
      static_cast<unsigned>(sdaPin),
      static_cast<unsigned>(sclPin),
      foundAddresses.c_str(),
      visibleFlag(probeI2cAddress(Wire, project_config::kMax30102Address)),
      visibleFlag(probeI2cAddress(Wire, kMpuAddressLow)),
      visibleFlag(probeI2cAddress(Wire, kMpuAddressHigh)),
      visibleFlag(probeI2cAddress(Wire, kDrv2605Address)),
      digitalRead(sdaPin) == HIGH ? 'H' : 'L',
      digitalRead(sclPin) == HIGH ? 'H' : 'L');
  Wire.end();
}

void scanCandidateI2cPins() {
  Serial.println("[smoke][i2c-scan] begin three-bus probe, normal then SDA/SCL reversed");
  scanI2cPins(kLegacyI2cSdaPin, kLegacyI2cSclPin, "D2/D3 legacy");
  scanI2cPins(kLegacyI2cSclPin, kLegacyI2cSdaPin, "D2/D3 reversed");
  scanI2cPins(project_config::kI2cSdaPin, project_config::kI2cSclPin, "D4/D5 primary");
  scanI2cPins(project_config::kI2cSclPin, project_config::kI2cSdaPin, "D4/D5 reversed");
  scanI2cPins(kSecondaryI2cSdaPin, kSecondaryI2cSclPin, "D6/D7 secondary");
  scanI2cPins(kSecondaryI2cSclPin, kSecondaryI2cSdaPin, "D6/D7 reversed");
  Serial.println("[smoke][i2c-scan] end; restoring integrated buses");
}

void refreshI2cVisibility() {
  mpuAddressLowSeen = probeI2cAddress(*sensorWire, kMpuAddressLow);
  mpuAddressHighSeen = probeI2cAddress(*sensorWire, kMpuAddressHigh);
  max30102Seen = probeI2cAddress(*sensorWire, project_config::kMax30102Address);
  drv2605Seen = probeI2cAddress(*hapticWire, kDrv2605Address);
}

void selectI2cBuses() {
  const bool primaryHasSensor =
      probeI2cAddress(Wire, project_config::kMax30102Address) ||
      probeI2cAddress(Wire, kMpuAddressLow) ||
      probeI2cAddress(Wire, kMpuAddressHigh);
  const bool secondaryHasSensor =
      probeI2cAddress(secondaryWire, project_config::kMax30102Address) ||
      probeI2cAddress(secondaryWire, kMpuAddressLow) ||
      probeI2cAddress(secondaryWire, kMpuAddressHigh);

  sensorWire = !primaryHasSensor && secondaryHasSensor ? &secondaryWire : &Wire;
  hapticWire = probeI2cAddress(Wire, kDrv2605Address) ||
                       !probeI2cAddress(secondaryWire, kDrv2605Address)
                   ? &Wire
                   : &secondaryWire;

  Serial.printf(
      "[smoke][i2c] sensors=%s haptic=%s\n",
      sensorWire == &Wire ? "D4/D5" : "D6/D7",
      hapticWire == &Wire ? "D4/D5" : "D6/D7");
}

bool readMpuRegister(uint8_t address, uint8_t reg, uint8_t& value) {
  sensorWire->beginTransmission(address);
  sensorWire->write(reg);
  if (sensorWire->endTransmission(false) != 0) {
    return false;
  }

  const uint8_t bytesRead = sensorWire->requestFrom(address, static_cast<uint8_t>(1), static_cast<uint8_t>(true));
  if (bytesRead != 1) {
    return false;
  }

  value = sensorWire->read();
  return true;
}

bool writeMpuRegister(uint8_t address, uint8_t reg, uint8_t value) {
  sensorWire->beginTransmission(address);
  sensorWire->write(reg);
  sensorWire->write(value);
  return sensorWire->endTransmission() == 0;
}

bool readMpuSample(uint8_t address, MpuSample& sample) {
  sensorWire->beginTransmission(address);
  sensorWire->write(kMpuRegisterAccelXoutH);
  if (sensorWire->endTransmission(false) != 0) {
    return false;
  }

  const uint8_t bytesRequested = 14;
  const uint8_t bytesRead = sensorWire->requestFrom(address, bytesRequested, static_cast<uint8_t>(true));
  if (bytesRead != bytesRequested) {
    return false;
  }

  sample.accelX = static_cast<int16_t>((sensorWire->read() << 8) | sensorWire->read());
  sample.accelY = static_cast<int16_t>((sensorWire->read() << 8) | sensorWire->read());
  sample.accelZ = static_cast<int16_t>((sensorWire->read() << 8) | sensorWire->read());
  sample.temperatureRaw = static_cast<int16_t>((sensorWire->read() << 8) | sensorWire->read());
  sample.gyroX = static_cast<int16_t>((sensorWire->read() << 8) | sensorWire->read());
  sample.gyroY = static_cast<int16_t>((sensorWire->read() << 8) | sensorWire->read());
  sample.gyroZ = static_cast<int16_t>((sensorWire->read() << 8) | sensorWire->read());
  sample.capturedAtMs = millis();
  return true;
}

bool initializeMpuAt(uint8_t address) {
  uint8_t whoAmI = 0;
  if (!readMpuRegister(address, kMpuRegisterWhoAmI, whoAmI)) {
    return false;
  }

  const ImuIdentity* identity = identifyImu(whoAmI);
  if (identity == nullptr) {
    return false;
  }

  if (!writeMpuRegister(address, kMpuRegisterPowerManagement1, 0x00)) {
    return false;
  }

  activeMpuAddress = address;
  activeMpuWhoAmI = whoAmI;
  activeMpuModelName = identity->modelName;
  return true;
}

bool initializeMpu() {
  refreshI2cVisibility();
  activeMpuWhoAmI = 0;
  activeMpuModelName = "MISS";

  if (probeI2cAddress(*sensorWire, kMpuAddressLow) && initializeMpuAt(kMpuAddressLow)) {
    return true;
  }

  if (probeI2cAddress(*sensorWire, kMpuAddressHigh) && initializeMpuAt(kMpuAddressHigh)) {
    return true;
  }

  activeMpuAddress = 0;
  return false;
}

bool initializePpg() {
  heartRateEstimator.reset();
  refreshI2cVisibility();
  return ppgReader.begin(*sensorWire);
}

bool initializePressure() {
  return pressureReader.begin();
}

bool initializeHaptic() {
  refreshI2cVisibility();
  if (!hapticDriver.begin(hapticWire)) {
    return false;
  }

  hapticDriver.useLRA();
  hapticDriver.selectLibrary(6);
  hapticDriver.setMode(DRV2605_MODE_REALTIME);
  hapticDriver.setRealtimeValue(0x00);
  currentHapticRtp = 0;
  hapticOutputEnabled = false;
  return true;
}

void setupHeaterPwm() {
  ledcSetup(kHeaterPwmChannel, kHeaterPwmFrequencyHz, kHeaterPwmResolutionBits);
  ledcAttachPin(kHeaterControlPin, kHeaterPwmChannel);
  ledcWrite(kHeaterPwmChannel, 0);
}

void updateHeaterOutput(unsigned long nowMs) {
  if (heaterEnabled || nowMs < kHeaterEnableDelayMs) {
    return;
  }

  heaterEnabled = true;
  ledcWrite(kHeaterPwmChannel, kHeaterPwmDuty80Percent);
  Serial.printf("[smoke][boot] heater-enabled duty=80%% gpio=%u\n", static_cast<unsigned>(kHeaterControlPin));
}

void setRgbState(bool redOn, bool greenOn, bool blueOn) {
  digitalWrite(kRgbRedPin, redOn ? HIGH : LOW);
  digitalWrite(kRgbGreenPin, greenOn ? HIGH : LOW);
  digitalWrite(kRgbBluePin, blueOn ? HIGH : LOW);
}

void runRgbSelfTest() {
  Serial.println("[smoke][boot] rgb-self-test R");
  setRgbState(true, false, false);
  delay(kRgbSelfTestHoldMs);

  Serial.println("[smoke][boot] rgb-self-test G");
  setRgbState(false, true, false);
  delay(kRgbSelfTestHoldMs);

  Serial.println("[smoke][boot] rgb-self-test B");
  setRgbState(false, false, true);
  delay(kRgbSelfTestHoldMs);
}

void setupLedRunner() {
  pinMode(kRgbRedPin, OUTPUT);
  pinMode(kRgbGreenPin, OUTPUT);
  pinMode(kRgbBluePin, OUTPUT);
  runRgbSelfTest();
  setRgbState(true, false, false);
  activeLedIndex = 0;
}

void updateLedRunner(unsigned long nowMs) {
  if (nowMs - lastLedRunnerAtMs < kLedRunnerIntervalMs) {
    return;
  }

  lastLedRunnerAtMs = nowMs;
  if (calibrationRunning) {
    boardHeartbeatOn = !boardHeartbeatOn;
    setRgbState(false, boardHeartbeatOn, false);
    return;
  }

  if (breathGuideEnabled) {
    boardHeartbeatOn = !boardHeartbeatOn;
    setRgbState(boardHeartbeatOn, false, boardHeartbeatOn);
    return;
  }

  if (!bleClientConnected) {
    boardHeartbeatOn = !boardHeartbeatOn;
    setRgbState(false, false, boardHeartbeatOn);
    return;
  }

  if (calibrationCompleted) {
    setRgbState(false, true, false);
    return;
  }

  setRgbState(false, false, true);
}

void updateBoardHeartbeat(unsigned long nowMs) {
  if (nowMs - lastBoardHeartbeatAtMs < kBoardHeartbeatIntervalMs) {
    return;
  }

  lastBoardHeartbeatAtMs = nowMs;
  writeBoardLed(!boardHeartbeatOn);
}

void pollMpu() {
  MpuSample sample;
  if (!mpuReady || !readMpuSample(activeMpuAddress, sample)) {
    mpuReady = false;
    lastMpuMetrics = {};
    imuRespirationEstimator.reset(millis());
    return;
  }

  lastMpuSample = sample;
  lastMpuMetrics.accelXg = convertAccelToG(sample.accelX);
  lastMpuMetrics.accelYg = convertAccelToG(sample.accelY);
  lastMpuMetrics.accelZg = convertAccelToG(sample.accelZ);
  lastMpuMetrics.gyroXdps = convertGyroToDegreesPerSecond(sample.gyroX);
  lastMpuMetrics.gyroYdps = convertGyroToDegreesPerSecond(sample.gyroY);
  lastMpuMetrics.gyroZdps = convertGyroToDegreesPerSecond(sample.gyroZ);
  lastMpuMetrics.temperatureC = convertTemperatureCelsius(sample.temperatureRaw);
  ImuRespirationEstimator::Sample respirationSample;
  respirationSample.capturedAtMs = sample.capturedAtMs;
  respirationSample.accelXg = lastMpuMetrics.accelXg;
  respirationSample.accelYg = lastMpuMetrics.accelYg;
  respirationSample.accelZg = lastMpuMetrics.accelZg;
  respirationSample.gyroXdps = lastMpuMetrics.gyroXdps;
  respirationSample.gyroYdps = lastMpuMetrics.gyroYdps;
  respirationSample.gyroZdps = lastMpuMetrics.gyroZdps;
  if (breathGuideEnabled || calibrationRunning || hapticOutputEnabled) {
    imuRespirationEstimator.reset(sample.capturedAtMs);
  } else {
    imuRespirationEstimator.addSample(respirationSample);
  }
}

void pollPpg() {
  if (!ppgReady) {
    return;
  }

  if (!ppgReader.update()) {
    // An empty FIFO is normal between MAX30102 samples; only explicit read
    // errors mean the device is offline.
    if (strcmp(ppgReader.lastError(), "ok") != 0) {
      ppgReady = false;
      lastPpgSample = {};
      heartRateEstimator.reset();
    }
    return;
  }

  Max30102RawReader::Sample sample;
  if (!ppgReader.readLatestSample(sample)) {
    return;
  }

  if (sample.sequence == lastPpgSequence) {
    return;
  }

  lastPpgSequence = sample.sequence;
  lastPpgSample = sample;
  heartRateEstimator.addSample(sample);
}

void pollPressure() {
  if (!pressureReady || !pressureReader.update()) {
    pressureReady = false;
    lastPressureSample = {};
    pressureRespirationEstimator.reset();
    return;
  }

  pressureReader.readLatestSample(lastPressureSample);
  const bool fingerPressureActive =
      lastPressureSample.level >= kFingerPressureLevelThreshold ||
      lastPressureSample.rawAverage >= kFingerPressureRawThreshold;
  if (fingerPressureActive) {
    if (fingerPressureStartedAtMs == 0) {
      fingerPressureStartedAtMs = lastPressureSample.capturedAtMs;
    }
    fingerPressureReady =
        lastPressureSample.capturedAtMs - fingerPressureStartedAtMs >= kFingerPressureHoldMs;
  } else {
    fingerPressureStartedAtMs = 0;
    fingerPressureReady = false;
  }

  if (breathGuideEnabled || calibrationRunning || hapticOutputEnabled) {
    pressureRespirationEstimator.reset();
  } else {
    pressureRespirationEstimator.addPressureSample(
        lastPressureSample,
        pressureReader.peakDeltaRaw());
  }
}

void updateHapticPattern(unsigned long nowMs) {
  if (calibrationRunning) {
    if (nowMs - calibrationStartedAtMs >= kCalibrationDurationMs) {
      stopGuidedFeedback();
      calibrationCompleted = true;
      notifyCalibrationDoneBurst();
      return;
    }
  }

  if (breathGuideEnabled && breathGuideStartedAtMs > 0 &&
      nowMs - breathGuideStartedAtMs >= kBreathGuideDurationMs) {
    stopGuidedFeedback();
    notifyBleStatus("breath_stopped");
    return;
  }

  // Timers must finish even when DRV2605L is unavailable.
  if (!hapticReady) {
    return;
  }

  if (calibrationRunning) {

    if (nowMs - lastHapticToggleAtMs < kCalibrationPulseMs) {
      return;
    }

    lastHapticToggleAtMs = nowMs;
    setHapticRtp(hapticOutputEnabled ? 0x00 : 0x35);
    return;
  }

  if (breathGuideEnabled) {
    if (nowMs - lastHapticToggleAtMs < kBreathHapticStepMs) {
      return;
    }

    lastHapticToggleAtMs = nowMs;
    const uint8_t phase = breathHapticStep++ % 40;
    const uint8_t rtp = phase < 20 ? phase * 4 : (39 - phase) * 4;
    setHapticRtp(rtp);
    return;
  }

  if (currentHapticRtp != 0) {
    setHapticRtp(0);
  }

  if (nowMs - lastHapticToggleAtMs < kHapticToggleIntervalMs) {
    return;
  }

  lastHapticToggleAtMs = nowMs;
}

void tryReconnectAll(unsigned long nowMs) {
  if (nowMs - lastReconnectAtMs < kReconnectIntervalMs) {
    return;
  }

  lastReconnectAtMs = nowMs;
  refreshI2cVisibility();

  if (!mpuReady) {
    mpuReady = initializeMpu();
  }

  if (!ppgReady) {
    ppgReady = initializePpg();
  }

  if (!pressureReady) {
    pressureReady = initializePressure();
  }

  if (!hapticReady) {
    hapticReady = initializeHaptic();
  }
}

void printStatus(unsigned long nowMs) {
  refreshI2cVisibility();

  const float imuBreathBpm = imuRespirationEstimator.bpm();
  const float pressureBreathBpm = pressureRespirationEstimator.bpm();
  Serial.printf(
    "[smoke] up=%lums | i2c 57=%c 68=%c 69=%c 5A=%c | imu=%s model=%s ax=%0.3f ay=%0.3f az=%0.3f gx=%0.1f gy=%0.1f gz=%0.1f temp=%0.2f | ppg=%s err=%s ir=%lu red=%lu bpm=%0.1f beat=%s contact=%s | pressure=%s raw=%u level=%u | breath=%0.1f src=%s imu=%0.1f pressure=%0.1f axis=%c gate=%c signal=%0.4f status=%s candidate=%0.1f cycles=%u threshold=%0.4f | motor=%s rtp=%u | heater=%s pin=GPIO%u ctrl_only | led=%s\n",
      nowMs,
      visibleFlag(max30102Seen),
      visibleFlag(mpuAddressLowSeen),
      visibleFlag(mpuAddressHighSeen),
      visibleFlag(drv2605Seen),
      mpuReady ? "OK" : "MISS",
    activeMpuModelName,
      lastMpuMetrics.accelXg,
      lastMpuMetrics.accelYg,
      lastMpuMetrics.accelZg,
      lastMpuMetrics.gyroXdps,
      lastMpuMetrics.gyroYdps,
      lastMpuMetrics.gyroZdps,
      lastMpuMetrics.temperatureC,
      ppgReady ? "OK" : "MISS",
      ppgReader.lastError(),
      static_cast<unsigned long>(lastPpgSample.ir),
      static_cast<unsigned long>(lastPpgSample.red),
      heartRateEstimator.bpm(),
      heartRateEstimator.beatDetectedRecently() ? "Y" : "N",
      heartRateEstimator.contactPresent() ? "Y" : "N",
      pressureReady ? "OK" : "MISS",
      static_cast<unsigned>(lastPressureSample.rawAverage),
      static_cast<unsigned>(lastPressureSample.level),
      imuBreathBpm > 0.0f ? imuBreathBpm : pressureBreathBpm,
      imuBreathBpm > 0.0f ? "imu" : (pressureBreathBpm > 0.0f ? "pressure" : "none"),
      imuBreathBpm,
      pressureBreathBpm,
      imuRespirationEstimator.axis(),
      imuRespirationEstimator.motionGated() ? 'Y' : 'N',
      imuRespirationEstimator.signalG(),
      imuRespirationEstimator.status(),
      imuRespirationEstimator.candidateBpm(),
      static_cast<unsigned>(imuRespirationEstimator.consistentCycleCount()),
      imuRespirationEstimator.cycleThresholdG(),
      hapticReady ? (hapticOutputEnabled ? "ON" : "OFF") : "MISS",
      static_cast<unsigned>(currentHapticRtp),
      heaterEnabled ? "PWM80" : "WAIT",
      static_cast<unsigned>(kHeaterControlPin),
      currentLedLabel());
}

}  // namespace

void setup() {
  pinMode(project_config::kUserLedPin, OUTPUT);
  writeBoardLed(false);
  pulseBoardLed(1);

  Serial.begin(kSerialBaudRate);
  bleNotifyMutex = xSemaphoreCreateMutex();
  delay(kStartupDelayMs);
  Serial.printf("[self-test] imu-respiration=%s\n", runImuRespirationSelfTest() ? "PASS" : "FAIL");

  const unsigned long serialAttachStartedAtMs = millis();
  while (!Serial && (millis() - serialAttachStartedAtMs) < kSerialAttachWaitMs) {
    delay(10);
  }

  logBootStage("serial-ready");
  pulseBoardLed(2);

  scanCandidateI2cPins();
  Wire.begin(project_config::kI2cSdaPin, project_config::kI2cSclPin);
  Wire.setClock(project_config::kI2cClockHz);
  secondaryWire.begin(kSecondaryI2cSdaPin, kSecondaryI2cSclPin, project_config::kI2cClockHz);
  selectI2cBuses();
  Wire.setTimeOut(kI2cTimeoutMs);
  refreshI2cVisibility();

  logBootStage("i2c-ready");
  pulseBoardLed(3);

  logWiringGuide();
  setupLedRunner();

  logBootStage("init-mpu-start");
  mpuReady = initializeMpu();
  Serial.printf("[smoke][boot] init-mpu-%s\n", mpuReady ? "ok" : "miss");
  if (mpuReady) {
    Serial.printf("[smoke][boot] init-mpu-model=%s who=0x%02X addr=0x%02X\n", activeMpuModelName, activeMpuWhoAmI, activeMpuAddress);
  }
  pulseBoardLed(mpuReady ? 4 : 9);

  logBootStage("init-ppg-start");
  ppgReady = initializePpg();
  Serial.printf("[smoke][boot] init-ppg-%s err=%s\n", ppgReady ? "ok" : "miss", ppgReader.lastError());
  pulseBoardLed(ppgReady ? 5 : 9);

  logBootStage("init-pressure-start");
  pressureReady = initializePressure();
  Serial.printf("[smoke][boot] init-pressure-%s\n", pressureReady ? "ok" : "miss");
  pulseBoardLed(pressureReady ? 6 : 9);

  logBootStage("init-haptic-start");
  hapticReady = initializeHaptic();
  Serial.printf("[smoke][boot] init-haptic-%s\n", hapticReady ? "ok" : "miss");
  pulseBoardLed(hapticReady ? 7 : 9);

  logBootStage("heater-pwm-arm");
  setupHeaterPwm();
  pulseBoardLed(8);

  Serial.printf(
      "[smoke] init | i2c 57=%c 68=%c 69=%c 5A=%c | imu=%s | ppg=%s | pressure=%s | motor=%s | heater=wait->80%% gpio=%u | led_runner=D8/D9/D10\n",
      visibleFlag(max30102Seen),
      visibleFlag(mpuAddressLowSeen),
      visibleFlag(mpuAddressHighSeen),
      visibleFlag(drv2605Seen),
      mpuReady ? "OK" : "MISS",
      ppgReady ? "OK" : "MISS",
      pressureReady ? "OK" : "MISS",
      hapticReady ? "OK" : "MISS",
      static_cast<unsigned>(kHeaterControlPin));

  logBootStage("ble-start");
  setupBle();

  logBootStage("setup-done");
  writeBoardLed(false);
}

void loop() {
  const unsigned long nowMs = millis();

  tryReconnectAll(nowMs);

  if (nowMs - lastMpuPollAtMs >= kMpuPollIntervalMs) {
    lastMpuPollAtMs = nowMs;
    pollMpu();
  }

  if (nowMs - lastPpgPollAtMs >= kPpgPollIntervalMs) {
    lastPpgPollAtMs = nowMs;
    pollPpg();
  }

  if (nowMs - lastPressurePollAtMs >= kPressurePollIntervalMs) {
    lastPressurePollAtMs = nowMs;
    pollPressure();
  }

  updateHapticPattern(nowMs);
  updateLedRunner(nowMs);
  updateHeaterOutput(nowMs);
  updateBoardHeartbeat(nowMs);

  if (nowMs - lastStatusLogAtMs >= kStatusLogIntervalMs) {
    lastStatusLogAtMs = nowMs;
    printStatus(nowMs);
  }

  if (nowMs - lastBleNotifyAtMs >= kBleNotifyIntervalMs) {
    lastBleNotifyAtMs = nowMs;
    notifyBleStatus("telemetry");
  }

  if (nowMs - lastBleWaveNotifyAtMs >= kBleWaveNotifyIntervalMs) {
    lastBleWaveNotifyAtMs = nowMs;
    notifyBleWave();
  }
}
