const { parentPort, workerData } = require('node:worker_threads');
require('pdf-parse')(Buffer.from(workerData)).then(result => parentPort.postMessage({ text: result.text.slice(0, 1000000), pages: result.numpages })).catch(() => parentPort.postMessage({ error: 'PDF inválido, protegido ou não legível.' }));
