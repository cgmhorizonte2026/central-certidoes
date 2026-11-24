const { parentPort, workerData } = require('node:worker_threads');
const parse=require('pdf-parse'),bytes=Buffer.from(workerData);
parse(bytes).catch(()=>parse(bytes,{version:'v2.0.550'})).then(result=>parentPort.postMessage({text:result.text.slice(0,1000000),pages:result.numpages})).catch(()=>parentPort.postMessage({error:'PDF inválido, protegido ou não legível.'}));
