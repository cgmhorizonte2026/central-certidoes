const crypto=require('node:crypto');
const pageRecorders=new WeakMap();
function recordPageCapture(page,bytes,url,method){for(const record of pageRecorders.get(page)||[])record(bytes,String(url||'').replace(/^blob:/,''),method);}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function officialUrl(value,portal){try{const u=new URL(value);const hosts=new Set([new URL(portal.url).hostname,...(portal.allowedHosts||[])]);if(portal.key==='federal'){hosts.add('solucoes.receita.fazenda.gov.br');hosts.add('servicos.receitafederal.gov.br');}return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&hosts.has(u.hostname);}catch{return false;}}
function observeCapture(page,portal){
 const records=new Map(),pending=new Set(),listeners=[];
 const listen=(p,event,fn)=>{p.on(event,fn);listeners.push(()=>p.off(event,fn));};
 const track=fn=>{const p=Promise.resolve().then(fn).catch(()=>{});pending.add(p);p.finally(()=>pending.delete(p));};
 const record=(bytes,url,method)=>{if(bytes.length<=25*1024*1024&&bytes.subarray(0,5).toString()==='%PDF-'&&officialUrl(url,portal))records.set(hash(bytes),{source:'controlled_browser',officialPortal:true,sourceUrl:url,captureMethod:method,capturedAt:new Date().toISOString()});};
 const attach=p=>{
 const recorders=pageRecorders.get(p)||new Set();recorders.add(record);pageRecorders.set(p,recorders);listeners.push(()=>{recorders.delete(record);if(!recorders.size)pageRecorders.delete(p);});
 listen(p,'popup',attach);
 listen(p,'response',r=>{const type=r.headers()['content-type']||'';if(r.status()===200&&officialUrl(r.url(),portal)&&/pdf|octet-stream|json/i.test(type)&&Number(r.headers()['content-length']||0)<=25*1024*1024)track(async()=>{const body=await r.body();const bytes=/json/i.test(type)?require('./federal-support').decodePdfPayload(JSON.parse(body.toString())):body;if(bytes)record(bytes,r.url(),'official_response');});});
 listen(p,'download',d=>track(async()=>{const stream=await d.createReadStream();if(!stream)return;let size=0;const chunks=[];for await(const chunk of stream){size+=chunk.length;if(size>25*1024*1024){stream.destroy();return;}chunks.push(chunk);}const url=d.url().startsWith('blob:')?d.url().slice(5):d.url();record(Buffer.concat(chunks),url,'browser_download');}));
 };attach(page);
 return {async provenance(bytes){await Promise.race([Promise.allSettled([...pending]),new Promise(r=>{const t=setTimeout(r,3000);t.unref?.();})]);return records.get(hash(bytes))||{source:'controlled_browser',officialPortal:false,captureMethod:'session_capture',capturedAt:new Date().toISOString()};},dispose(){listeners.forEach(fn=>fn());}};
}
module.exports={hash,officialUrl,observeCapture,recordPageCapture};
