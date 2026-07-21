const assert = require('assert');

const storage = {};
const commands = [];
let definition = null;

global.wx = {
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => { storage[key] = value; },
  removeStorageSync: (key) => { delete storage[key]; },
  navigateTo: () => {}
};
global.getApp = () => ({
  globalData: {
    bleSession: { canSendCommand: true },
    blePage: {
      sendCommand(command, callbacks) {
        commands.push(command);
        callbacks.success();
      }
    }
  }
});
global.Page = (value) => { definition = value; };

require('../pages/user-test/index');
const page = Object.assign({}, definition, {
  data: JSON.parse(JSON.stringify(definition.data)),
  setData(next) { Object.assign(this.data, next); }
});
page.onLoad();
storage.hold_latest_telemetry = {
  receivedAt: Date.now(),
  payload: { pp: 1, ct: 0, ir: 210000, red: 170000, hr: 0, br: 16, mr: 1, mo: 'still' }
};
page.refresh();
assert.equal(page.data.signalGood, true);
assert.equal(page.data.heartRate, '--');
page.startBaseline();
assert.equal(page.data.stage, 'baseline');
page.updateStage('guideReady', '基线完成', '准备引导', '');
page.startGuide();
assert.equal(commands[0], 'breath_start');
assert.equal(page.data.stage, 'guide');
page.syncGuidePhase('i');
assert.equal(page.data.guidePhase, '吸气');
page.syncGuidePhase('e');
assert.equal(page.data.guidePhase, '呼气');
page.stopGuide();
assert.equal(commands[1], 'breath_stop');
assert.equal(page.data.stage, 'recovery');

delete global.Page;
delete global.getApp;
delete global.wx;
console.log('user test flow smoke: ok');
