# HOLD BLE 数据闭环验证

## 当前集成环境

- 固件环境：`xiao_esp32s3_full_smoke_test`
- 小程序目录：`web/`
- 主 I2C：D4 / GPIO5 为 SDA，D5 / GPIO6 为 SCL
- 预期地址：MAX30102 `0x57`、MPU6500 `0x68`、DRV2605L `0x5A`

## 遥测字段

固件通过 BLE 通知发送 `t=tel` JSON。关键字段如下：

| 字段 | 含义 | 有效条件 |
| --- | --- | --- |
| `hr` | 心率 bpm | `pp=1`、`ct=1`，范围 35 到 220 |
| `br` | 呼吸率 次/分 | 范围 6 到 45，并满足来源条件；不依赖综合 `wear` 位 |
| `bs` | 呼吸来源 | `imu`、`pressure` 或 `none` |
| `bd` | IMU 呼吸判定阶段 | `warmup`、`motion`、`cycle`、`confirm`、`valid` |
| `bx` / `bn` / `ba` | 候选呼吸率 / 连续周期数 / 个体阈值 | 用于定位呼吸为何尚未有效，不参与健康结论 |
| `mr` / `mo` | IMU 就绪 / 运动状态 | 比较窗口只接受 `mr=1` 且 `mo=still` |
| `pp` / `ir` / `red` | PPG 就绪 / 原始红外 / 红光 | 原始值只用于波形和接触判断 |
| `ps` / `pr` / `pl` | 压力就绪 / 原始值 / 等级 | 压力来源呼吸要求 `ps=1` 且 `pr` 有限 |
| `sessionId` | 小程序连接会话 | 引导事件和前后样本必须完全一致 |

`bs=imu` 时呼吸有效性依赖 `mr=1`；`bs=pressure` 时依赖 `ps=1`。`bs=none`、缺失或未知来源一律无效。综合 `wear` 可能受 PPG/压力贴合状态影响，不能反向否决已经由对应来源确认的呼吸率。不得把两个来源混在同一次前后比较中。

IMU 首次用 3 秒窗口选择呼吸变化最大的轴。若 12 秒仍没有形成候选周期，固件会重新学习轴，避免佩戴动作让算法永久锁在错误方向；重学期间 `bd` 会回到 `warmup`，不是断连。

## 前后对比准入

综合变化分数只在以下条件全部满足时显示：

1. `breath_start`、`breath_stop` 和遥测样本属于同一个非空 `sessionId`。
2. 引导前后各有至少 24 秒有效静止覆盖；引导后从第一个有效目标指标样本开始取窗。
3. 两个窗口的心率均有效。
4. 两个窗口的呼吸均有效，且来自同一个 `bs`。
5. 每个窗口至少 8 条有效样本，且有效样本覆盖满足同一门槛。

若只有心率或呼吸一项满足前后窗口，界面只显示该单指标的方向，不生成综合分数。两项均不足时显示原因，也不使用旧报告或历史占位数据补齐。引导前使用中性基线色；引导后暖色表示指标上升方向，青绿冷色表示下降方向，并直接显示有效指标差值。该结果仅表示本次变化趋势，不是焦虑诊断或医学诊断。

## 用户测试闭环

首页“开始一次舒缓测试”进入专用流程：

1. 确认 BLE 命令特征、实时遥测、PPG 接触和静止状态。
2. 用户填写引导前紧张感，记录 30 秒稳定基线。
3. 执行 60 秒呼吸引导；震动增强对应吸气，减弱对应呼气，用户可提前停止。
4. 引导结束后继续记录 30 秒恢复数据，再填写引导后紧张感。
5. 主观变化始终单独展示；生理趋势只采用本次同一 BLE 会话的有效数据。

断开 BLE 不会自动生成记录，恢复数据不足也不会回退到上一条报告。

## 验证命令

```powershell
$env:PLATFORMIO_CORE_DIR='D:\Desktop\HOLD-main\.platformio'
pio run -e xiao_esp32s3_full_smoke_test
pio run -e xiao_esp32s3_full_smoke_test -t upload --upload-port COM13
node web/tests/ble-notify-smoke.js
node web/tests/health-comparison-smoke.js
python tools/serial/verify_integrated_stream.py --self-test
```

复位后串口必须看到：

```text
[self-test] imu-respiration=PASS
[smoke][i2c-scan] D4/D5 primary ... found=0x57,0x5A,0x68
[smoke] init ... imu=OK | ppg=OK | pressure=OK | motor=OK
```

真人验证时先稳定佩戴且不启动震动。调试页的 `bd` 应依次经过 `warmup/cycle/confirm/valid`，随后出现 `br=6..45` 和 `bs=imu` 或 `bs=pressure`；若显示 `motion`，需保持设备稳定。连接后退出调试页，缓存序号仍应持续增长。完成一次引导后继续静止佩戴，系统从首个有效心率与呼吸样本开始形成后测窗口，首页、当日分析、历史与报告应显示同一次会话的实时波形及前后比较。

佩戴验收时关闭微信蓝牙连接后运行以下命令；打开串口会重启开发板，因此需在命令开始后立即稳定佩戴：

```powershell
python tools/serial/verify_integrated_stream.py --port COM13 --duration 90 --require-vitals
```

只有 `i2c`、`imu`、`ppg`、`pressure`、`haptic`、`heart` 和 `breath` 全部显示 `PASS`，才算板端真实数据验收完成。
