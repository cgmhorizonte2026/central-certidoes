(function(root){
 function review(record,today){
  const raw=record?.dataConsulta||record?.dataEmissao||'';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return {due:'',label:'Data da consulta não identificada',className:'empty'};
  const start=new Date(raw+'T12:00:00Z');if(!Number.isFinite(+start)||start.toISOString().slice(0,10)!==raw)return {due:'',label:'Data da consulta não identificada',className:'empty'};
  start.setUTCDate(start.getUTCDate()+30);const due=start.toISOString().slice(0,10);
  today=today||new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const days=Math.round((Date.parse(due+'T12:00:00Z')-Date.parse(today+'T12:00:00Z'))/86400000);
  return {due,days,label:days<0?'Reconsulta atrasada':days===0?'Reconsultar hoje':'Reconsultar em '+days+' dia'+(days===1?'':'s'),className:days<=0?'bad':days<=5?'warn':'ok'};
 }
 if(typeof module!=='undefined')module.exports={review};else root.simplesReview=review;
})(typeof window!=='undefined'?window:globalThis);
