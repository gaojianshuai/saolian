import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { ethers } from "ethers";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// Basic config - can be adjusted later or via env vars
// 默认使用 LlamaNodes 提供的公共以太坊主网 RPC（无需 API Key）
// 如需更稳定/高配，请在环境变量中设置 RPC_URL 覆盖此地址
const RPC_URL =
  process.env.RPC_URL ||
  "https://eth.llamarpc.com";

const provider = new ethers.JsonRpcProvider(RPC_URL);

// BTC public API (mempool.space). You can override via BTC_API_BASE env.
const BTC_API_BASE =
  process.env.BTC_API_BASE || "https://mempool.space/api";

type TxItem = {
  id: string;
  txHash: string;
  blockNumber: number;
  from: string;
  to: string | null;
  valueEth: string;
  isAlert: boolean;
  rule?: string;
  createdAt: number;
};

type Alert = TxItem;

const alerts: Alert[] = [];
const recentTxs: TxItem[] = [];

type BtcTxItem = {
  id: string;
  txid: string;
  valueBtc: string;
  feeBtc: string;
  vsize: number;
  isAlert: boolean;
  rule?: string;
  createdAt: number;
};

const btcTxs: BtcTxItem[] = [];
const seenBtcTxids = new Set<string>();

// Simple anomaly detection rules
const LARGE_TX_THRESHOLD_ETH = 100; // example: transactions >= 100 ETH
const LARGE_TX_THRESHOLD_BTC = 10; // example: transactions >= 10 BTC

async function scanLatestBlocks() {
  let lastScannedBlock: number | null = null;

  while (true) {
    try {
      const latestBlock = await provider.getBlockNumber();

      if (lastScannedBlock === null) {
        lastScannedBlock = latestBlock;
      } else if (latestBlock > lastScannedBlock) {
        for (let bn = lastScannedBlock + 1; bn <= latestBlock; bn++) {
          const block = await provider.getBlock(bn);
          if (block && block.transactions && block.transactions.length > 0) {
            const txHashes = block.transactions;
            for (const hash of txHashes) {
              const tx = await provider.getTransaction(hash);
              if (!tx) continue;

              const valueEth = Number(ethers.formatEther(tx.value ?? 0n));

              const isAlert = valueEth >= LARGE_TX_THRESHOLD_ETH;
              const baseTx: TxItem = {
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
                const alert: Alert = { ...baseTx, isAlert: true };
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
    } catch (err) {
      console.error("Scan error:", err);
    }

    // small delay to avoid spamming the RPC
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function scanBtcMempool() {
  while (true) {
    try {
      const res = await fetch(`${BTC_API_BASE}/mempool/recent`);
      if (!res.ok) {
        throw new Error(`BTC mempool api error: ${res.status}`);
      }
      const data = (await res.json()) as any[];
      const now = Date.now();

      for (const item of data) {
        const txid: string = item.txid;
        if (!txid || seenBtcTxids.has(txid)) continue;
        seenBtcTxids.add(txid);

        const valueBtc = Number(item.value || 0) / 1e8;
        const feeBtc = Number(item.fee || 0) / 1e8;
        const isAlert = valueBtc >= LARGE_TX_THRESHOLD_BTC;

        const tx: BtcTxItem = {
          id: `${txid}-${now}`,
          txid,
          valueBtc: valueBtc.toFixed(8),
          feeBtc: feeBtc.toFixed(8),
          vsize: Number(item.vsize || 0),
          isAlert,
          rule: isAlert
            ? `大额 BTC 转账 >= ${LARGE_TX_THRESHOLD_BTC} BTC`
            : undefined,
          createdAt: now,
        };

        btcTxs.unshift(tx);
        if (btcTxs.length > 300) btcTxs.splice(300);

        broadcastBtcTx(tx);
      }
    } catch (err) {
      console.error("BTC scan error:", err);
    }

    await new Promise((resolve) => setTimeout(resolve, 7000));
  }
}

// 静态前端
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend");
app.use(express.static(FRONTEND_DIR));

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

app.get("/api/btc/txs", (_req, res) => {
  res.json({ txs: btcTxs });
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
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch status" });
  }
});

app.get("/api/btc/status", async (_req, res) => {
  try {
    const [heightRes, mempoolRes] = await Promise.all([
      fetch(`${BTC_API_BASE}/blocks/tip/height`),
      fetch(`${BTC_API_BASE}/mempool`),
    ]);
    const heightText = await heightRes.text();
    const height = Number(heightText);
    const mempool = await mempoolRes.json();

    res.json({
      chain: "bitcoin",
      height,
      mempoolSize: mempool.count,
      mempoolVsize: mempool.vsize,
      apiBase: BTC_API_BASE,
      largeTxThresholdBtc: LARGE_TX_THRESHOLD_BTC,
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch btc status" });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});

// WebSocket for real-time alerts & tx stream
const wss = new WebSocketServer({ server, path: "/ws/alerts" });

function broadcastAlert(alert: Alert) {
  const payload = JSON.stringify({ type: "alert", data: alert });
  wss.clients.forEach((client) => {
    // 1 === OPEN
    if ((client as any).readyState === 1) {
      (client as any).send(payload);
    }
  });
}

function broadcastTx(tx: TxItem) {
  const payload = JSON.stringify({ type: "tx", data: tx });
  wss.clients.forEach((client) => {
    if ((client as any).readyState === 1) {
      (client as any).send(payload);
    }
  });
}

function broadcastBtcTx(tx: BtcTxItem) {
  const payload = JSON.stringify({ type: "btc_tx", data: tx });
  wss.clients.forEach((client) => {
    if ((client as any).readyState === 1) {
      (client as any).send(payload);
    }
  });
}

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "init",
      data: {
        alerts: alerts.slice(0, 50),
        txs: recentTxs.slice(0, 200),
        btcTxs: btcTxs.slice(0, 200),
      },
    })
  );
});

// Start background scanner
scanLatestBlocks().catch((e) => console.error(e));
scanBtcMempool().catch((e) => console.error(e));
