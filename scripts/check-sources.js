const {discoverMunicipality}=require('../lib/discovery');
async function run(){
 for(const url of ['https://minhareceita.org/00000000000191','https://www.receitaws.com.br/v1/cnpj/00000000000191']){
  try{const r=await fetch(url,{signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'}});const text=await r.text();let data;try{const j=JSON.parse(text);data={cnpj:j.cnpj,name:j.razao_social||j.nome,uf:j.uf,municipality:j.municipio,ibge:j.codigo_municipio_ibge};}catch{data=text.slice(0,120);}console.log(JSON.stringify({url,status:r.status,data}));}catch(e){console.log(JSON.stringify({url,error:e.message}));}
 }
 try{console.log(JSON.stringify(await discoverMunicipality('2304401',{get:()=>null,put:()=>{}})));}catch(e){console.log(JSON.stringify({discoveryError:e.message}));}
}
run();
