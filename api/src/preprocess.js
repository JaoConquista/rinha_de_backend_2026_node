"use strict";
require("dotenv").config();

const fs   = require("fs");
const zlib = require("zlib");
const path = require("path");

const RESOURCES = process.env.RESOURCES_DIR || '../resources';
const CACHE     = process.env.CACHE_DIR     || './cache';
const DIM       = 14;

const vectorsPath = path.join(CACHE, 'vectors.bin');
const labelsPath  = path.join(CACHE, 'labels.bin');

const preprocessData = async () => {
  // Se já existe, não faz nada (útil se o volume persistir entre runs)
  if (fs.existsSync(vectorsPath) && fs.existsSync(labelsPath)) {
    console.log('[preprocessor] Binários já existem, pulando.');
    return;
  }
console.log('[preprocessor] Iniciando...');

// ─── Streaming do .gz ──────────────────────────────────────────────────────
//
// Por que stream aqui e não gunzipSync?
// O preprocessor não tem limite de 165 MB — ele é um container separado
// que sobe e morre. Mas usar stream é mais educativo e evita pico mesmo assim.
//
// A ideia: decomprimimos chunk por chunk e acumulamos apenas os chunks
// do buffer descomprimido, nunca mantendo o .gz e o JSON ao mesmo tempo.

const compressed   = fs.readFileSync(path.join(RESOURCES, 'references.json.gz'));
// aqui podemos usar gunzipSync no preprocessor sem medo:
// ele não tem o limite de 165 MB dos containers de API
const decompressed = zlib.gunzipSync(compressed);

// libera o buffer comprimido antes do JSON.parse
compressed.fill(0);  // dica ao GC

const references = JSON.parse(decompressed);
decompressed.fill(0); // libera antes de alocar os typed arrays

const N = references.length;
console.log(`[preprocessor] ${N} referências encontradas`);

const vectors = new Int8Array(N * DIM);
const labels  = new Uint8Array(N);

for (let i = 0; i < N; i++) {
  const ref = references[i];
  labels[i] = ref.label === 'fraud' ? 1 : 0;

  for (let d = 0; d < DIM; d++) {
    const v = ref.vector[d];
    vectors[i * DIM + d] = v < 0 ? -128 : Math.round(v * 127);
  }
}

fs.mkdirSync(CACHE, { recursive: true });
fs.writeFileSync(vectorsPath, Buffer.from(vectors.buffer));
fs.writeFileSync(labelsPath,  Buffer.from(labels.buffer));

console.log(`[preprocessor] Pronto. vectors.bin: ${(vectors.byteLength / 1e6).toFixed(1)} MB`);
return
};

module.exports = preprocessData;