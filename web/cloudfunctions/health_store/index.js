const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = {
  state: 'hold_user_state',
  measurement: 'hold_active_measurements',
  daily: 'hold_daily_analyses',
  user: 'hold_users'
};

const MAX_MEASUREMENTS = 30;
const MAX_DAILY_ANALYSES = 21;
const QUERY_LIMIT = 60;

const collectionReady = {};

/**
 * 云开发数据库要求集合先存在。首次写入时若集合缺失，这里兜底创建一次。
 */
async function ensureCollection(name) {
  if (collectionReady[name]) {
    return;
  }

  try {
    if (typeof db.createCollection === 'function') {
      await db.createCollection(name);
    }
  } catch (error) {
    // 集合已存在时创建会报错，忽略即可
  }

  collectionReady[name] = true;
}

function isMissingCollectionError(error) {
  const message = `${(error && error.message) || ''} ${(error && error.errMsg) || ''}`.toLowerCase();
  return message.indexOf('collection not exists') >= 0
    || message.indexOf('collection_not_exist') >= 0
    || message.indexOf('-502003') >= 0
    || message.indexOf('not exist') >= 0;
}

async function runWithCollection(name, task) {
  try {
    return await task(db.collection(name));
  } catch (error) {
    if (!isMissingCollectionError(error)) {
      throw error;
    }

    await ensureCollection(name);
    return task(db.collection(name));
  }
}

async function removeCollectionDocs(name, where) {
  try {
    return await db.collection(name).where(where).remove();
  } catch (error) {
    if (!isMissingCollectionError(error)) {
      throw error;
    }

    await ensureCollection(name);
    return { stats: { removed: 0 } };
  }
}

/* ------------------------------------------------------------------ */
/* 账号                                                                */
/* ------------------------------------------------------------------ */

