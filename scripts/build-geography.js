const fs=require('node:fs');const path=require('node:path');
async function main(){
 const municipalities=await (await fetch('https://servicodados.ibge.gov.br/api/v1/localidades/municipios',{signal:AbortSignal.timeout(30000)})).json();
 if(!Array.isArray(municipalities)||municipalities.length<5000)throw new Error('Resposta IBGE incompleta.');
 const query='SELECT ?code ?website ?item WHERE { ?item wdt:P1585 ?code; wdt:P856 ?website. }';
 let result={};try{const r=await fetch('https://query.wikidata.org/sparql?format=json&query='+encodeURIComponent(query),{headers:{Accept:'application/sparql-results+json'},signal:AbortSignal.timeout(45000)});const text=await r.text();if(!r.ok||!text)throw new Error('HTTP '+r.status+'; sem dados utilizáveis');result=JSON.parse(text);}catch(e){console.log('Sites candidatos indisponíveis: '+e.message);}
 const sites=new Map();for(const row of result.results?.bindings||[]){try{const u=new URL(row.website.value);if(!u.hostname.endsWith('.gov.br'))continue;sites.set(row.code.value,{website:u.href,websiteSource:row.item.value});}catch{}}
 const data={fetchedAt:new Date().toISOString(),geographySource:'https://servicodados.ibge.gov.br/api/v1/localidades/municipios',websiteSource:'https://www.wikidata.org/wiki/Property:P1585',note:'Sites são candidatos de descoberta, não integrações de certidão homologadas.',municipalities:municipalities.map(m=>({code:String(m.id),name:m.nome,uf:m.microrregiao?.mesorregiao?.UF?.sigla||m['regiao-imediata']?.['regiao-intermediaria']?.UF?.sigla,...sites.get(String(m.id))}))};
 fs.writeFileSync(path.join(__dirname,'..','config','municipalities.json'),JSON.stringify(data));console.log(JSON.stringify({municipalities:data.municipalities.length,withWebsite:data.municipalities.filter(m=>m.website).length,examples:data.municipalities.filter(m=>['Fortaleza','Horizonte','Campinas'].includes(m.name))}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
