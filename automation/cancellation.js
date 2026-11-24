const {AsyncLocalStorage} = require('node:async_hooks');
const execution = new AsyncLocalStorage();
function checkCancelled() { const signal=execution.getStore(); if(signal?.aborted)throw signal.reason; }
function withCancellation(signal, work) { return execution.run(signal,work); }
function requestSignal(timeoutSignal) { const signal=execution.getStore();return signal?AbortSignal.any([signal,timeoutSignal]):timeoutSignal; }
module.exports={checkCancelled,withCancellation,requestSignal};
