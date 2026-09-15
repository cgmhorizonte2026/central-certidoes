const {trustedUrl}=require('../config/registry');
const sessions=new WeakMap();
const visible=locator=>locator.isVisible().catch(()=>false);
function recaptchaFrame(url){try{const u=new URL(url);return u.protocol==='https:'&&['google.com','www.google.com','recaptcha.net','www.recaptcha.net'].includes(u.hostname)&&/^\/recaptcha\/(api2|enterprise)\/(anchor|bframe)$/.test(u.pathname);}catch{return false;}}
async function resolveCaptcha(job,log=()=>{},now=Date.now()){
 let state=sessions.get(job);if(!state){state={started:now,anchor:false,attempts:0,lastAttempt:0,busy:false};sessions.set(job,state);}
 const manual=message=>({status:'captcha_required',message:`${message} Clique em Abrir janela interativa para concluir. O robô retomará após a resposta.`});
 if(state.busy)return {status:'captcha_solving',message:'Buster está tentando resolver o desafio de áudio.'};
 if(!job.busterAvailable)return manual(job.browserNote||'Buster não está disponível nesta sessão.');
 state.busy=true;
 try{
   const frames=[];
   for(const page of job.context.pages())if(trustedUrl(page.url(),job.portal))for(const frame of page.frames())if(recaptchaFrame(frame.url()))frames.push(frame);
   if(!frames.length)return manual('O desafio deste portal não é compatível com o Buster (reCAPTCHA com áudio).');
   if(now-state.started>90000)return manual('A tentativa gratuita de áudio atingiu o limite de 90 segundos.');
   for(const frame of frames){
     const denied=frame.locator('.rc-doscaptcha-body');
     if(await visible(denied))return manual('O provedor bloqueou o acesso ao desafio de áudio.');
     const checkbox=frame.locator('#recaptcha-anchor');
     if(await visible(checkbox)&&!state.anchor){
       state.anchor=true;
       if(await checkbox.getAttribute('aria-checked')!=='true'){
         log('buster_inicio','Abrindo reCAPTCHA para tentativa gratuita por áudio.');await checkbox.click({timeout:3000});
         return {status:'captcha_solving',message:'Robô: abrindo o desafio reCAPTCHA para o Buster.'};
       }
     }
     // Buster 3.4 uses a closed shadow root in this holder. A native click reaches
     // its own solver button; never inject a fabricated response token.
     const holder=frame.locator('.help-button-holder');
     const original=frame.locator('#recaptcha-help-button');
     if(await visible(holder)&&!await original.count()){
       if(state.attempts&&now-state.lastAttempt<30000)return {status:'captcha_solving',message:'Buster acionado. Aguardando a conclusão do desafio de áudio.'};
       if(state.attempts>=2)return manual('Buster não concluiu o desafio após duas tentativas.');
       state.attempts++;state.lastAttempt=now;
       log('buster_audio',`Tentativa gratuita ${state.attempts}/2 pelo botão da extensão.`);
       await holder.click({timeout:3000});
       return {status:'captcha_solving',message:`Buster: tentativa ${state.attempts}/2 por reconhecimento de áudio.`};
     }
   }
   return {status:'captcha_solving',message:'Aguardando o Buster disponibilizar o botão de resolução por áudio.'};
 }catch(e){log('buster_falha',e.message.split('\n')[0]);return manual('A tentativa com Buster falhou.');}
 finally{state.busy=false;}
}
module.exports={resolveCaptcha,recaptchaFrame};
