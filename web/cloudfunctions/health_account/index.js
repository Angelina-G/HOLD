const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const USER_COLLECTION = 'hold_users';

const collectionReady = {};

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
    return avatarUrl;
  }
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

async function handleLogin(openid, event) {
  const existing = await runWithCollection(USER_COLLECTION, (collection) => collection
    .where({ _openid: openid })
    .limit(1)
    .get());

  const now = Date.now();
  const doc = existing.data && existing.data[0] ? existing.data[0] : null;

  if (!doc) {
    const data = {
      nickname: (event.profile && event.profile.nickname) || '微信用户',
      avatarUrl: (event.profile && event.profile.avatarUrl) || '',
      createdAt: db.serverDate(),
      created_at_ms: now,
      lastLoginAt: db.serverDate(),
      last_login_at_ms: now,
      loginCount: 1
    };
    const added = await runWithCollection(USER_COLLECTION, (collection) => collection.add({ data }));
    return {
      code: 200,
      isNewUser: true,
      user: buildUserView(Object.assign({ _id: added._id }, data), openid)
    };
  }

  await runWithCollection(USER_COLLECTION, (collection) => collection.doc(doc._id).update({
    data: {
      lastLoginAt: db.serverDate(),
      last_login_at_ms: now,
      loginCount: _.inc(1)
    }
  }));

  const merged = Object.assign({}, doc, {
    last_login_at_ms: now,
    loginCount: Number(doc.loginCount || 0) + 1
  });
  return { code: 200, isNewUser: false, user: buildUserView(merged, openid) };
}

async function handleUpdateProfile(openid, event) {
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

  await runWithCollection(USER_COLLECTION, (collection) => collection
    .where({ _openid: openid })
    .update({ data }));

  const refreshed = await runWithCollection(USER_COLLECTION, (collection) => collection
    .where({ _openid: openid })
    .limit(1)
    .get());

  const doc = refreshed.data && refreshed.data[0] ? refreshed.data[0] : {};
  return { code: 200, user: buildUserView(doc, openid) };
}

async function handleGetProfile(openid) {
  const result = await runWithCollection(USER_COLLECTION, (collection) => collection
    .where({ _openid: openid })
    .limit(1)
    .get());

  const doc = result.data && result.data[0] ? result.data[0] : null;
  if (!doc) {
    return { code: 200, registered: false, user: null };
  }

  return { code: 200, registered: true, user: buildUserView(doc, openid) };
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || wxContext.FROM_OPENID || '';
  const action = (event && event.action) || 'login';

  if (!openid) {
    return { code: 401, error_message: 'missing openid' };
  }

  try {
    switch (action) {
      case 'login':
        return await handleLogin(openid, event);
      case 'update_profile':
        return await handleUpdateProfile(openid, event);
      case 'get_profile':
        return await handleGetProfile(openid);
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
