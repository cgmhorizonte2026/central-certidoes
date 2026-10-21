const fs = require('fs');
const path = require('path');
const os = require('os');

function prepareArchiveStorage(primaryRoot, fallbackRoots = []) {
  const roots = [primaryRoot, ...fallbackRoots].filter(Boolean);
  let lastError;
  for (const root of roots) {
    const certs = path.join(root, 'certidoes');
    const index = path.join(root, 'archive');
    try {
      fs.mkdirSync(certs, { recursive: true });
      fs.mkdirSync(index, { recursive: true });
      const probe = path.join(index, `.write-check-${process.pid}-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return { root, certs, index };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Não foi possível preparar uma pasta gravável para as certidões: ${lastError?.message || 'erro desconhecido'}`);
}

function defaultArchiveRoots(primaryRoot) {
  return [
    path.join(process.cwd(), 'data', 'storage'),
    path.join(os.tmpdir(), 'CentralCertidoes')
  ].filter(root => path.resolve(root) !== path.resolve(primaryRoot));
}

function ensureCompanyArchiveDirectory(primaryRoot, fallbackRoots, cnpj, date) {
  let lastError;
  for (const root of [primaryRoot, ...fallbackRoots].filter(Boolean)) {
    const certs = path.join(root, 'certidoes');
    const index = path.join(root, 'archive');
    const destination = path.join(certs, String(cnpj), String(date));
    try {
      fs.mkdirSync(destination, { recursive: true });
      fs.mkdirSync(index, { recursive: true });
      return { root, certs, index, destination };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Não foi possível criar a pasta da certidão: ${lastError?.message || 'erro desconhecido'}`);
}

module.exports = { prepareArchiveStorage, defaultArchiveRoots, ensureCompanyArchiveDirectory };
