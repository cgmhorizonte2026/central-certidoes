function userError(error){
 const text=String(error?.message||error||'Falha na consulta.');
 if(/Target page, context or browser has been closed|has been closed|browser.*closed/i.test(text))return 'A janela do órgão foi encerrada antes de concluir a operação. Inicie uma nova consulta.';
 if(/Timeout|intercepts pointer|outside of the viewport|Call log:/i.test(text))return 'O portal ainda está carregando ou abriu uma janela sobre o formulário. Aguarde ou use a janela interativa para continuar.';
 if(/net::ERR_/i.test(text))return 'Não foi possível acessar o portal do órgão. A janela permanece disponível para uma nova tentativa.';
 return text.replace(/\u001b\[[0-9;]*m/g,'').split('\n')[0].slice(0,500);
}
module.exports={userError};
