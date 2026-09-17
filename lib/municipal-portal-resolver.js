const fs = require('fs');
const path = require('path');

const DAY = 86400000;
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const safeHttpUrl = value => { try { const u=new URL(value); return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password ? u : null; } catch { return null; } };
const anchors = (html, base) => [...String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].flatMap(m=>{try{return [{url:new URL(m[1].replace(/&amp;/g,'&'),base).href,label:m[2].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()}]}catch{return[]}});
const serviceScore = label => { const t=normalize(label); if(/nascimento|obito|casamento|imovel|iptu/.test(t))return 0; if(/certidao negativa|cnd|certidao.*debito/.test(t))return 10; if(/portal.*contribuinte|portal.*tribut|servicos.*sefin|secretaria.*financas/.test(t))return 5; if(/servicos/.test(t))return 2; return 0; };

function detectProvider(url, html='') {
  const host=new URL(url).hostname, body=normalize(html);
  if (/speedgov/.test(host)) return 'speedgov';
  if (/servicostrimap|trimapservicos/.test(host)) return 'trimap';
  if (/grpfordam\.sefin\.fortaleza/.test(host)) return 'grpfor';
  if (/fisco\./.test(host) && /tipo certidao|cpf cnpj|emitir certidao/.test(body)) return 'fisco-web';
  if (/cpf cnpj|cnpj/.test(body) && /certidao|cnd/.test(body)) return 'generic-cnpj';
  return 'unsupported';
}

class MunicipalPortalResolver {
  constructor({cacheFile,fetchImpl=fetch,revalidateDays=30}={}) { this.cacheFile=cacheFile;this.fetch=fetchImpl;this.revalidateMs=revalidateDays*DAY; }
  read(){try{return JSON.parse(fs.readFileSync(this.cacheFile,'utf8'))}catch{return {version:1,portals:{}}}}
  write(data){if(!this.cacheFile)return;fs.mkdirSync(path.dirname(this.cacheFile),{recursive:true});fs.writeFileSync(this.cacheFile,JSON.stringify(data,null,2));}
  key(company){return `${company.municipio_codigo_ibge}:${String(company.uf||'').toUpperCase()}`;}
  async getText(url){const r=await this.fetch(url,{redirect:'follow',headers:{'User-Agent':'CentralCertidoes/2.9 municipal discovery','Accept':'text/html,application/xhtml+xml'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return {url:r.url||url,html:(await r.text()).slice(0,2_000_000)};}
  async officialCandidates(company){
    const found=[];
    try{const q=`SELECT ?website WHERE { ?item wdt:P1585 "${company.municipio_codigo_ibge}"; wdt:P856 ?website. } LIMIT 5`;const r=await this.fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`,{headers:{Accept:'application/sparql-results+json','User-Agent':'CentralCertidoes/2.9'},signal:AbortSignal.timeout(15000)});if(r.ok){const j=await r.json();for(const b of j.results?.bindings||[])found.push(b.website.value)}}catch{}
    const slug=normalize(company.municipio).replace(/ /g,'');const uf=String(company.uf||'').toLowerCase();
    found.push(`https://${slug}.${uf}.gov.br/`,`https://www.${slug}.${uf}.gov.br/`);
    return [...new Set(found)].filter(u=>safeHttpUrl(u)?.hostname.endsWith('.gov.br'));
  }
  async resolve(company,{force=false}={}){
    if(!/^\d{7}$/.test(String(company.municipio_codigo_ibge||''))||!/^[A-Z]{2}$/.test(String(company.uf||'')))return {status:'MUNICIPIO_NAO_IDENTIFICADO'};
    const data=this.read(),key=this.key(company),cached=data.portals[key];
    if(!force&&cached?.status==='PORTAL_ENCONTRADO'&&Date.now()-Date.parse(cached.ultima_validacao)<this.revalidateMs)return {...cached,cache:true};
    const official=await this.officialCandidates(company);
    for(const home of official){
      try{
        const root=await this.getText(home),rootText=normalize(root.html);
        if(!rootText.includes(normalize(company.municipio))&&!/prefeitura|municipal|governo/i.test(rootText))continue;
        const cartaPages=Array.from({length:30},(_,i)=>({url:new URL(`/cartaservicos.php?id=${i+1}`,root.url).href,html:null}));
        const queue=[root,{url:new URL('/servicos.php',root.url).href,html:null},{url:new URL('/cartaservicos.php',root.url).href,html:null},...cartaPages],visited=new Set(),candidates=[],rejections=[];
        while(queue.length&&visited.size<40){
          const current=queue.shift();if(visited.has(current.url))continue;visited.add(current.url);
          const page=current.html===null?await this.getText(current.url):current;
          const links=anchors(page.html,page.url).map(a=>({...a,score:serviceScore(a.label)})).filter(a=>a.score).sort((a,b)=>b.score-a.score);
          candidates.push(...links.map(({url,label,score})=>({url,label,score,source:page.url})));
          for(const link of links){
            const target=safeHttpUrl(link.url);if(!target)continue;
            if(link.score>=10){
              const service=await this.getText(target.href).catch(()=>({url:target.href,html:''}));const provider=detectProvider(service.url,service.html);
              const formEvidence=/cpf.?\/?cnpj|cnpj|emitir|certidao|cnd/i.test(service.html);
              if(!formEvidence){rejections.push({url:service.url,reason:'serviço sem evidência de formulário/CND'});continue;}
              const record={codigo_ibge:company.municipio_codigo_ibge,municipio:company.municipio,uf:company.uf,prefeitura_url:root.url,certidao_url:service.url,provider,adapter:provider==='unsupported'?'generic':'provider',status:provider==='unsupported'?'PROVIDER_NAO_SUPORTADO':'PORTAL_ENCONTRADO',ultima_validacao:new Date().toISOString(),fonte:page.url,confianca:'link_oficial',diagnostico:{candidatos:candidates.slice(-50),rejeicoes:rejections}};
              data.portals[key]=record;this.write(data);return record;
            }
            if(!visited.has(target.href)&&queue.length<24)queue.push({url:target.href,html:null});
          }
        }
      }catch{}
    }
    const result={codigo_ibge:company.municipio_codigo_ibge,municipio:company.municipio,uf:company.uf,status:'PORTAL_NAO_VALIDADO',ultima_validacao:new Date().toISOString(),confianca:'nenhuma',diagnostico:{termos:['Certidão Negativa','CND','Certidão de Débitos','Portal do Contribuinte'],candidatos:[],rejeicoes:['nenhum serviço oficial validado']}};data.portals[key]=result;this.write(data);return result;
  }
}
module.exports={MunicipalPortalResolver,detectProvider,normalize,serviceScore};
