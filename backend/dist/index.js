"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const ws_1 = require("ws");
const ethers_1 = require("ethers");
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const PORT = process.env.PORT || 4000;
// Basic config - can be adjusted later or via env vars
// 默认使用 LlamaNodes 提供的公共以太坊主网 RPC（无需 API Key）
// 如需更稳定/高配，请在环境变量中设置 RPC_URL 覆盖此地址
const RPC_URL = process.env.RPC_URL ||
    "https://eth.llamarpc.com";
const provider = new ethers_1.ethers.JsonRpcProvider(RPC_URL);
const alerts = [];
const recentTxs = [];
// Simple anomaly detection rules
const LARGE_TX_THRESHOLD_ETH = 100; // example: transactions >= 100 ETH
async function scanLatestBlocks() {
    let lastScannedBlock = null;
    while (true) {
        try {
            const latestBlock = await provider.getBlockNumber();
            if (lastScannedBlock === null) {
                lastScannedBlock = latestBlock;
            }
            else if (latestBlock > lastScannedBlock) {
                for (let bn = lastScannedBlock + 1; bn <= latestBlock; bn++) {
                    const block = await provider.getBlock(bn);
                    if (block && block.transactions && block.transactions.length > 0) {
                        const txHashes = block.transactions;
                        for (const hash of txHashes) {
                            const tx = await provider.getTransaction(hash);
                            if (!tx)
                                continue;
                            const valueEth = Number(ethers_1.ethers.formatEther(tx.value ?? 0n));
                            const isAlert = valueEth >= LARGE_TX_THRESHOLD_ETH;
                            const baseTx = {
                                id: `${tx.hash}-${Date.now()}`,
                                txHash: tx.hash,
                                blockNumber: block.number,
                                from: tx.from,
                                to: tx.to,
                                valueEth: valueEth.toFixed(4),
                                isAlert,
                                rule: isAlert
                                    ? `大额转账 >= ${LARGE_TX_THRESHOLD_ETH} ETH`
                                    : undefined,
                                createdAt: Date.now(),
                            };
                            recentTxs.unshift(baseTx);
                            if (recentTxs.length > 300) {
                                recentTxs.splice(300);
                            }
                            if (isAlert) {
                                const alert = { ...baseTx, isAlert: true };
                                alerts.unshift(alert);
                                if (alerts.length > 200) {
                                    alerts.splice(200);
                                }
                                broadcastAlert(alert);
                            }
                            broadcastTx(baseTx);
                        }
                    }
                }
                lastScannedBlock = latestBlock;
            }
        }
        catch (err) {
            console.error("Scan error:", err);
        }
        // small delay to avoid spamming the RPC
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
}
// 静态前端
const FRONTEND_DIR = path_1.default.join(__dirname, "..", "..", "frontend");
app.use(express_1.default.static(FRONTEND_DIR));
// HTTP APIs
app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
});
app.get("/api/alerts", (_req, res) => {
    res.json({ alerts });
});
app.get("/api/txs", (_req, res) => {
    res.json({ txs: recentTxs });
});
app.get("/api/status", async (_req, res) => {
    try {
        const [network, latestBlock] = await Promise.all([
            provider.getNetwork(),
            provider.getBlockNumber(),
        ]);
        res.json({
            chainId: network.chainId.toString(),
            name: network.name,
            latestBlock,
            rpcUrl: RPC_URL,
            largeTxThresholdEth: LARGE_TX_THRESHOLD_ETH,
        });
    }
    catch (e) {
        res.status(500).json({ error: "Failed to fetch status" });
    }
});
const server = app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
});
// WebSocket for real-time alerts & tx stream
const wss = new ws_1.WebSocketServer({ server, path: "/ws/alerts" });
function broadcastAlert(alert) {
    const payload = JSON.stringify({ type: "alert", data: alert });
    wss.clients.forEach((client) => {
        // 1 === OPEN
        if (client.readyState === 1) {
            client.send(payload);
        }
    });
}
function broadcastTx(tx) {
    const payload = JSON.stringify({ type: "tx", data: tx });
    wss.clients.forEach((client) => {
        if (client.readyState === 1) {
            client.send(payload);
        }
    });
}
wss.on("connection", (ws) => {
    ws.send(JSON.stringify({
        type: "init",
        data: {
            alerts: alerts.slice(0, 50),
            txs: recentTxs.slice(0, 200),
        },
    }));
});
// Start background scanner
scanLatestBlocks().catch((e) => console.error(e));
