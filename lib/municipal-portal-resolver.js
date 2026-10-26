const fs = require('fs');
const path = require('path');

const DAY = 86400000;
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const safeHttpUrl = value => { try { const u=new URL(value); return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password ? u : null; } catch { return null; } };
const anchors = (html, base) => [...String(html).matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)].flatMap(m=>{try{return [{url:new URL(m[2].replace(/&amp;/g,'&'),base).href,label:m[3].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()}]}catch{return[]}});
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
  constructor({cacheFile,fetchImpl=fetch,revalidateDays=30}={}) { this.cacheFile=cacheFile;this.fetch=fetchImpl;this.revalidateMs=revalidateDays*DAY;this.memory={version:1,portals:{}}; }
  read(){try{this.memory=JSON.parse(fs.readFileSync(this.cacheFile,'utf8'));}catch{}return this.memory;}
  write(data){this.memory=data;if(!this.cacheFile)return true;try{fs.mkdirSync(path.dirname(this.cacheFile),{recursive:true});const temp=this.cacheFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(data,null,2));fs.renameSync(temp,this.cacheFile);return true;}catch(error){console.warn(`[MUNICIPAL] cache write failed; keeping discovery in memory: ${error.code||error.message}`);return false;}}
  key(company){return `${company.municipio_codigo_ibge}:${String(company.uf||'').toUpperCase()}`;}
  async request(url,options={},parentSignal){
    if(parentSignal?.aborted)throw parentSignal.reason||new Error('Descoberta municipal cancelada.');
    const controller=new AbortController();let timedOut=false;
    const abortFromParent=()=>controller.abort(parentSignal.reason||new Error('Descoberta municipal cancelada.'));
    parentSignal?.addEventListener('abort',abortFromParent,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort(new Error(`Timeout HTTP após 15000 ms: ${url}`));},15000);
    try{return await this.fetch(url,{...options,signal:controller.signal});}
    catch(error){if(parentSignal?.aborted)throw parentSignal.reason||error;if(timedOut){error.code='HTTP_TIMEOUT';}throw error;}
    finally{clearTimeout(timer);parentSignal?.removeEventListener('abort',abortFromParent);}
  }
  async getText(url,{signal}={}){const r=await this.request(url,{redirect:'follow',headers:{'User-Agent':'CentralCertidoes/2.9 municipal discovery','Accept':'text/html,application/xhtml+xml'}},signal);if(!r.ok){const error=new Error(`HTTP ${r.status}: ${url}`);error.code='HTTP_STATUS';error.status=r.status;throw error;}return {url:r.url||url,html:(await r.text()).slice(0,2_000_000)};}
  async officialCandidates(company,{signal,onProgress}={}){
    const found=[];
    try{const q=`SELECT ?website WHERE { ?item wdt:P1585 "${company.municipio_codigo_ibge}"; wdt:P856 ?website. } LIMIT 5`;const r=await this.request(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`,{headers:{Accept:'application/sparql-results+json','User-Agent':'CentralCertidoes/2.9'}},signal);if(r.ok){const j=await r.json();for(const b of j.results?.bindings||[])found.push(b.website.value)}}catch(error){if(signal?.aborted)throw signal.reason||error;onProgress?.({stage:'source_unavailable',url:'https://query.wikidata.org/sparql',reason:error.message});}
    const slug=normalize(company.municipio).replace(/ /g,'');const uf=String(company.uf||'').toLowerCase();
    found.push(`https://${slug}.${uf}.gov.br/`,`https://www.${slug}.${uf}.gov.br/`);
    // Plataformas tributárias reutilizadas por vários municípios possuem
    // URLs previsíveis; entram apenas como candidatos e ainda precisam ser
    // validadas pelo conteúdo e pela correspondência municipal.
    found.push(`https://servicos2.speedgov.com.br/${slug}`);
    return [...new Set(found)].filter(u=>safeHttpUrl(u));
  }
  async resolve(company,{force=false,signal,onProgress}={}){
    if(!/^\d{7}$/.test(String(company.municipio_codigo_ibge||''))||!/^[A-Z]{2}$/.test(String(company.uf||'')))return {status:'MUNICIPIO_NAO_IDENTIFICADO'};
    const data=this.read(),key=this.key(company),cached=data.portals[key];
    if(!force&&cached?.status==='PORTAL_ENCONTRADO'&&Date.now()-Date.parse(cached.ultima_validacao)<this.revalidateMs)return {...cached,cache:true};
    const official=await this.officialCandidates(company,{signal,onProgress});
    const candidates=[],rejections=[];let reachablePages=0,attemptedPages=0;
    for(const home of official){
      if(signal?.aborted)throw signal.reason||new Error('Descoberta municipal cancelada.');
      onProgress?.({stage:'candidate_started',url:home});
      try{
        attemptedPages++;const root=await this.getText(home,{signal});reachablePages++;const rootText=normalize(root.html);
        // A known municipal provider can be the official service URL itself,
        // without reproducing the municipality name in the rendered HTML.
        // It is still accepted only as a provider candidate and only when the
        // page exposes clear certificate/service evidence.
        const rootProvider = detectProvider(root.url, root.html);
        if (rootProvider !== 'unsupported' && /certidao|cnd|debito|tribut/.test(rootText)) {
          const record={codigo_ibge:company.municipio_codigo_ibge,municipio:company.municipio,uf:company.uf,prefeitura_url:official[0],certidao_url:root.url,provider:rootProvider,adapter:rootProvider==='unsupported'?'generic':'provider',status:rootProvider==='unsupported'?'PROVIDER_NAO_SUPORTADO':'PORTAL_ENCONTRADO',ultima_validacao:new Date().toISOString(),fonte:home,confianca:'provedor_reconhecido',diagnostico:{candidatos:[],rejeicoes:[]}};
          if(record.status==='PORTAL_ENCONTRADO'){data.portals[key]=record;this.write(data);return record;}
        }
        if(!rootText.includes(normalize(company.municipio))&&!/prefeitura|municipal|governo/i.test(rootText))continue;
        const cartaPages=Array.from({length:30},(_,i)=>({url:new URL(`/cartaservicos.php?id=${i+1}`,root.url).href,html:null}));
        const queue=[root,{url:new URL('/servicos.php',root.url).href,html:null},{url:new URL('/cartaservicos.php',root.url).href,html:null},...cartaPages],visited=new Set();
        while(queue.length&&visited.size<40){
          if(signal?.aborted)throw signal.reason||new Error('Descoberta municipal cancelada.');
          const current=queue.shift();if(visited.has(current.url))continue;visited.add(current.url);
          let page=current;if(current.html===null){attemptedPages++;try{page=await this.getText(current.url,{signal});reachablePages++;}catch(error){if(signal?.aborted)throw signal.reason||error;rejections.push({url:current.url,reason:error.message});onProgress?.({stage:'page_failed',url:current.url,reason:error.message});continue;}}
          onProgress?.({stage:'page_analyzed',url:page.url,visited:visited.size});
          const links=anchors(page.html,page.url).map(a=>({...a,score:serviceScore(a.label)})).filter(a=>a.score).sort((a,b)=>b.score-a.score);
          candidates.push(...links.map(({url,label,score})=>({url,label,score,source:page.url})));
          for(const link of links){
            const target=safeHttpUrl(link.url);if(!target)continue;
            if(link.score>=5 && /speedgov|servicostrimap|trimapservicos/i.test(target.hostname)){
              let service;attemptedPages++;try{service=await this.getText(target.href,{signal});reachablePages++;}catch(error){if(signal?.aborted)throw signal.reason||error;rejections.push({url:target.href,reason:error.message});service={url:target.href,html:''};}
              if(/certid[aã]o|emitir cnd|débitos municipais|tributos municipais/i.test(service.html)){const provider=detectProvider(service.url,service.html);const record={codigo_ibge:company.municipio_codigo_ibge,municipio:company.municipio,uf:company.uf,prefeitura_url:root.url,certidao_url:service.url,provider,adapter:'provider',status:'PORTAL_ENCONTRADO',ultima_validacao:new Date().toISOString(),fonte:page.url,confianca:'link_oficial',diagnostico:{candidatos:candidates,rejeicoes:rejections}};data.portals[key]=record;this.write(data);return record;}
            }
            if(link.score>=10){
              let service;attemptedPages++;try{service=await this.getText(target.href,{signal});reachablePages++;}catch(error){if(signal?.aborted)throw signal.reason||error;rejections.push({url:target.href,reason:error.message});service={url:target.href,html:''};}const provider=detectProvider(service.url,service.html);
              const formEvidence=/cpf.?\/?cnpj|cnpj|emitir|certidao|cnd/i.test(service.html);
              if(!formEvidence){rejections.push({url:service.url,reason:'serviço sem evidência de formulário/CND'});continue;}
              const record={codigo_ibge:company.municipio_codigo_ibge,municipio:company.municipio,uf:company.uf,prefeitura_url:root.url,certidao_url:service.url,provider,adapter:provider==='unsupported'?'generic':'provider',status:provider==='unsupported'?'PROVIDER_NAO_SUPORTADO':'PORTAL_ENCONTRADO',ultima_validacao:new Date().toISOString(),fonte:page.url,confianca:'link_oficial',diagnostico:{candidatos:candidates.slice(-50),rejeicoes:rejections}};
              data.portals[key]=record;this.write(data);return record;
            }
            if(!visited.has(target.href)&&queue.length<24)queue.push({url:target.href,html:null});
          }
        }
      }catch(error){if(signal?.aborted)throw signal.reason||error;rejections.push({url:home,reason:error.message});onProgress?.({stage:'candidate_failed',url:home,reason:error.message});}
    }
    const result={codigo_ibge:company.municipio_codigo_ibge,municipio:company.municipio,uf:company.uf,status:reachablePages?'PORTAL_NAO_ENCONTRADO':'PORTAL_INACESSIVEL',ultima_validacao:new Date().toISOString(),confianca:'nenhuma',diagnostico:{tentativas:attemptedPages,paginasAcessiveis:reachablePages,termos:['Certidão Negativa','CND','Certidão de Débitos','Portal do Contribuinte'],candidatos:candidates.slice(-50),rejeicoes:rejections.length?rejections:['nenhum site candidato acessível']}};data.portals[key]=result;this.write(data);onProgress?.({stage:'discovery_finished',status:result.status,attemptedPages,reachablePages});return result;
  }
}
module.exports={MunicipalPortalResolver,detectProvider,normalize,serviceScore};
