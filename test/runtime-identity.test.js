const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { runtimeIdentity } = require('../lib/runtime-identity');
test('runtime identity separates different installations and detects edited code even at the same version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'central-identity-'));
  try {
    const a=path.join(root,'a'),b=path.join(root,'b');
    for(const dir of [a,b]){fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'server.js'),'original');fs.writeFileSync(path.join(dir,'package.json'),'{}');}
    const loaded=runtimeIdentity(a),other=runtimeIdentity(b);
    assert.equal(loaded.buildId,other.buildId);assert.notEqual(loaded.installationId,other.installationId);
    fs.writeFileSync(path.join(a,'server.js'),'updated');
    assert.notEqual(runtimeIdentity(a).buildId,loaded.buildId);
    assert.equal(runtimeIdentity(a).installationId,loaded.installationId);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