function downloadToBuffer(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 400) {
        reject(new Error(`avatar http ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function buildUserView(doc, openid) {
  return {
    userId: doc._id,
    nickname: doc.nickname || '微信用户',
    avatarUrl: doc.avatarUrl || '',
    createdAtMs: Number(doc.created_at_ms || 0),
    lastLoginAtMs: Number(doc.last_login_at_ms || 0),
    loginCount: Number(doc.loginCount || 1),
    openidTail: `${openid || ''}`.slice(-6)
  };
}

/**
 * 读取账号档案，不存在就按微信身份建一个（用户打开小程序即自动注册）。
 */
async function ensureUser(openid, profile) {
  const existing = await runWithCollection(COLLECTIONS.user, (collection) => collection
    .where({ _openid: openid })
    .limit(1)
    .get());

  const now = Date.now();
  const doc = existing.data && existing.data[0] ? existing.data[0] : null;

  if (!doc) {
    const data = {
      nickname: (profile && profile.nickname) || '微信用户',
      avatarUrl: (profile && profile.avatarUrl) || '',
      createdAt: db.serverDate(),
      created_at_ms: now,
      lastLoginAt: db.serverDate(),
      last_login_at_ms: now,
      loginCount: 1
    };
    const added = await runWithCollection(COLLECTIONS.user, (collection) => collection.add({ data }));
    return Object.assign({ _id: added._id }, data);
  }

  await runWithCollection(COLLECTIONS.user, (collection) => collection.doc(doc._id).update({
    data: {
      lastLoginAt: db.serverDate(),
      last_login_at_ms: now,
      loginCount: _.inc(1)
    }
  }));

  return Object.assign({}, doc, {
    last_login_at_ms: now,
    loginCount: Number(doc.loginCount || 0) + 1
  });
}

/**
 * 小程序端 open-data 已经拿不到昵称头像，用户可手动设置；
 * 也允许把「获取头像昵称」按钮产生的临时链接传上来，由云函数转存到云存储。
 */
async function resolveAvatar(openid, avatarUrl) {
  if (!avatarUrl || typeof avatarUrl !== 'string') {
    return '';
  }

  if (avatarUrl.indexOf('cloud://') === 0) {
    return avatarUrl;
  }

  if (avatarUrl.indexOf('http') !== 0) {
    return avatarUrl;
  }

  try {
    const uploaded = await cloud.uploadFile({
      cloudPath: `avatars/${openid}/${Date.now()}.png`,
      fileContent: await downloadToBuffer(avatarUrl)
    });
    return uploaded.fileID;
  } catch (error) {
    // 转存失败不阻断流程，先存临时链接
    return avatarUrl;
  }
}

async function handleUserSync(openid, event) {
  const doc = await ensureUser(openid, event.profile);
  return { code: 200, user: buildUserView(doc, openid) };
}

async function handleUserProfile(openid, event) {
  const patch = event.profile || {};
  const data = {};

  if (typeof patch.nickname === 'string') {
    const nickname = patch.nickname.trim().slice(0, 20);
    if (nickname) {
      data.nickname = nickname;
    }
  }

  if (typeof patch.avatarUrl === 'string' && patch.avatarUrl) {
    data.avatarUrl = await resolveAvatar(openid, patch.avatarUrl);
  }

  if (!Object.keys(data).length) {
    return { code: 400, error_message: 'profile empty' };
  }

  await runWithCollection(COLLECTIONS.user, (collection) => collection
    .where({ _openid: openid })
    .update({ data }));

  const refreshed = await runWithCollection(COLLECTIONS.user, (collection) => collection
    .where({ _openid: openid })
    .limit(1)
    .get());

  const doc = refreshed.data && refreshed.data[0] ? refreshed.data[0] : {};
  return { code: 200, user: buildUserView(doc, openid) };
}

async function handleUserStats(openid) {
  const [measurementCount, dailyCount] = await Promise.all([
    runWithCollection(COLLECTIONS.measurement, (collection) => collection.where({ openid }).count()),
    runWithCollection(COLLECTIONS.daily, (collection) => collection.where({ openid }).count())
  ]);

  return {
    code: 200,
    counts: {
      measurements: Number((measurementCount && measurementCount.total) || 0),
      dailyAnalyses: Number((dailyCount && dailyCount.total) || 0)
    }
  };
}

/* ------------------------------------------------------------------ */
/* 健康数据                                                            */
/* ------------------------------------------------------------------ */

function sortByUpdatedAtDesc(list) {
  return list.slice().sort((left, right) =>
    Number(right.updated_at_ms || 0) - Number(left.updated_at_ms || 0));
}

/**
 * 只投影轻量字段，wave（大段波形数组）不在此列，由 load_detail 按需拉取。
 * 注意：数据库投影不能 true/false 混用，这里保持纯包含模式。
 */
async function fetchUserDocs(name, openid) {
  const result = await runWithCollection(name, (collection) => collection
    .where({ openid })
    .field({ recordId: true, dayKey: true, record: true, updated_at_ms: true })
    .limit(QUERY_LIMIT)
    .get());

  return sortByUpdatedAtDesc(result.data || []);
}

/**
 * 未登录时按设备共享读取。
 * 数据库里 `_openid` 是系统自动写入的（不可伪造），`openid` 是我们自己写的字段：
 * 已登录时为用户账号身份，未登录时回落为该设备成员的真实 openid。
 */
async function fetchSharedDocs(name, openids) {
  const result = await runWithCollection(name, (collection) => collection
    .where({ _openid: _.in(openids) })
    .field({ recordId: true, dayKey: true, record: true, updated_at_ms: true })
    .limit(QUERY_LIMIT)
    .get());

  return sortByUpdatedAtDesc(result.data || []);
}

/**
 * 确定本次读取的数据范围：
 * - mine：读当前微信身份的记录（登录后即账号数据）
 * - shared：本机（同一个小程序 appid 身份空间）全部成员记录，用于未登录时也能看到设备历史
 */
async function resolveScope(openid, event) {
  const scope = event.scope || 'mine';
  if (scope !== 'shared') {
    return { openids: [openid], primary: openid, shared: false };
  }

  const userDoc = await runWithCollection(COLLECTIONS.user, (collection) => collection
    .where({ _openid: openid })
    .limit(1)
    .get());

  const doc = userDoc.data && userDoc.data[0] ? userDoc.data[0] : null;
  const openids = doc && doc.openid ? [doc.openid] : [];
  if (openids.indexOf(openid) < 0) {
    openids.push(openid);
  }

  return { openids, primary: openids[0], shared: openids.length > 1 };
}

async function upsertDoc(name, match, data) {
  return runWithCollection(name, async (collection) => {
    const existing = await collection.where(match).limit(1).get();
    if (existing.data && existing.data.length) {
      await collection.doc(existing.data[0]._id).update({ data });
      return existing.data[0]._id;
    }

    const added = await collection.add({ data });
    return added._id;
  });
}

async function pruneCollection(name, where, limit) {
  const result = await runWithCollection(name, (collection) => collection
    .where(where)
    .field({ _id: true, updated_at_ms: true })
    .limit(200)
    .get());

  const docs = sortByUpdatedAtDesc(result.data || []);
  if (docs.length <= limit) {
    return 0;
  }

  const expiredIds = docs.slice(limit).map((item) => item._id);
  if (!expiredIds.length) {
    return 0;
  }

  await runWithCollection(name, (collection) => collection
    .where({ _id: _.in(expiredIds) })
    .remove());

  return expiredIds.length;
}

function buildItem(doc, keyName) {
  return {
    key: doc[keyName] || '',
    record: doc.record || {},
    updatedAtMs: Number(doc.updated_at_ms || 0)
  };
}

async function handlePull(openid, event) {
  const scopeInfo = await resolveScope(openid, event);

  const [stateResult, measurementDocs, dailyDocs] = await Promise.all([
    runWithCollection(COLLECTIONS.state, (collection) => collection
      .where({ openid: scopeInfo.primary })
      .limit(1)
      .get()),
    scopeInfo.shared
      ? fetchSharedDocs(COLLECTIONS.measurement, scopeInfo.openids)
      : fetchUserDocs(COLLECTIONS.measurement, openid),
    scopeInfo.shared
      ? fetchSharedDocs(COLLECTIONS.daily, scopeInfo.openids)
      : fetchUserDocs(COLLECTIONS.daily, openid)
  ]);

  return {
    code: 200,
    scope: scopeInfo.shared ? 'shared' : 'mine',
    shared: scopeInfo.shared,
    state: stateResult.data && stateResult.data[0] ? stateResult.data[0] : null,
    measurements: measurementDocs.slice(0, MAX_MEASUREMENTS).map((doc) => buildItem(doc, 'recordId')),
    dailyAnalyses: dailyDocs.slice(0, MAX_DAILY_ANALYSES).map((doc) => buildItem(doc, 'dayKey'))
  };
}

async function handleLoadDetail(openid, event) {
  const kind = event.kind === 'daily' ? 'daily' : 'measurement';
  const name = kind === 'daily' ? COLLECTIONS.daily : COLLECTIONS.measurement;
  const keyName = kind === 'daily' ? 'dayKey' : 'recordId';
  if (!event.key) {
    return { code: 400, error_message: 'missing key' };
  }

  const scopeInfo = await resolveScope(openid, event);
  const where = { [keyName]: event.key };
  where[scopeInfo.shared ? '_openid' : 'openid'] = scopeInfo.shared ? _.in(scopeInfo.openids) : openid;

  const result = await runWithCollection(name, (collection) => collection
    .where(where)
    .limit(1)
    .get());

  const doc = result.data && result.data[0] ? result.data[0] : null;
  if (!doc) {
    return { code: 404, error_message: 'record not found' };
  }

  return {
    code: 200,
    key: event.key,
    record: doc.record || {},
    wave: doc.wave || {}
  };
}

async function handleSaveState(openid, event, now) {
  const payload = event.payload || {};
  await upsertDoc(COLLECTIONS.state, { openid }, {
    openid,
    latestPassiveWindow: payload.latestPassiveWindow || null,
    latestActiveWindow: payload.latestActiveWindow || null,
    overallSummary: payload.overallSummary || null,
    respWavePoints: payload.respWavePoints || [],
    respBeatMarkerPoints: payload.respBeatMarkerPoints || [],
    chestPpgWavePoints: payload.chestPpgWavePoints || [],
    chestPpgBeatMarkerPoints: payload.chestPpgBeatMarkerPoints || [],
    updated_at_ms: now,
    updated_at: db.serverDate()
  });

  return { code: 200 };
}

async function handleSaveMeasurement(openid, event, now) {
  const recordId = event.recordId || '';
  if (!recordId) {
    return { code: 400, error_message: 'missing recordId' };
  }

  const data = {
    openid,
    recordId,
    record: event.record || {},
    updated_at_ms: now,
    updated_at: db.serverDate()
  };
  if (!event.keepWave) {
    data.wave = event.wave || {};
  }

  await upsertDoc(COLLECTIONS.measurement, { openid, recordId }, data);
  const removed = await pruneCollection(COLLECTIONS.measurement, { openid }, MAX_MEASUREMENTS);

  return { code: 200, removed };
}

async function handleSaveDaily(openid, event, now) {
  const dayKey = event.dayKey || '';
  if (!dayKey) {
    return { code: 400, error_message: 'missing dayKey' };
  }

  const data = {
    openid,
    dayKey,
    record: event.record || {},
    updated_at_ms: now,
    updated_at: db.serverDate()
  };
  if (!event.keepWave) {
    data.wave = event.wave || {};
  }

  await upsertDoc(COLLECTIONS.daily, { openid, dayKey }, data);
  const removed = await pruneCollection(COLLECTIONS.daily, { openid }, MAX_DAILY_ANALYSES);

  return { code: 200, removed };
}

async function handleDelete(openid, kind, key) {
  const name = kind === 'daily' ? COLLECTIONS.daily : COLLECTIONS.measurement;
  const keyName = kind === 'daily' ? 'dayKey' : 'recordId';
  if (!key) {
    return { code: 400, error_message: 'missing key' };
  }

  await removeCollectionDocs(name, { openid, [keyName]: key });
  return { code: 200 };
}

async function handleClearAll(openid) {
  const names = [COLLECTIONS.state, COLLECTIONS.measurement, COLLECTIONS.daily];
  for (let index = 0; index < names.length; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await removeCollectionDocs(names[index], { openid });
  }

  return { code: 200 };
}

async function handleBootstrap() {
  const names = [COLLECTIONS.state, COLLECTIONS.measurement, COLLECTIONS.daily, COLLECTIONS.user];
  for (let index = 0; index < names.length; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await ensureCollection(names[index]);
  }

  return { code: 200, collections: names };
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || wxContext.FROM_OPENID || '';
  const action = (event && event.action) || 'pull';
  const now = Date.now();

  if (!openid) {
    return { code: 401, error_message: 'missing openid' };
  }

  try {
    switch (action) {
      case 'user_sync':
        return await handleUserSync(openid, event);
      case 'user_profile':
        return await handleUserProfile(openid, event);
      case 'user_stats':
        return await handleUserStats(openid);
      case 'pull':
        return await handlePull(openid, event);
      case 'load_detail':
        return await handleLoadDetail(openid, event);
      case 'save_state':
        return await handleSaveState(openid, event, now);
      case 'save_measurement':
        return await handleSaveMeasurement(openid, event, now);
      case 'save_daily':
        return await handleSaveDaily(openid, event, now);
      case 'delete_measurement':
        return await handleDelete(openid, 'measurement', event.recordId);
      case 'delete_daily':
        return await handleDelete(openid, 'daily', event.dayKey);
      case 'clear_all':
        return await handleClearAll(openid);
      case 'bootstrap':
        return await handleBootstrap();
      default:
        return { code: 400, error_message: `unknown action: ${action}` };
    }
  } catch (error) {
    return {
      code: 500,
      error_message: (error && error.message) || 'unknown cloud error'
    };
  }
};
