const MAX_PDF=15*1024*1024;
function safeUrl(value){try{const u=new URL(value);return u.origin+u.pathname.replace(/(?=[A-Z0-9]*[0-9])[A-Z0-9]{11,}/gi,'[id]')+(u.hash.startsWith('#/home')?u.hash:'');}catch{return '[URL omitida]';}}
function safeLog(value,identifier=''){
 let text=String(value||'');if(identifier)text=text.split(identifier).join('[identificador]');
 return text.replace(/https?:\/\/[^\s]+/g,s=>safeUrl(s)).replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g,'[CNPJ]').replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,'[CPF]').replace(/\b\d{11,14}\b/g,'[identificador]').replace(/\b[A-Za-z0-9_-]{40,}\b/g,'[redigido]');
}
function federalSecurityError(text){
 if(/\b(?:105|106)\s*-\s*\d{2}\/\d{2}\/\d{4}/.test(text))return {status:'captcha_required',message:'A verificação hCaptcha da Receita não foi concluída. A emissão/consulta ainda não chegou à etapa fiscal. Use a janela do órgão para concluir a verificação ou tentar manualmente; a sessão permanece aberta.'};
 if(/access denied|acesso negado|verify you are human|verifique que voce|cloudflare|bloqueio de seguran[cç]a/i.test(text))return {status:'captcha_required',message:'O portal exige verificação humana de acesso. Conclua na janela do órgão. O robô não contorna esse controle.'};
 return null;
}
function decodePdfPayload(value){
 let nodes=0;function walk(v,depth){if(depth>6||++nodes>150)return null;
  if(typeof v==='string'){
   const raw=v.replace(/^data:application\/pdf(?:;[^,]*)?;base64,/i,'').replace(/\s/g,'');
   if(raw.length>MAX_PDF*4/3+8||!raw.startsWith('JVBERi')||!/^[A-Za-z0-9+/]*={0,2}$/.test(raw))return null;
   const bytes=Buffer.from(raw,'base64');return bytes.length<=MAX_PDF&&bytes.subarray(0,5).toString()==='%PDF-'?bytes:null;
  }
  if(v&&typeof v==='object')for(const child of Object.values(v)){const found=walk(child,depth+1);if(found)return found;}
  return null;
 }return walk(value,0);
}
module.exports={safeUrl,safeLog,federalSecurityError,decodePdfPayload};
