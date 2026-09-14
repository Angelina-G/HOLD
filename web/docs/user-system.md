# HOLD 小程序用户系统说明

用户系统基于**微信云开发**实现：小程序端不接触 `openid`，
登录时由云函数用 `cloud.getWXContext()` 直接取，避免身份标识被伪造。
首次打开小程序即自动建号，无需额外注册步骤。

## 数据模型

| 集合 | 作用 | 关键字段 |
| --- | --- | --- |
| `hold_users` | 账号档案，一人一条 | `_openid`（微信身份，系统写入不可伪造）、`nickname`、`avatarUrl`、`created_at_ms`、`last_login_at_ms`、`loginCount` |

健康数据集合（`hold_user_state` / `hold_active_measurements` / `hold_daily_analyses`）
新增两个归属字段语义：

- `_openid`：写入时由数据库自动带上，**不可伪造**，是真正的归属标识；
- `openid`：业务字段。已登录时存**账号身份**，未登录时回落为该设备成员的真实 openid。

## 登录流程

```
小程序启动
  └─ holdAccount.login()                    ← app.js onLaunch，静默执行
       └─ wx.cloud.callFunction(health_account / login)
            └─ 云函数取 WXContext.OPENID
                 ├─ hold_users 无档 → 建号（昵称默认「微信用户」）
                 └─ 有档 → 更新 last_login_at_ms、loginCount +1
```

失败不阻断启动：未登录时读取会回落到**设备共享范围**，
新用户在没有登录的情况下也能看到这台设备此前归档的数据。

## 两种数据范围

| scope | 触发条件 | 读取范围 |
| --- | --- | --- |
| `mine` | 已登录 | 只读当前微信身份的记录 |
| `shared` | 未登录 | 读本机全部成员的记录（`_openid` 前缀匹配） |

登录状态变化时，`hold-ble-runtime` 会先把待写队列 flush（避免写到新身份下），
再按新的 scope 重新 `pull` 一次。

> 设计取舍：微信小程序内的 `openid` 是**同一 appid 身份空间**，
> 所以 `shared` 语义是「这台设备上的所有使用者」，而不是任意跨用户公开读。
> 如果后续要支持多个家庭成员的独立档案与互相授权，需要再加一层显式的
> 成员绑定与授权集合。

## 昵称与头像

`wx.getUserProfile` 与 `<open-data>` 已经无法拿到真实昵称头像，所以：

- **昵称**：默认「微信用户」，用户在「我的」页可手动修改（≤20 字），
  输入框用 `type="nickname"`，会带出微信键盘的昵称快捷输入；
- **头像**：`<button open-type="chooseAvatar">` 让用户自选，
  拿到的是本地临时路径，由云函数 `health_account` 转存到云存储
  `avatars/{openid}/{时间戳}.png` 并回存 `cloud://` 文件 ID。

## 页面

新增 tab「我的」（`pages/profile/index`）：

- 未登录：微信官方登录卡片形态，一键登录按钮；
- 已登录：头像（可点击更换）、昵称（可改名）、云端数据统计、
  同步状态与数据范围、账号 ID 尾号、注册时间、登录次数、退出登录。

「退出登录」只清除本地账号态，**不删除云端记录**，重新登录即可恢复。

## 部署状态（已部署）

`health_account` 与 `health_store` 均已部署到环境
`hold-dev-env-d2gukfp01ac296189`（Nodejs16.13，入口 `index.main`），
`hold_users` 集合已创建，`_openid` 索引由云开发自动维护。
健康数据集合与索引见 [云端存储说明](./cloud-storage.md)。

代码改动后重新部署：开发者工具右键函数目录「上传并部署：云端安装依赖」，
或 `tcb fn deploy health_account --dir cloudfunctions/health_account`。

数据库权限保持默认「仅创建者可读写」即可：所有访问都经云函数（管理端身份，
不受集合权限规则约束），小程序端不直接读写数据库。

## 可用性设计

`hold-account.js` 调用登录时优先走 `health_account`，
若该云函数尚未部署（返回错误或调用失败），会自动退回
`health_store / user_sync`。两条路径写入同一个 `hold_users` 集合，
所以少部署一个云函数也能跑通。
