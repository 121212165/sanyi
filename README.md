# 三弈 · 满强度引擎对局与训练台

围棋 / 国际象棋 / 中国象棋。两种模式：**比赛**（只有快棋与不限时两档，对手难度拉满，不可提问不可暂停）和**学习**（同样满强度、同样整盘，但暴露引擎搜索数据、可提问、可推演），外加**复盘**（AI 复盘 / 自己复盘推演）。

引擎跑在本机，网页只是显示器：棋钟由本地桥接进程计时。

## 现在能用到什么程度

| | 状态 |
|---|---|
| 围棋规则内核（气、提子、禁自杀、位置超劫、中国数子） | ✅ 49 项单元测试通过 |
| SGF 读写（含变着、-setup  stone、转义注释） | ✅ 自研，14 项测试通过 |
| 棋谱树 / 变着 / 推演重生根 | ✅ 有测试 |
| 棋钟（Fischer 增量、simple delay、围棋读秒、超时判负） | ✅ 有测试 |
| KataGo v1.18.1 分析协议客户端 + packet 转换 | ✅ 端到端跑通 |
| 本机算力实测（CPU 与 Arc 核显两条后端） | ✅ `fixtures/katago/throughput-*.json` |
| 本地引擎桥（ws + 权威时钟 + 串行调度 + 按实测挑后端） | ✅ `tools/smoke-bridge.ts` 验证 |
| 网页对局（比赛两档 / 学习模式数据面板） | ✅ 真实浏览器验证：水合、361 落点、点击 D4 引擎应 Q16、无 JS 报错（`tools/browser_check.py`） |
| 思考链面板的 LLM 讲解 + 提问 | ⛔ 未开始 |
| AI 复盘 / 自己复盘 | ⛔ 未开始 |
| 国际象棋 / 中国象棋 | ⛔ 未开始 |
| 云同步 | ⛔ 未开始 |

## 实测数字（这台机器，同一测量口径）

| 后端 | visits/秒 | 一手 100 visits | 一手 1000 visits | 归属图开销 | 41 处复盘扫描 |
|---|---|---|---|---|---|
| Eigen CPU（8 线程） | **10.3** | ~10s | ~97s | 1.3–1.4x | 0.38 s/处 |
| **OpenCL / Arc 核显（6 线程）** | **51.9** | ~2s | ~19s | 1.07x | 0.17 s/处 |

核显比 CPU 快 **5 倍**，因此 bridge 默认优先选 OpenCL 后端（按实测吞吐挑选，不写死）。调参结果已缓存到 `.local/engines/katago_opencl/1.18.1/KataGoData/opencltuning/`，换网络或换板径会重新调参（首次约 25 分钟）。

由此定的实际预算：快棋档每手 2 秒 ≈ **104 visits**；不限时档持续加算，20 秒 ≈ 1038 visits，5 分钟 ≈ 15000 visits，不设上限由你按「采纳当前着法」决定。


## 上手

```bash
npm install                                # 依赖
node tools/fetch-engines.mjs katago        # CPU 后端（约 104MB，校验 sha256）
node tools/fetch-engines.mjs katago_opencl # Arc 核显后端（快 5 倍）
npm run bench:katago                       # 实测 CPU 后端 → fixtures/katago/throughput-katago.json
npm run bench:katago -- --flavor katago_opencl --threads 6   # 实测核显后端
npm run bridge                             # 终端 A：ws://127.0.0.1:8788
npm run web                                # 终端 B：http://localhost:3100/play
npx tsx tools/smoke-bridge.ts              # 端到端自检：后端选择、真实着法、非法棋谱被拒
```

`fetch-engines.mjs` 只把引擎下到 `.local/`（已 gitignore，不入库）。改引擎版本请同步更新 `engines.lock.json` 里的 `sha256`——脚本会打印未钉住（UNPINNED）的哈希。

> OpenCL 后端首次运行需要自动调参（`katago benchmark`，本机约 25 分钟），调参文件落在
> `.local/engines/katago_opencl/1.18.1/KataGoData/opencltuning/`。没跑过就没有这个文件，
> 首次分析会在加载时重新调参。


## 为什么这套设计长这样

**算力是这台机器的硬约束。** Core Ultra 5 125H + Intel Arc 核显，没有 CUDA。实测 KataGo b18c384nbt 走 Eigen CPU 只有约 **10 visits/秒**（8 搜索线程）：

- 一手 200 visits ≈ 19 秒 → 「快棋档每手 2 秒」只能给到约 20 visits，这不叫拉满，界面必须明说；
- 真正「不设上限」的不限时档才有满强度，代价是一手几分钟，所以做成**持续加算 + 随时采纳**；
- 整盘复盘用 `analyzeTurns` 批量算（共享搜索树），实测 41 个局面 @60 visits 只要约 16 秒，比逐点重算快一个量级——这是复盘能用的原因。

所以引擎层留了一个接缝（`native` / `wasm` / `remote` / `cloudeval`），任何界面话术里出现「最强」都必须来自 `StrengthBadge`，且带 `measured` 标志：没在这台机器上实测过的强度不许说满。

**「思考链」不能是编的。** UCI 和 KataGo 都不输出思考过程。学习模式顶部常驻一行声明，面板只展示搜索结果（候选 + visits + 胜率 + 目差 + PV + 归属热度），LLM 只允许引用 packet 里存在的字段，指不到就降级标注或丢弃。

## 结构

```
packages/core     规则内核、棋局树、棋钟、AnalysisPacket 类型（MIT 依赖）
packages/engine   KataGo 分析协议客户端、packet 转换、失误分级
packages/bridge   本机常驻进程：引擎子进程 + 权威棋钟 + 串行调度（ws，token/Origin 校验）
apps/web          Next.js 界面
tools             引擎下载、算力实测
fixtures/katago   实测数据与真实响应样本（预算与断言的来源）
```

## 许可

Stockfish / Pikafish / Fairy-Stockfish 是 GPLv3：本项目**不入库、不分发**引擎二进制（由脚本从上游下载），一旦向浏览器分发 wasm 就必须公布对应源码。KataGo 是 MIT。前端依赖刻意避开 GPL 的 `chessground`/`chessops` 一族，象棋/围棋棋盘自绘 SVG。
