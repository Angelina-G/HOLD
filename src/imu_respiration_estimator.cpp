#include "imu_respiration_estimator.h"

#include <math.h>

namespace {
constexpr uint32_t kWarmupMs = 3000;
constexpr uint32_t kAxisRelearnMs = 12000;
constexpr uint32_t kMinHalfBreathMs = 560;
constexpr uint32_t kMinBreathIntervalMs = 1300;
constexpr uint32_t kMaxBreathIntervalMs = 10000;
constexpr uint32_t kStaleMs = 15000;
constexpr float kBaselineAlpha = 0.003f;
constexpr float kSmoothAlpha = 0.18f;
constexpr float kDetectionAlpha = 0.12f;
constexpr float kMinExtremumDeltaG = 0.0015f;
constexpr float kMinCycleAmplitudeG = 0.0025f;
constexpr float kMaxCycleAmplitudeG = 0.0045f;
constexpr float kMotionGateGyroDps = 35.0f;
constexpr float kMotionGateDynamicAccelG = 0.08f;
}

float ImuRespirationEstimator::norm(float x, float y, float z) {
  return sqrtf(x * x + y * y + z * z);
}

void ImuRespirationEstimator::reset(uint32_t nowMs) {
  initialized_ = false;
  axisLocked_ = false;
  detectorPrimed_ = false;
  motionGated_ = false;
  hasPeak_ = false;
  hasTrough_ = false;
  axisIndex_ = 2;
  startedAtMs_ = nowMs;
  axisLockedAtMs_ = 0;
  latestSampleAtMs_ = 0;
  lastPeakAtMs_ = 0;
  lastTroughAtMs_ = 0;
  lastAcceptedAtMs_ = 0;
  candidateUpdatedAtMs_ = 0;
  lastMotionAtMs_ = 0;
  for (uint8_t index = 0; index < 3; ++index) {
    baselineG_[index] = 0.0f;
    filteredG_[index] = 0.0f;
    warmupMinG_[index] = 0.0f;
    warmupMaxG_[index] = 0.0f;
  }
  detectionFilteredG_ = 0.0f;
  previousDetectionFilteredG_ = 0.0f;
  previousSlope_ = 0.0f;
  lastPeakValueG_ = 0.0f;
  lastTroughValueG_ = 0.0f;
  candidateBpm_ = 0.0f;
  cycleThresholdG_ = kMaxCycleAmplitudeG;
  consistentCycleCount_ = 0;
  bpm_ = 0.0f;
}

