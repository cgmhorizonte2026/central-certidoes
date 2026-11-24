// Certificate numbers and verification codes are independent fields.
function certificateIdentifiers(text){
 const raw=String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase(),t=raw.replace(/\s+/g,' ');
 const numbers=[],codes=[];
 const collect=(re,target)=>{for(const m of t.matchAll(re)){const v=m[1].replace(/[.,;:]$/,'');if(/\d/.test(v)&&!/^\d{2}\/\d{2}\/\d{4}$/.test(v))target.push(v);}};
 collect(/(?:CERTIDAO(?:\s+(?:NEGATIVA|POSITIVA))?\s*(?:N[º°O]\.?(?:\s*DA CERTIDAO)?|NUMERO)|(?:NUMERO|N[º°O]\.?)\s+DA CERTIDAO|CERTIFICA(?:CAO|DO)\s+NUMERO)\s*[:.\-]*\s*([A-Z0-9][A-Z0-9.\/-]{3,79})/g,numbers);
 collect(/CERTIDAO NEGATIVA DE DEBITOS ESTADUAIS\s+(\d{8,25})\b/g,numbers);
 const municipal=raw.match(/CERTIDAO NEGATIVA DE DEBITOS MUNICIPAIS\s*\n\s*N[º°]\s*\n\s*(\d{6,25})\b/);if(municipal)numbers.push(municipal[1]);
 collect(/(?:CHAVE(?: DE (?:CONSULTA|VALIDACAO|AUTENTICIDADE|VERIFICACAO))?|CODIGO DE (?:CONTROLE|VERIFICACAO|AUTENTICIDADE|VALIDACAO)|COD\.\s*VALIDACAO)(?: DA CERTIDAO)?\s*[:.\-]*\s*([A-Z0-9][A-Z0-9.\/-]{4,79})/g,codes);
 const layout=raw.match(/COD\. VALIDACAO:\s*\n\s*VALIDA ATE:\s*\n\s*([A-Z0-9]{8,40})\b/);if(layout)codes.push(layout[1]);
 const unique=values=>[...new Set(values)],n=unique(numbers),c=unique(codes);
 return {numero:n.length===1?n[0]:'',chaveConsulta:c.length===1?c[0]:'',identifierWarning:n.length>1||c.length>1?'Identificadores divergentes no PDF; conferir no documento.':''};
}
module.exports={certificateIdentifiers};
