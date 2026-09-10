const test=require('node:test');const assert=require('node:assert/strict');const {PortalSessions}=require('../automation/sessions');
test('late PDF parsing cannot resurrect a cancelled session',async()=>{
 let release;const manager=new PortalSessions({store:{put:()=>{}},onPdf:()=>new Promise(r=>{release=r;})});
 const job={id:'test',cnpj:'00000000000191',portal:{allowedHosts:['www.tst.jus.br']},status:'awaiting_user',files:[],seen:new Set()};
 const result=manager.receive(job,Buffer.from('%PDF-fixture'),'https://www.tst.jus.br/test.pdf','official_response');
 job.status='cancelled';release({id:'late'});await result;assert.equal(job.status,'cancelled');assert.deepEqual(job.files,[]);
});
test('finish without PDF keeps the portal open and reports missing document',async()=>{
 const manager=new PortalSessions({store:{put:()=>{}},onPdf:()=>{}});
 const job={id:'empty',status:'awaiting_user',context:{},files:[],captures:new Set()};manager.jobs.set(job.id,job);
 await assert.rejects(manager.finish(job.id),/Nenhum PDF/);assert.equal(job.status,'awaiting_user');assert.ok(job.context);
});
