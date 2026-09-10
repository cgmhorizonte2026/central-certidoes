const crypto = require('node:crypto');
function normalizeCnpj(value) { return String(value || '').toUpperCase().replace(/[.\/\-\s]/g, ''); }
function validCnpj(value) {
  const c = normalizeCnpj(value);
  if (!/^[A-Z0-9]{12}\d{2}$/.test(c) || /^(.)\1{13}$/.test(c)) return false;
  const digit = s => { let w = s.length - 7; const sum = [...s].reduce((a, x) => { const n = a + (x.charCodeAt(0) - 48) * w; w = w === 2 ? 9 : w - 1; return n; }, 0); return sum % 11 < 2 ? '0' : String(11 - sum % 11); };
  return digit(c.slice(0, 12)) === c[12] && digit(c.slice(0, 13)) === c[13];
}
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const plain = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function isoDate(s) {
  const m = String(s || '').match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
  if (!m) return null;
  const v = `${m[3]}-${m[2]}-${m[1]}`; const d = new Date(v + 'T12:00:00Z');
  return Number.isNaN(+d) || d.toISOString().slice(0, 10) !== v ? null : v;
}
function parseCertificate(text, expectedCnpj, kind) {
  const t = plain(text).replace(/\s+/g, ' ');
  const ids = [...String(text).toUpperCase().matchAll(/\b[A-Z0-9]{2}\.?[A-Z0-9]{3}\.?[A-Z0-9]{3}\/?[A-Z0-9]{4}-?\d{2}\b/g)].map(m => normalizeCnpj(m[0])).filter(validCnpj);
  // Match explicit certificate wording; occurrence of "regular" inside "irregular" never suffices.
  const positiveEffects = /certidao positiva.{0,45}(?:efeitos? de negativa|efeito de negativa)/.test(t);
  const positive = /certidao positiva/.test(t);
  const negative = /certidao negativa/.test(t);
  const irregular = /\birregular\b|nao (?:se )?encontra(?:-se)? regular|nao esta regular/.test(t);
  const fgtsRegular = kind === 'fgts' && /certificado de regularidade/.test(t) && /encontra-se em situacao regular|encontra se em situacao regular/.test(t);
  const classification = irregular ? 'irregular' : positiveEffects && !negative ? 'positiva_efeitos_negativa' : positive && !negative ? 'positiva' : negative && !positive ? 'negativa' : fgtsRegular ? 'regular_fgts' : 'indeterminada';
  const end = t.match(/(?:valid[ao](?:\s+ate)?|validade(?:\s+ate)?|vencimento)\s*[:\-]?\s*(\d{2}[\/-]\d{2}[\/-]\d{4})(?:\s*(?:a|ate|-)\s*(\d{2}[\/-]\d{2}[\/-]\d{4}))?/);
  const start = t.match(/(?:emitida|expedida|emissao|expedicao)(?:\s+(?:via internet em|em|no dia))?\s*[:\-]?\s*(\d{2}[\/-]\d{2}[\/-]\d{4})/);
  const number = t.match(/(?:certidao\s*(?:n[º°o.]|numero)|numero (?:da certidao|do certificado)|certificacao numero|codigo de (?:controle|autenticidade))\s*[:.º°\-]*\s*([a-z0-9][a-z0-9.\/-]{5,70})/i);
  const controlCodes=[...t.matchAll(/codigo de (?:controle|autenticidade|verificacao)(?: da certidao)?\s*[:.\-]*\s*([a-z0-9][a-z0-9.\/-]{5,70})/g)].map(m=>m[1].toUpperCase());
  const controlCode=[...new Set(controlCodes)].length===1?controlCodes[0]:null;
  const timed=t.match(/emitida\s+(?:as|às)\s+(\d{2}:\d{2}:\d{2})(?:\s+do dia|\s+em)?\s+(\d{2}\/\d{2}\/\d{4})/);
  const expiresAt = end ? isoDate(end[2] || end[1]) : null;
  const kindPatterns={federal:/receita federal|fazenda nacional|\bpgfn\b/,fgts:/\bfgts\b/,trabalhista:/debitos trabalhistas|justica do trabalho|tribunal superior do trabalho/,estadual:/fazenda|tribut.{0,30}estadua|debitos estadua/,municipal:/prefeitura|tribut.{0,30}municipa|debitos municipa/};
  const kindMatches=kindPatterns[kind]?.test(t)||false;
  const warnings = [];
  if (!ids.includes(expectedCnpj)) warnings.push('CNPJ da empresa não localizado no texto do PDF.');
  if (!expiresAt) warnings.push('Validade não identificada de forma segura.');
  if (classification === 'indeterminada') warnings.push('Situação não identificada de forma segura.');
  if (!kindMatches) warnings.push('O texto não identifica com segurança o tipo de certidão selecionado.');
  return { classification,kindMatches, cnpjs: [...new Set(ids)], cnpjMatches: ids.includes(expectedCnpj), controlCode, issuedTime:timed?.[1]||null, number: number?.[1]?.toUpperCase() || (kind==='estadual'?t.match(/certidao negativa de debitos estaduais\s+(\d{8,20})/)?.[1]:null) || null, issuedAt: start ? isoDate(start[1]) : timed ? isoDate(timed[2]) : null, expiresAt, warnings };
}
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function validity(parsed, date = today()) {
  const end = parsed?.expiresAt;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end || '') || isoDate(end.split('-').reverse().join('/')) !== end)
    return { status: 'unknown', remainingDays: null, label: 'Validade não identificada — conferir no documento' };
  if (parsed.issuedAt && (parsed.issuedAt > date || parsed.issuedAt > end))
    return { status: 'inconsistent', remainingDays: null, label: 'Datas incoerentes — conferir no documento' };
  const remainingDays = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000);
  return { status: remainingDays < 0 ? 'expired' : remainingDays < 5 ? 'expiring' : 'current', remainingDays,
    label: remainingDays < 0 ? `Vencida há ${-remainingDays} dia(s)` : remainingDays === 0 ? 'Vence hoje — solicitar renovação' : remainingDays < 5 ? `Vence em ${remainingDays} dia(s) — solicitar renovação` : `${remainingDays} dias até o vencimento` };
}
function assessment(cert, date = today()) {
  if (!cert) return { code: 'ausente', label: 'Documento ausente', ready: false };
  if (cert.integrity === false) return { code: 'integridade_falhou', label: 'Arquivo alterado ou ausente', ready: false };
  const p = cert.parsed;
  if(cert.kind==='fgts'&&cert.provenance?.method==='official_html_print')return {code:'documento_preliminar',label:'Obter versão final de impressão',ready:false};
  if (!p.cnpjMatches) return { code: 'cnpj_divergente', label: 'CNPJ não confirmado', ready: false };
  if (p.kindMatches === false) return { code:'tipo_nao_confirmado',label:'Tipo de certidão não confirmado',ready:false };
  if (!p.expiresAt) return { code: 'validade_desconhecida', label: 'Validade não identificada', ready: false };
  if (p.expiresAt < date) return { code: 'vencida', label: 'Vencida', ready: false };
  if (p.issuedAt && p.issuedAt > date) return { code: 'data_incoerente', label: 'Emissão futura', ready: false };
  if (!['negativa', 'positiva_efeitos_negativa', 'regular_fgts'].includes(p.classification)) return { code: 'situacao_pendente', label: 'Situação exige análise', ready: false };
  if (cert.officialCapture && cert.integrity === true) return {code:'capturada_no_orgao',label:'Obtida diretamente do órgão · PDF íntegro',ready:true};
  // An uploaded PDF or a human assertion must never become automatic official validation.
  if (!['confirmed_exact_official_pdf','confirmed_official_record'].includes(cert.validation?.status)) return { code: 'autenticidade_pendente', label: 'Autenticidade pendente', ready: false };
  const checkedDay = cert.validation.checkedAt && new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(cert.validation.checkedAt));
  if (checkedDay !== date) return { code: 'revalidar', label: 'Atualizar conferência oficial', ready: false };
  return { code: 'conferida', label: cert.validation.status==='confirmed_official_record'?'Autenticidade consultada no TST':'PDF idêntico ao obtido no portal oficial', ready: true };
}
module.exports = { normalizeCnpj, validCnpj, sha256, plain, isoDate, parseCertificate, assessment, today, validity };
