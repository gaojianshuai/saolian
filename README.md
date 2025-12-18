## 链上实时风控监控中心

本项目是在本地部署的**扫链 + 异常交易告警**系统，提供专业级的链上监控大屏。

### 目录结构

- `backend`：Node.js + TypeScript 后端服务，负责：
  - 连接以太坊节点（默认主网）
  - 持续扫描最新区块
  - 根据规则识别异常交易（默认：单笔转账金额 ≥ 100 ETH）
  - 通过 HTTP API & WebSocket 推送告警
- `frontend`：纯静态前端页面（`index.html`），使用 Tailwind CSS 构建现代化监控大屏。

### 启动步骤（前后端一键启动）

1. **安装依赖**

   在项目根目录执行（会自动安装后端依赖）：

   ```bash
   npm install
   ```

2. **配置 RPC（可选）**

   默认使用更稳定的公共以太坊 RPC：

   ```txt
   https://cloudflare-eth.com
   ```

   如果你有自己的节点或服务，建议在启动前设置环境变量（Windows PowerShell 示例）：

   ```bash
   $env:RPC_URL="https://your-ethereum-rpc"
   ```

3. **一键启动前后端（开发模式）**

   ```bash
   npm run dev
   ```

   - 后端 + 前端静态文件统一由 `http://localhost:4000` 提供
   - 浏览器直接访问：`http://localhost:4000` 即可看到监控大屏

   页面会自动连接同源的 API 与 WebSocket，实时展示：

   - 链上运行状态（链 ID / 最新区块 / RPC URL / 告警阈值）
   - 实时异常交易告警卡片
   - 告警明细表
   - 告警统计（今日累计、近 10 分钟）

### 告警规则（默认）

- 扫描最新区块中的所有交易
- 当单笔转账金额满足：

  \[
  \text{value} \ge 100 \text{ ETH}
  \]

  时触发告警。

> 你可以在 `backend/src/index.ts` 中修改 `LARGE_TX_THRESHOLD_ETH`，调整大额阈值或扩展更多风控规则（例如黑名单地址、可疑合约交互等）。


