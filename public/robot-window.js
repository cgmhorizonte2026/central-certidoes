(()=>{
let dialog,id,timer,loading=false,acting=false,objectUrl;
function create(){
 if(dialog)return;
 dialog=document.createElement('dialog');dialog.id='robot-window';
 dialog.innerHTML=`<div class="dialog-heading"><h2>Janela interativa do órgão</h2><button type="button" id="robot-close" class="quiet">Fechar painel</button></div><p id="robot-status" role="status">Carregando a página real do robô…</p><p class="small">Clique diretamente na imagem para usar os botões ou selecionar um campo. Para preencher o campo selecionado, use a caixa de texto abaixo. Esta é a mesma sessão que captura o PDF.</p><div class="actions"><button type="button" id="robot-refresh" class="secondary">Atualizar tela</button><button type="button" data-robot-scroll="-600" class="secondary">Rolar acima</button><button type="button" data-robot-scroll="600" class="secondary">Rolar abaixo</button><button type="button" data-robot-key="Tab" class="secondary">Próximo campo</button><button type="button" data-robot-key="Enter" class="secondary">Enter</button><button type="button" data-robot-key="Backspace" class="secondary">Apagar caractere</button></div><form id="robot-text-form"><label for="robot-text">Texto para o campo selecionado na página do órgão</label><div class="actions"><input id="robot-text" maxlength="500" autocomplete="off" placeholder="Ex.: caracteres do CAPTCHA"><button type="submit">Enviar texto</button></div></form><p id="robot-action" role="status"></p><img id="robot-screen" alt="Página interativa do órgão emissor"><div id="robot-files" class="actions"></div>`;
 document.body.append(dialog);
 $('robot-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>clearInterval(timer));
 $('robot-refresh').onclick=()=>refresh();
 $('robot-text-form').onsubmit=e=>{e.preventDefault();const value=$('robot-text').value;if(value)send({action:'text',text:value}).then(ok=>{if(ok)$('robot-text').value='';});};
 dialog.addEventListener('click',e=>{const b=e.target.closest('button');if(b?.dataset.robotKey)send({action:'key',key:b.dataset.robotKey});if(b?.dataset.robotScroll)send({action:'scroll',delta:Number(b.dataset.robotScroll)});});
 $('robot-screen').onclick=e=>{const rect=e.currentTarget.getBoundingClientRect();send({action:'click',x:(e.clientX-rect.left)/rect.width,y:(e.clientY-rect.top)/rect.height});};
}
async function refresh(){
 if(loading||acting||!dialog?.open)return;loading=true;
 try{
   const job=await api('/api/jobs/'+id);$('robot-status').textContent=job.message;
   if(['finished','cancelled','error'].includes(job.status)){
     clearInterval(timer);$('robot-screen').hidden=true;
     $('robot-files').innerHTML=(job.verifiedCertificateId?[job.verifiedCertificateId]:(job.files||[])).map(file=>`<a target="_blank" rel="noopener noreferrer" href="/api/certificates/${encodeURIComponent(file)}/pdf?view=1">Abrir PDF recebido</a>`).join('');return;
   }
   const r=await fetch('/api/jobs/'+id+'/preview',{cache:'no-store'});if(!r.ok)throw Error('A página ainda não está disponível. Aguarde o carregamento do órgão.');
   const next=URL.createObjectURL(await r.blob());$('robot-screen').src=next;$('robot-screen').hidden=false;if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=next;
 }catch(e){$('robot-status').textContent=e.message;}finally{loading=false;}
}
async function send(command){
 if(acting)return false;acting=true;$('robot-action').textContent='Enviando comando à página do órgão…';
 try{await api('/api/jobs/'+id+'/interaction',{method:'POST',body:command});$('robot-action').textContent='Comando enviado. A página será atualizada.';return true;}
 catch(e){$('robot-action').textContent=e.message;return false;}
 finally{acting=false;await refresh();}
}
async function open(job){
 create();id=job.id;$('robot-files').innerHTML='';$('robot-action').textContent='';$('robot-screen').hidden=true;
 if(!dialog.open)dialog.showModal();await refresh();clearInterval(timer);timer=setInterval(refresh,2500);
}
const shownChallenges=new Set();
document.addEventListener('central-captcha',e=>{if(!shownChallenges.has(e.detail.id)){shownChallenges.add(e.detail.id);open(e.detail);}});
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b||!activeJob)return;
 if(['focus-job','preview-job','continue-job'].includes(b.id)){
   const job=activeJob;open(job);
   if(b.id==='continue-job')busy(b,async()=>{activeJob=await api('/api/jobs/'+job.id+'/continue',{method:'POST',body:{}});renderJob();await refresh();});
 }
});
})();
