#pragma once

#include <stdint.h>

class ImuRespirationEstimator {
 public:
  struct Sample {
    uint32_t capturedAtMs = 0;
    float accelXg = 0.0f;
    float accelYg = 0.0f;
    float accelZg = 0.0f;
    float gyroXdps = 0.0f;
    float gyroYdps = 0.0f;
    float gyroZdps = 0.0f;
  };

  void reset(uint32_t nowMs = 0);
  void addSample(const Sample& sample);
  float bpm() const;
  float signalG() const;
  float candidateBpm() const;
  float cycleThresholdG() const;
  uint8_t consistentCycleCount() const;
  const char* status() const;
  bool motionGated() const;
  char axis() const;

 private:
  static float norm(float x, float y, float z);
  void acceptPeak(uint32_t atMs, float valueG);
  void acceptTrough(uint32_t atMs, float valueG);

  bool initialized_ = false;
  bool axisLocked_ = false;
  bool detectorPrimed_ = false;
  bool motionGated_ = false;
  bool hasPeak_ = false;
  bool hasTrough_ = false;
  uint8_t axisIndex_ = 2;
  uint32_t startedAtMs_ = 0;
  uint32_t axisLockedAtMs_ = 0;
  uint32_t latestSampleAtMs_ = 0;
  uint32_t lastPeakAtMs_ = 0;
  uint32_t lastTroughAtMs_ = 0;
  uint32_t lastAcceptedAtMs_ = 0;
  uint32_t candidateUpdatedAtMs_ = 0;
  uint32_t lastMotionAtMs_ = 0;
  float baselineG_[3] = {0.0f, 0.0f, 0.0f};
  float filteredG_[3] = {0.0f, 0.0f, 0.0f};
  float warmupMinG_[3] = {0.0f, 0.0f, 0.0f};
  float warmupMaxG_[3] = {0.0f, 0.0f, 0.0f};
  float detectionFilteredG_ = 0.0f;
  float previousDetectionFilteredG_ = 0.0f;
  float previousSlope_ = 0.0f;
  float lastPeakValueG_ = 0.0f;
  float lastTroughValueG_ = 0.0f;
  float candidateBpm_ = 0.0f;
  float cycleThresholdG_ = 0.0045f;
  uint8_t consistentCycleCount_ = 0;
  float bpm_ = 0.0f;
};
