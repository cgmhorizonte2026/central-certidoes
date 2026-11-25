const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function runtimeIdentity(root = path.join(__dirname, '..')) {
  const hash = crypto.createHash('sha256');
  function scan(relative) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    if (fs.statSync(absolute).isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) scan(path.join(relative, name));
    } else if (/\.(js|json|html|css)$/.test(relative)) {
      hash.update(relative.split(path.sep).join('/')); hash.update('\0'); hash.update(fs.readFileSync(absolute)); hash.update('\0');
    }
  }
  for (const entry of ['server.js', 'package.json', 'package-lock.json', 'automation', 'config', 'lib', 'public']) scan(entry);
  const installationId = crypto.createHash('sha256').update(fs.realpathSync(root).toLowerCase()).digest('hex');
  return { appId: 'central-certidoes-horizonte', buildId: hash.digest('hex'), installationId };
}
module.exports = { runtimeIdentity };
if (require.main === module) console.log(JSON.stringify(runtimeIdentity()));
