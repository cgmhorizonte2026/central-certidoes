const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {MunicipalPortalResolver}=require('../lib/municipal-portal-resolver');

test('municipal portal discovery remains usable when its disk cache cannot be replaced',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'central-cache-'));
 try{
  const resolver=new MunicipalPortalResolver({cacheFile:root});
  const discovery={version:1,portals:{'2309706:CE':{status:'PORTAL_ENCONTRADO',provider:'speedgov'}}};
  assert.equal(resolver.write(discovery),false);
  assert.equal(resolver.read().portals['2309706:CE'].provider,'speedgov');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
