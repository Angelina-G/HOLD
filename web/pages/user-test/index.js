const { archiveLatestMeasurement } = require('../../utils/mock-health-data');

const FLOW_KEY = 'hold_user_test_flow';
const BASELINE_SECONDS = 30;
const GUIDE_SECONDS = 60;
const RECOVERY_SECONDS = 30;

function latestSignal() {
  const cached = wx.getStorageSync('hold_latest_telemetry') || {};
  const payload = cached.payload || {};
  const fresh = Boolean(cached.receivedAt && Date.now() - cached.receivedAt < 5000);
  const heartRate = Number(payload.hr || 0);
  const heartReady = heartRate >= 35 && heartRate <= 220;
  const rawPpg = Number(payload.ir || 0) > 0 || Number(payload.red || 0) > 0;
  const contactReady = Number(payload.ct || 0) === 1 || rawPpg;
  const ppgGood = fresh && Number(payload.pp || 0) === 1 && contactReady;
  const fingerPressed = Number(payload.fp || 0) === 1;
  const still = Number(payload.mr || 0) === 1 && String(payload.mo || '').toLowerCase() === 'still';
  const breathRate = Number(payload.br || 0);
  return { cached, payload, fresh, heartRate, breathRate, ppgGood, fingerPressed, heartReady, still };
}

