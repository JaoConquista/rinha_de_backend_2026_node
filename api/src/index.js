"use strict";

require("dotenv").config();
const fastify = require("fastify");
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");
const { chain } = require("stream-chain");
const { parser } = require("stream-json");
const { streamArray } = require("stream-json/streamers/StreamArray"); 
const preprocessData = require("./preprocess.js");

const PORT = parseInt(process.env.PORT || "3000", 10);
const RESOURCES_DIR = process.env.RESOURCES_DIR || "../resources";
const DIM = 14; //dimensões de cada vetor
const K = 5; //vizinhos mais próximos
const THRESHOLD = 0.6; //limiar de APROVAÇÃO

const app = fastify({logger: false});

let refVectors = null;   // Int8Array: N * DIM elementos
let refLabels  = null;   // Uint8Array: N elementos, 0 = legit, 1 = fraud
let mccRisk    = {};
let normConst  = {};

async function loadData(){

    const CACHE = process.env.CACHE_DIR || "./cache";

    // lendo bytes
    const vecBuf = fs.readFileSync(path.join(CACHE, "vectors.bin"));

    refVectors = new Int8Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.byteLength);

    const lblBuf = fs.readFileSync(path.join(CACHE, "labels.bin"));
    refLabels = new Uint8Array(lblBuf.buffer, lblBuf.byteOffset, lblBuf.byteLength);

    normConst = JSON.parse(
        fs.readFileSync(path.join(RESOURCES_DIR, "normalization.json"), "utf8")
    );

    mccRisk = JSON.parse(
        fs.readFileSync(path.join(RESOURCES_DIR, "mcc_risk.json"), "utf8")
    );

  console.log(`[startup] ${refLabels.length} vetores carregados em binário`);
    
    const tempVectors = [];
    const tempLabels = [];
    
    const pipeline = chain([
        fs.createReadStream(path.join(RESOURCES_DIR, 'references.json.gz')),
        zlib.createGunzip(),
        parser(),
        streamArray()
    ]);
    
    for await (const data of pipeline) {
        const ref = data.value;
        tempLabels.push(ref.label === 'fraud' ? 1 : 0);
        
        const vec = new Int8Array(DIM);
        for (let d = 0; d < DIM; d++) {
            const v = ref.vector[d];
            vec[d] = (v < 0) ? -128 : Math.round(v * 127);
        }
        tempVectors.push(vec);
    }
    
    const N = tempLabels.length;
    console.log(`[startup] ${N} vetores processados, convertendo para TypedArrays...`);
    
    refVectors = new Int8Array(N * DIM);
    refLabels  = new Uint8Array(N);
    
    for (let i = 0; i < N; i++) {
        refLabels[i] = tempLabels[i];
        for (let d = 0; d < DIM; d++) {
            refVectors[i * DIM + d] = tempVectors[i][d];
        }
    }
    
    console.log('[startup] Pronto!');
}

function vectorize(payload){
    const { transaction, customer, merchant, terminal, last_transaction } = payload;
    const n = normConst;

    // Função clamp: mantém o valor dentro de [0.0, 1.0]  
    const clamp = (x) => Math.min(1.0, Math.max(0.0, x));

    // Extrai hora e dia da semana do timestamp UTC
    const dt = new Date(transaction.requested_at);
    const hourOfDay = dt.getHours();

    const dayOfWeek = (dt.getUTCDay() + 6) % 7; // 0=seg, 6=dom

    let minSinceLast = -128;
    let kmFromLast = -128;
    
    if (last_transaction) {
        const lastMs = new Date(last_transaction.timestamp).getTime();
        const currMs = dt.getTime();
        const minutes = (currMs - lastMs) / 60000;
        minSinceLast = Math.round(clamp(minutes / n.max_minutes) * 127);
        kmFromLast = Math.round(clamp(last_transaction.km_from_current / n.max_km) * 127);
    }

    const unknownMerchant = customer.known_merchants.includes(merchant.id) ? 0 : 1;
    const mccRiskValue = mccRisk[merchant.mcc] !== undefined ? mccRisk[merchant.mcc] : 0.5;

    // As 14 dimensões (em Int8, escala 0-127)
    const q = new Int8Array(DIM);
    q[0]  = Math.round(clamp(transaction.amount / n.max_amount) * 127);
    q[1]  = Math.round(clamp(transaction.installments / n.max_installments) * 127);
    q[2]  = Math.round(clamp((transaction.amount / customer.avg_amount) / n.amount_vs_avg_ratio) * 127);
    q[3]  = Math.round((hourOfDay / 23) * 127);
    q[4]  = Math.round((dayOfWeek / 6) * 127);
    q[5]  = minSinceLast;    // sentinela ou valor normalizado
    q[6]  = kmFromLast;      // sentinela ou valor normalizado
    q[7]  = Math.round(clamp(terminal.km_from_home / n.max_km) * 127);
    q[8]  = Math.round(clamp(customer.tx_count_24h / n.max_tx_count_24h) * 127);
    q[9]  = terminal.is_online   ? 127 : 0;
    q[10] = terminal.card_present ? 127 : 0;
    q[11] = unknownMerchant       ? 127 : 0;
    q[12] = Math.round(mccRiskValue * 127);
    q[13] = Math.round(clamp(merchant.avg_amount / n.max_merchant_avg_amount) * 127);

    return q;
};

function findKNN(query){
    const N = refLabels.length;

    const topDists = new Float32Array(K).fill(Infinity);
    const topLabels = new Uint8Array(K);
    let worstIdx = 0
    let worstDist = Infinity
    
    for (let i = 0; i < N; i++) {
        const base = i * DIM;
        let dist = 0;

        // Loop interno tight (o ponto quente da performance)
        for (let d = 0; d < DIM; d++) {
            const diff = query[d] - refVectors[base + d];
            dist += diff * diff;
        }
        
        if (dist < worstDist) {
            topDists[worstIdx] = dist;
            topLabels[worstIdx] = refLabels[i];
            
            // Encontra o novo pior entre os K
            worstDist = -1;
            for (let j = 0; j < K; j++) {
                if (topDists[j] > worstDist) {
                    worstDist = topDists[j];
                    worstIdx = j;
                }
            }
        }
    }
    
    return topLabels;
}

app.get('/ready', async (req, reply) => {
    if (!refVectors) {
        return reply.code(503).send({ status: 'loading' });
    }
    return reply.code(200).send({ status: 'ok' });
});

app.post('/fraud-score', async (req, reply) => {
    const query = vectorize(req.body);
    const neighbors = findKNN(query);

    // Conta fraudes entre os K vizinhos
    let fraudCount = 0;
    for (let i = 0; i < K; i++) {
        if (neighbors[i] === 1) fraudCount++;
    }

    const fraudScore = fraudCount / K;
    const approved = fraudScore < THRESHOLD;

    return { approved, fraud_score: fraudScore };
});

async function start(){

    await preprocessData();

    await app.listen({ port: PORT, host: '0.0.0.0' });

    await loadData();

    console.log(`[ready] API ouvindo em 0.0.0.0:${PORT}`);
}

start().catch((err) => {
    console.error(err);
    process.exit(1);
});