void ImuRespirationEstimator::addSample(const Sample& sample) {
  const float accel[3] = {sample.accelXg, sample.accelYg, sample.accelZg};
  latestSampleAtMs_ = sample.capturedAtMs;
  if (!initialized_) {
    initialized_ = true;
    startedAtMs_ = sample.capturedAtMs;
    const float ax = fabsf(accel[0]);
    const float ay = fabsf(accel[1]);
    const float az = fabsf(accel[2]);
    axisIndex_ = ax >= ay && ax >= az ? 0 : (ay >= ax && ay >= az ? 1 : 2);
    for (uint8_t index = 0; index < 3; ++index) {
      baselineG_[index] = accel[index];
      warmupMinG_[index] = 0.0f;
      warmupMaxG_[index] = 0.0f;
    }
    return;
  }

  motionGated_ = norm(sample.gyroXdps, sample.gyroYdps, sample.gyroZdps) > kMotionGateGyroDps ||
      fabsf(norm(sample.accelXg, sample.accelYg, sample.accelZg) - 1.0f) > kMotionGateDynamicAccelG;

  for (uint8_t index = 0; index < 3; ++index) {
    baselineG_[index] += (accel[index] - baselineG_[index]) * kBaselineAlpha;
    const float detrendedG = accel[index] - baselineG_[index];
    filteredG_[index] += (detrendedG - filteredG_[index]) * kSmoothAlpha;
    if (!axisLocked_) {
      if (filteredG_[index] < warmupMinG_[index]) warmupMinG_[index] = filteredG_[index];
      if (filteredG_[index] > warmupMaxG_[index]) warmupMaxG_[index] = filteredG_[index];
    }
  }

  if (!axisLocked_) {
    if (sample.capturedAtMs - startedAtMs_ < kWarmupMs) return;
    float largestRangeG = -1.0f;
    for (uint8_t index = 0; index < 3; ++index) {
      const float rangeG = warmupMaxG_[index] - warmupMinG_[index];
      if (rangeG > largestRangeG) {
        largestRangeG = rangeG;
        axisIndex_ = index;
      }
    }
    cycleThresholdG_ = fmaxf(
        kMinCycleAmplitudeG,
        fminf(kMaxCycleAmplitudeG, largestRangeG * 0.18f));
    axisLocked_ = true;
    axisLockedAtMs_ = sample.capturedAtMs;
    detectionFilteredG_ = filteredG_[axisIndex_];
    previousDetectionFilteredG_ = detectionFilteredG_;
    previousSlope_ = 0.0f;
    return;
  }

  if (candidateUpdatedAtMs_ == 0 && sample.capturedAtMs - axisLockedAtMs_ > kAxisRelearnMs) {
    axisLocked_ = false;
    detectorPrimed_ = false;
    hasPeak_ = false;
    hasTrough_ = false;
    startedAtMs_ = sample.capturedAtMs;
    for (uint8_t index = 0; index < 3; ++index) {
      warmupMinG_[index] = filteredG_[index];
      warmupMaxG_[index] = filteredG_[index];
    }
    return;
  }

  detectionFilteredG_ += (filteredG_[axisIndex_] - detectionFilteredG_) * kDetectionAlpha;
  if (candidateUpdatedAtMs_ != 0 && sample.capturedAtMs - candidateUpdatedAtMs_ > kStaleMs) {
    candidateUpdatedAtMs_ = 0;
    lastAcceptedAtMs_ = 0;
    candidateBpm_ = 0.0f;
    consistentCycleCount_ = 0;
    bpm_ = 0.0f;
  }
  const float slope = detectionFilteredG_ - previousDetectionFilteredG_;
  const float extremumDeltaG = fmaxf(kMinExtremumDeltaG, cycleThresholdG_ * 0.60f);

  if (motionGated_) {
    hasPeak_ = false;
    hasTrough_ = false;
    detectorPrimed_ = false;
    lastMotionAtMs_ = sample.capturedAtMs;
    lastAcceptedAtMs_ = 0;
    candidateUpdatedAtMs_ = 0;
    candidateBpm_ = 0.0f;
    consistentCycleCount_ = 0;
    bpm_ = 0.0f;
  } else if (lastMotionAtMs_ != 0 && sample.capturedAtMs - lastMotionAtMs_ < kWarmupMs) {
    detectorPrimed_ = false;
  } else if (!detectorPrimed_) {
    detectorPrimed_ = true;
  } else if (previousSlope_ > 0.0f && slope <= 0.0f) {
    if ((!hasTrough_ && previousDetectionFilteredG_ >= extremumDeltaG) ||
        (hasTrough_ && previousDetectionFilteredG_ - lastTroughValueG_ >= extremumDeltaG)) {
      acceptPeak(sample.capturedAtMs, previousDetectionFilteredG_);
    }
  } else if (previousSlope_ < 0.0f && slope >= 0.0f) {
    if ((!hasPeak_ && -previousDetectionFilteredG_ >= extremumDeltaG) ||
        (hasPeak_ && lastPeakValueG_ - previousDetectionFilteredG_ >= extremumDeltaG)) {
      acceptTrough(sample.capturedAtMs, previousDetectionFilteredG_);
    }
  }

  previousDetectionFilteredG_ = detectionFilteredG_;
  previousSlope_ = slope;
}