Page({
  data: {
    ppgMode: 'chest',
    ppgModeLabel: '胸口 PPG 连续模式',
    stage: 'ready',
    stepLabel: '准备',
    title: '先确认佩戴与连接',
    instruction: '传感器贴紧皮肤，保持坐姿稳定。',
    secondsLeft: 0,
    progress: 0,
    connected: false,
    signalGood: false,
    signalLabel: '等待设备连接',
    signalDetail: '连接后会自动检查 PPG 贴合与静止状态。',
    heartRate: '--',
    breathRate: '--',
    guidePhase: '准备',
    guidePhaseClass: 'neutral',
    subjectiveBefore: 5,
    subjectiveAfter: 5,
    comparison: null,
    resultMeasurementId: '',
    subjectiveDelta: 0,
    subjectiveResult: '',
    resultTone: 'neutral',
    busy: false,
    errorText: ''
  },

  onLoad(options) {
    this.app = typeof getApp === 'function' ? getApp() : null;
    const ppgMode = options && options.mode === 'finger' ? 'finger' : (wx.getStorageSync('hold_ppg_mode') || 'chest');
    this.setData({
      ppgMode,
      ppgModeLabel: ppgMode === 'finger' ? '指部 PPG 主动检测' : '胸口 PPG 连续模式',
      instruction: ppgMode === 'finger'
        ? '手指压住硬件压敏 3 秒，设备确认后再保持静止采集。'
        : '胸口传感器贴紧皮肤，保持坐姿稳定。'
    });
    const saved = wx.getStorageSync(FLOW_KEY);
    if (saved && saved.stage && saved.stage !== 'result') {
      this.setData(saved);
    }
  },

  onShow() {
    clearInterval(this.timer);
    this.refresh();
    this.timer = setInterval(this.refresh.bind(this), 500);
  },

  onHide() {
    clearInterval(this.timer);
  },

  onUnload() {
    clearInterval(this.timer);
    if (this.data.stage === 'guide') this.sendCommand('breath_stop');
  },

  refresh() {
    const signal = latestSignal();
    const session = this.app && this.app.globalData ? this.app.globalData.bleSession : null;
    const connected = Boolean(session && session.canSendCommand);
    const fingerModeWaiting = this.data.ppgMode === 'finger' && !signal.fingerPressed;
    const signalGood = connected && signal.ppgGood && signal.still && !fingerModeWaiting;
    let signalLabel = connected ? '正在确认佩戴' : '等待设备连接';
    let signalDetail = connected ? '请贴紧 PPG 并保持身体静止。' : '先进入调试页完成一次扫描连接。';
    if (connected && !signal.fresh) {
      signalLabel = '等待实时数据';
      signalDetail = '连接已建立，正在等待硬件遥测。';
    } else if (connected && signal.fresh && fingerModeWaiting) {
      signalLabel = '压住压敏 3 秒';
      signalDetail = '不用长按屏幕；用手指压住硬件压敏，等设备确认后开始。';
    } else if (connected && signal.fresh && !signal.ppgGood) {
      signalLabel = '请调整 PPG 贴合';
      signalDetail = '轻压传感器，直到心率信号稳定出现。';
    } else if (connected && signal.ppgGood && !signal.still) {
      signalLabel = '请保持静止';
      signalDetail = '动作会影响前后对比，请坐稳后继续。';
    } else if (connected && signal.ppgGood && !signal.heartReady) {
      signalLabel = 'PPG 已贴合，心率学习中';
      signalDetail = '可以开始记录，系统会在基线阶段继续等待稳定 bpm。';
    } else if (signalGood) {
      signalLabel = '信号已就绪';
      signalDetail = signal.breathRate > 0 ? '心率和呼吸均已读取。' : '心率已读取，呼吸仍在学习中。';
    }

    this.setData({
      connected,
      signalGood,
      signalLabel,
      signalDetail,
      heartRate: signal.heartRate > 0 ? signal.heartRate.toFixed(0) : '--',
      breathRate: signal.breathRate > 0 ? signal.breathRate.toFixed(0) : '--'
    });

    if (this.data.stage === 'guide') this.syncGuidePhase(signal.payload.ph);
    if (this.data.stageStartedAt) this.tickStage();
  },

  tickStage() {
    const durations = { baseline: BASELINE_SECONDS, guide: GUIDE_SECONDS, recovery: RECOVERY_SECONDS };
    const duration = durations[this.data.stage];
    if (!duration) return;
    const elapsed = Math.floor((Date.now() - this.data.stageStartedAt) / 1000);
    const secondsLeft = Math.max(0, duration - elapsed);
    this.setData({ secondsLeft, progress: Math.min(100, Math.round(elapsed * 100 / duration)) });
    if (secondsLeft > 0 || this.transitioning) return;
    this.transitioning = true;
    if (this.data.stage === 'baseline') {
      this.updateStage('guideReady', '基线完成', '准备开始 1 分钟引导', '跟随屏幕文字和震动节奏呼吸。');
      this.transitioning = false;
    } else if (this.data.stage === 'guide') {
      this.stopGuide();
    } else if (this.data.stage === 'recovery') {
      this.updateStage('rateAfter', '完成测量', '记录现在的感受', '这一步由你判断，不由传感器替你回答。');
      this.transitioning = false;
    }
  },

  syncGuidePhase(phase) {
    const inhale = phase === 'i';
    const exhale = phase === 'e';
    this.setData({
      guidePhase: inhale ? '吸气' : exhale ? '呼气' : '保持自然呼吸',
      guidePhaseClass: inhale ? 'inhale' : exhale ? 'exhale' : 'neutral',
      instruction: inhale ? '震动逐渐增强，慢慢吸气。' : exhale ? '震动逐渐减弱，缓慢呼气。' : '正在同步硬件节奏。'
    });
  },

  updateStage(stage, stepLabel, title, instruction, extra) {
    const next = Object.assign({ stage, stepLabel, title, instruction, stageStartedAt: 0, secondsLeft: 0, progress: 0, errorText: '' }, extra || {});
    this.setData(next);
    wx.setStorageSync(FLOW_KEY, Object.assign({}, this.data, next));
  },

  openDebugPage() {
    wx.navigateTo({ url: '/pages/index/index' });
  },

  onBeforeChange(event) {
    this.setData({ subjectiveBefore: Number(event.detail.value) });
  },

  onAfterChange(event) {
    this.setData({ subjectiveAfter: Number(event.detail.value) });
  },

  startBaseline() {
    if (!this.data.signalGood) return;
    this.updateStage('baseline', '第 1 步 / 3', '记录引导前状态', '保持静止，自然呼吸，不需要盯着数字。', {
      stageStartedAt: Date.now(),
      secondsLeft: BASELINE_SECONDS
    });
  },

  startGuide() {
    this.setData({ busy: true, errorText: '' });
    this.sendCommand('breath_start', () => {
      this.setData({ busy: false });
      this.updateStage('guide', '第 2 步 / 3', '跟随节奏呼吸', '正在同步硬件节奏。', {
        stageStartedAt: Date.now(),
        secondsLeft: GUIDE_SECONDS,
        guidePhase: '准备',
        guidePhaseClass: 'neutral'
      });
    }, (error) => {
      this.setData({ busy: false, errorText: '引导启动失败，请返回连接页重试。' });
      console.error('[HOLD][USER_TEST][START_GUIDE]', error);
    });
  },

  stopGuide() {
    this.setData({ busy: true });
    this.sendCommand('breath_stop', () => {
      const stopAt = Date.now();
      this.setData({ busy: false });
      this.updateStage('recovery', '第 3 步 / 3', '记录引导后状态', '继续保持静止，自然呼吸 30 秒。', {
        stageStartedAt: stopAt,
        stopAt,
        secondsLeft: RECOVERY_SECONDS
      });
      this.transitioning = false;
    }, (error) => {
      this.setData({ busy: false, errorText: '停止命令发送失败，请确认设备仍然连接。' });
      this.transitioning = false;
      console.error('[HOLD][USER_TEST][STOP_GUIDE]', error);
    });
  },

  finishTest() {
    const archived = archiveLatestMeasurement(this.data.stopAt);
    const comparison = archived && archived.comparison ? archived.comparison : null;
    const subjectiveDelta = this.data.subjectiveAfter - this.data.subjectiveBefore;
    const subjectiveResult = subjectiveDelta <= -2
      ? '主观紧张感明显下降'
      : subjectiveDelta >= 2
        ? '主观紧张感有所上升'
        : '主观感受变化较小';
    const resultTone = subjectiveDelta <= -2 && comparison && comparison.tone === 'peace'
      ? 'peace'
      : subjectiveDelta >= 2 || (comparison && comparison.tone === 'anxious')
        ? 'anxious'
        : 'neutral';
    this.updateStage('result', '完成', '查看本次前后变化', '结果仅反映本次体验趋势，不用于医学诊断。', {
      comparison,
      resultMeasurementId: archived && archived.id ? archived.id : '',
      subjectiveDelta,
      subjectiveResult,
      resultTone
    });
  },

  restart() {
    wx.removeStorageSync(FLOW_KEY);
    this.setData({
      stage: 'ready', stepLabel: '准备', title: '先确认佩戴与连接',
      instruction: '传感器贴紧皮肤，保持坐姿稳定。', secondsLeft: 0,
      progress: 0, comparison: null, resultMeasurementId: '', subjectiveBefore: 5, subjectiveAfter: 5,
      subjectiveDelta: 0, subjectiveResult: '', resultTone: 'neutral', errorText: ''
    });
  },

  openReport() {
    if (this.data.resultMeasurementId) {
      wx.navigateTo({ url: `/pages/active-report/index?id=${this.data.resultMeasurementId}` });
    }
  },

  sendCommand(command, success, fail) {
    const blePage = this.app && this.app.globalData ? this.app.globalData.blePage : null;
    if (!blePage || !blePage.sendCommand) {
      if (fail) fail({ errMsg: 'BLE page unavailable' });
      return;
    }
    blePage.sendCommand(command, { success, fail });
  }
});
