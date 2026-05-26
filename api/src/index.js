"use strict";

require("dotenv").config();
const fastify = require("fastify");
const fs      = require("fs");
const path    = require("path");

const PORT          = parseInt(process.env.PORT || "3000", 10);
const RESOURCES_DIR = process.env.RESOURCES_DIR || "../resources";
const DIM           = 14;
const K             = 5;
const THRESHOLD     = 0.6;

const app = fastify({ logger: false });

let refVectors = null;   // Int8Array  : N * DIM
let refLabels  = null;   // Uint8Array : N
let mccRisk    = {};
let normConst  = {};

// ─── MELHORIA 3: pool de buffers ────────────────────────────────────────────
// Node.js é single-thread: entre vectorize() e findKNN() não há await,
// então dois requests nunca compartilham o mesmo slot simultaneamente.
const POOL_SIZE   = 32;
const vectorPool  = Array.from({ length: POOL_SIZE }, () => new Int8Array(DIM));
let   poolIdx     = 0;

function getPooledVector() {
    const v = vectorPool[poolIdx];
    poolIdx  = (poolIdx + 1) % POOL_SIZE;
    return v;
}
// ────────────────────────────────────────────────────────────────────────────

// ─── MELHORIA 1: loadData sem dupla leitura ──────────────────────────────────
// Antes: lia o cache binário E depois reprocessava o JSON.gz, sobrescrevendo
// os arrays. Agora: usa só o cache binário — muito mais rápido no startup.
async function loadData() {
    const CACHE = process.env.CACHE_DIR || "./cache";

    const vecBuf   = fs.readFileSync(path.join(CACHE, "vectors.bin"));
    refVectors     = new Int8Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.byteLength);

    const lblBuf   = fs.readFileSync(path.join(CACHE, "labels.bin"));
    refLabels      = new Uint8Array(lblBuf.buffer, lblBuf.byteOffset, lblBuf.byteLength);

    normConst = JSON.parse(
        fs.readFileSync(path.join(RESOURCES_DIR, "normalization.json"), "utf8")
    );
    mccRisk = JSON.parse(
        fs.readFileSync(path.join(RESOURCES_DIR, "mcc_risk.json"), "utf8")
    );

    console.log(`[startup] ${refLabels.length} vetores carregados do cache binário`);
}
// ────────────────────────────────────────────────────────────────────────────

function vectorize(payload, q) {
    const { transaction, customer, merchant, terminal, last_transaction } = payload;
    const n = normConst;

    // clamp inline — evita overhead de chamada de função no hot path
    const clamp = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

    const dt        = new Date(transaction.requested_at);
    const hourOfDay = dt.getHours();
    const dayOfWeek = (dt.getUTCDay() + 6) % 7;

    let minSinceLast = -128;
    let kmFromLast   = -128;

    if (last_transaction) {
        const lastMs  = new Date(last_transaction.timestamp).getTime();
        const currMs  = dt.getTime();
        const minutes = (currMs - lastMs) / 60000;
        minSinceLast  = Math.round(clamp(minutes / n.max_minutes) * 127);
        kmFromLast    = Math.round(clamp(last_transaction.km_from_current / n.max_km) * 127);
    }

    const unknownMerchant = customer.known_merchants.includes(merchant.id) ? 0 : 1;
    const mccRiskValue    = mccRisk[merchant.mcc] !== undefined ? mccRisk[merchant.mcc] : 0.5;

    // Reutiliza o buffer do pool em vez de `new Int8Array(DIM)` a cada request
    q[0]  = Math.round(clamp(transaction.amount / n.max_amount) * 127);
    q[1]  = Math.round(clamp(transaction.installments / n.max_installments) * 127);
    q[2]  = Math.round(clamp((transaction.amount / customer.avg_amount) / n.amount_vs_avg_ratio) * 127);
    q[3]  = Math.round((hourOfDay / 23) * 127);
    q[4]  = Math.round((dayOfWeek / 6) * 127);
    q[5]  = minSinceLast;
    q[6]  = kmFromLast;
    q[7]  = Math.round(clamp(terminal.km_from_home / n.max_km) * 127);
    q[8]  = Math.round(clamp(customer.tx_count_24h / n.max_tx_count_24h) * 127);
    q[9]  = terminal.is_online    ? 127 : 0;
    q[10] = terminal.card_present ? 127 : 0;
    q[11] = unknownMerchant       ? 127 : 0;
    q[12] = Math.round(mccRiskValue * 127);
    q[13] = Math.round(clamp(merchant.avg_amount / n.max_merchant_avg_amount) * 127);
}

