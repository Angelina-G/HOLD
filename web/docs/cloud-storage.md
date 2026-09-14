# HOLD 小程序云端存储说明

小程序已不再把健康数据写进本地 `wx.setStorageSync`，全部改由**微信云开发**承载：
数据落在云开发数据库，读写统一走云函数 `health_store`，按 `openid` 做用户隔离。
换手机、清缓存、重装小程序后，只要用同一个微信账号登录，历史记录都可以恢复。

## 数据分布

| 集合 | 作用 | 关键字段 |
| --- | --- | --- |
| `hold_user_state` | 每个用户一行：最近实时波形缓存、最近被动/主动窗口、整体分析结论 | `openid`、`latestPassiveWindow`、`latestActiveWindow`、`overallSummary`、`respWavePoints`、`chestPpgWavePoints` |
| `hold_active_measurements` | 指部主动检测归档（默认保留 30 条） | `openid`、`recordId`、`record`、`wave` |
| `hold_daily_analyses` | 被动监测日级归档（默认保留 21 天） | `openid`、`dayKey`、`record`、`wave` |
| `hold_users` | 账号档案（详见 [用户系统](./user-system.md)） | `_openid`、`nickname`、`avatarUrl`、`last_login_at_ms` |

读取范围由账号状态决定：已登录读 `scope=mine`（仅本账号），
未登录回落 `scope=shared`（本机全部成员记录）。详见下方「数据范围」。

### record / wave 分离

大段波形数组（`wave`）与轻量记录（`record`）分开存：

- 测量记录：`fullPpgWavePoints`、`fullPpgBeatMarkerPoints`
- 日级记录：`respWavePoints`、`respBeatMarkerPoints`、`chestPpgWavePoints`、`chestPpgBeatMarkerPoints`

拉取列表时**不带波形**，只有打开具体报告/具体某一天时才调用 `load_detail` 补拉，
避免单次网络传输几十 KB～数 MB 的数组。

## 部署状态（已部署）

| 项 | 值 |
| --- | --- |
| 环境 ID | `hold-dev-env-d2gukfp01ac296189`（别名 `hold-dev-env`，ap-shanghai，体验版） |
| 云函数 | `health_store`、`health_account` 均已部署（Nodejs16.13，`index.main`） |
| 集合 | 四个集合均已创建（下表） |
| 索引 | `openid+recordId`、`openid+dayKey`、`updated_at_ms` 均已建立 |

已建索引：

| 集合 | 索引 |
| --- | --- |
| `hold_active_measurements` | `idx_openid_record`（openid + recordId）、`idx_updated`（updated_at_ms 倒序） |
| `hold_daily_analyses` | `idx_openid_day`（openid + dayKey）、`idx_updated`（updated_at_ms 倒序） |
| `hold_user_state` | `idx_openid`（openid） |
| `hold_users` | `_openid_1`（云开发自动创建） |

### 需要重新部署时

代码改动后重新部署（任选其一）：

1. 微信开发者工具：右键 `cloudfunctions/health_store` → **上传并部署：云端安装依赖**；
2. CloudBase CLI：`tcb fn deploy health_store --dir cloudfunctions/health_store`；
3. 让 AI 助手通过 CloudBase MCP 重新部署。

> 数据库权限保持默认的「仅创建者可读写」即可 —— 本项目所有数据访问都经过
> 云函数（云函数以管理端身份运行，不受集合权限规则限制），小程序端不直接读写数据库。
> 这样即使有人拿到小程序端代码也无法越权读取他人健康数据。

## 数据范围

| scope | 触发条件 | 读取范围 |
| --- | --- | --- |
| `mine` | 已登录 | 只读当前微信账号的记录 |
| `shared` | 未登录 | 读本机全部成员的记录 |

登录状态变化时，会先 flush 待写队列（避免写到新身份下），再按新 scope 重新拉取。

## 客户端改动一览

- `utils/hold-cloud-store.js`：云函数调用封装，内含防抖合并、失败重试一次、进入后台前 flush。
- `utils/hold-ble-runtime.js`：
  - 删除 `hold_ble_runtime_state_v2` 本地存储读写；
  - 启动时异步 `pull` 一次全量轻量数据，写操作改为增量 upsert；
  - 新增 `ensureMeasurementWaves` / `ensureDailyAnalysisWaves` 按需补波形；
  - 新增 `getCloudStatus` / `flushCloudWrites` / `waitForHydration`。
- `app.js`：`onHide` 时 flush 未完成写入。
- `pages/debug/index.js`：状态栏由「本地存储」改为「云端存储」，显示同步状态、数据范围与归档条数；
  「删除全部数据缓存」改为删除云端数据。
- `utils/hold-account.js`：微信登录与账号档案，详见 [用户系统](./user-system.md)。

## 状态说明

`state.cloudStatus` 取值：

| 值 | 含义 |
| --- | --- |
| `idle` | 尚未开始同步 |
| `loading` | 正在从云端恢复 |
| `ready` | 云端已连接 |
| `error` | 拉取或写入失败，`state.cloudError` 为原因 |
| `unavailable` | 当前基础库环境不支持云开发 |

## 已知取舍

- 实时滚动缓存里的胸口 PPG 波形落云时会抽稀到 1500 点（跳点序列保留峰值），
  完整波形仍保存在每次主动检测归档与日级归档里。
- 云端写入有约 0.8～1.5 秒防抖；极端情况下（立刻杀进程）可能丢最后一次写入，
  下一次数据变化会重新覆盖写入。