void ImuRespirationEstimator::acceptPeak(uint32_t atMs, float valueG) {
  if (hasPeak_ && (!hasTrough_ || lastPeakAtMs_ > lastTroughAtMs_)) {
    if (valueG > lastPeakValueG_) lastPeakValueG_ = valueG;
    return;
  }
  if (hasTrough_ && atMs - lastTroughAtMs_ < kMinHalfBreathMs) return;
  lastPeakAtMs_ = atMs;
  lastPeakValueG_ = valueG;
  hasPeak_ = true;
}

void ImuRespirationEstimator::acceptTrough(uint32_t atMs, float valueG) {
  if (hasTrough_ && (!hasPeak_ || lastTroughAtMs_ > lastPeakAtMs_)) {
    if (valueG < lastTroughValueG_) lastTroughValueG_ = valueG;
    return;
  }
  if (!hasPeak_) {
    lastTroughAtMs_ = atMs;
    lastTroughValueG_ = valueG;
    hasTrough_ = true;
    return;
  }
  if (atMs - lastPeakAtMs_ < kMinHalfBreathMs) return;

  const uint32_t previousTroughAtMs = lastTroughAtMs_;
  const float previousTroughValueG = lastTroughValueG_;
  lastTroughAtMs_ = atMs;
  lastTroughValueG_ = valueG;
  hasTrough_ = true;
  if (previousTroughAtMs == 0 || previousTroughAtMs >= atMs) return;

  const uint32_t intervalMs = atMs - previousTroughAtMs;
  const float amplitudeG = lastPeakValueG_ - previousTroughValueG;
  if (intervalMs < kMinBreathIntervalMs || intervalMs > kMaxBreathIntervalMs ||
      amplitudeG < cycleThresholdG_) return;

  const float instantBpm = 60000.0f / static_cast<float>(intervalMs);
  candidateUpdatedAtMs_ = atMs;
  const float toleranceBpm = fmaxf(3.0f, candidateBpm_ * 0.25f);
  if (candidateBpm_ <= 0.0f || fabsf(instantBpm - candidateBpm_) > toleranceBpm) {
    candidateBpm_ = instantBpm;
    consistentCycleCount_ = 1;
    return;
  }

  candidateBpm_ = candidateBpm_ * 0.70f + instantBpm * 0.30f;
  if (consistentCycleCount_ < 255) ++consistentCycleCount_;
  if (consistentCycleCount_ >= 2) {
    bpm_ = bpm_ <= 0.0f ? candidateBpm_ : bpm_ * 0.70f + candidateBpm_ * 0.30f;
    lastAcceptedAtMs_ = atMs;
  }
}

float ImuRespirationEstimator::bpm() const {
  if (lastAcceptedAtMs_ == 0 || latestSampleAtMs_ - lastAcceptedAtMs_ > kStaleMs) return 0.0f;
  return bpm_;
}

float ImuRespirationEstimator::signalG() const {
  return filteredG_[axisIndex_];
}

float ImuRespirationEstimator::candidateBpm() const {
  return candidateBpm_;
}

float ImuRespirationEstimator::cycleThresholdG() const {
  return cycleThresholdG_;
}

uint8_t ImuRespirationEstimator::consistentCycleCount() const {
  return consistentCycleCount_;
}

const char* ImuRespirationEstimator::status() const {
  if (!initialized_ || !axisLocked_) return "warmup";
  if (motionGated_ || (lastMotionAtMs_ != 0 && latestSampleAtMs_ - lastMotionAtMs_ < kWarmupMs)) return "motion";
  if (bpm() > 0.0f) return "valid";
  return consistentCycleCount_ > 0 ? "confirm" : "cycle";
}

bool ImuRespirationEstimator::motionGated() const {
  return motionGated_;
}

char ImuRespirationEstimator::axis() const {
  return axisIndex_ == 0 ? 'x' : (axisIndex_ == 1 ? 'y' : 'z');
}
