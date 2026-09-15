function accessBlockMessage(text, portalKey) {
 if (portalKey!=='fgts'||!/comportamento malicioso no acesso|para prote[cç][aã]o do site, n[aã]o podemos processar sua requisi[cç][aã]o/i.test(text))return null;
 return 'A Caixa bloqueou esta sessão de acesso automatizado. A consulta foi suspensa e nenhum PDF foi recebido. Esse aviso não informa a situação do FGTS da empresa. Aguarde antes de iniciar uma nova consulta; se o bloqueio persistir, utilize o atendimento oficial da Caixa ou anexe uma certidão obtida pelo responsável.';
}
module.exports={accessBlockMessage};