// ─── MELHORIA 2: findKNN com early exit ─────────────────────────────────────
// A distância euclidiana ao quadrado é uma soma monotonicamente crescente.
// Se o acumulador já supera worstDist antes de somar todas as dimensões,
// o ponto pode ser descartado sem calcular o resto — early exit no inner loop.
// Para K=5 e DIM=14 isso elimina cálculos desnecessários com frequência.
function findKNN(query) {
    const N        = refLabels.length;
    const topDists = new Float32Array(K).fill(Infinity);
    const topLabels = new Uint8Array(K);
    let worstIdx  = 0;
    let worstDist = Infinity;

    for (let i = 0; i < N; i++) {
        const base = i * DIM;
        let dist   = 0;

        for (let d = 0; d < DIM; d++) {
            const diff = query[d] - refVectors[base + d];
            dist += diff * diff;
            if (dist >= worstDist) { dist = Infinity; break; } // early exit
        }

        if (dist < worstDist) {
            topDists[worstIdx]  = dist;
            topLabels[worstIdx] = refLabels[i];

            // Encontra o novo pior entre os K (K=5, loop trivial)
            worstDist = -1;
            for (let j = 0; j < K; j++) {
                if (topDists[j] > worstDist) {
                    worstDist = topDists[j];
                    worstIdx  = j;
                }
            }
        }
    }

    return topLabels;
}
// ────────────────────────────────────────────────────────────────────────────

// ─── MELHORIA 4: schema validation no Fastify ────────────────────────────────
// Com schema declarado o Fastify usa fast-json-stringify + ajv para parsing
// e serialização, evitando JSON.parse genérico no hot path.
const fraudScoreSchema = {
    body: {
        type: "object",
        required: ["transaction", "customer", "merchant", "terminal"],
        properties: {
            transaction: {
                type: "object",
                required: ["amount", "installments", "requested_at"],
                properties: {
                    amount:       { type: "number" },
                    installments: { type: "number" },
                    requested_at: { type: "string" },
                },
            },
            customer: {
                type: "object",
                required: ["avg_amount", "tx_count_24h", "known_merchants"],
                properties: {
                    avg_amount:       { type: "number" },
                    tx_count_24h:     { type: "number" },
                    known_merchants:  { type: "array", items: { type: "string" } },
                },
            },
            merchant: {
                type: "object",
                required: ["id", "mcc", "avg_amount"],
                properties: {
                    id:         { type: "string" },
                    mcc:        { type: "string" },
                    avg_amount: { type: "number" },
                },
            },
            terminal: {
                type: "object",
                required: ["km_from_home", "is_online", "card_present"],
                properties: {
                    km_from_home:  { type: "number" },
                    is_online:     { type: "boolean" },
                    card_present:  { type: "boolean" },
                },
            },
            last_transaction: {
                type: ["object", "null"],
                properties: {
                    timestamp:        { type: "string" },
                    km_from_current:  { type: "number" },
                },
            },
        },
    },
    response: {
        200: {
            type: "object",
            properties: {
                approved:    { type: "boolean" },
                fraud_score: { type: "number" },
            },
        },
    },
};
// ────────────────────────────────────────────────────────────────────────────

app.get("/ready", async (req, reply) => {
    if (!refVectors) return reply.code(503).send({ status: "loading" });
    return reply.code(200).send({ status: "ok" });
});

app.post("/fraud-score", { schema: fraudScoreSchema }, async (req, reply) => {
    const q         = getPooledVector();     // reutiliza buffer do pool
    vectorize(req.body, q);
    const neighbors = findKNN(q);

    let fraudCount = 0;
    for (let i = 0; i < K; i++) {
        if (neighbors[i] === 1) fraudCount++;
    }

    const fraudScore = fraudCount / K;
    const approved   = fraudScore < THRESHOLD;

    return { approved, fraud_score: fraudScore };
});

async function start() {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    await loadData();
    console.log(`[ready] API ouvindo em 0.0.0.0:${PORT}`);
}

start().catch((err) => {
    console.error(err);
    process.exit(1);
});