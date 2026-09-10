# Fontes e cobertura - Central de Certidões V3

Pesquisa e implementação: 09/09/2026.

## Cadastro e jurisdição

- Base de 5.571 municípios e suas UFs: https://servicodados.ibge.gov.br/api/v1/localidades/municipios
- Descrição do código IBGE: https://www.ibge.gov.br/explica/codigos-dos-municipios.php
- BrasilAPI: https://brasilapi.com.br/
- Minha Receita, alternativa cadastral: https://docs.minhareceita.org/como-usar/
- ReceitaWS, alternativa de cache público com limite de 3 consultas/minuto: https://www.receitaws.com.br/api
- Descoberta de sites por código IBGE: https://www.wikidata.org/wiki/Property:P1585
- CNPJ alfanumérico: https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/documentos-tecnicos/cnpj

As fontes cadastrais intermediárias não certificam regularidade e podem estar defasadas. O sistema conserva fonte e instante de obtenção, confronta município/UF com IBGE e interrompe o fluxo diante de divergência.

## Certidões nacionais

- Federal RFB/PGFN: https://www.gov.br/pt-br/servicos/emitir-certidao-de-regularidade-fiscal
- TST, procedimento oficial com CAPTCHA: https://www.tst.jus.br/web/acesso-a-informacao/carta-de-servicos-a-cidadania/servicos-processuais/cndt
- CRF/FGTS: https://www.fgts.gov.br/Paginas/empregador/certificado-de-regularidade-do-fgts-crf.aspx

Há conectores genéricos assistidos para os três órgãos. O preenchimento e a tentativa de emissão ocorrem quando controles reconhecidos estão disponíveis. CAPTCHA, autenticação, mudanças de portal e campos adicionais podem exigir operação humana. Uma resposta HTML arbitrária não é interpretada como autenticação positiva.

## Estadual e DF

O registro inclui referências de 27 UFs. Referência ao site do órgão **não significa integração de emissão e validação homologada**. Onde não há endpoint de certidão conferido, o sistema abre o diretório oficial e identifica a navegação como assistida.

Fontes específicas consultadas:

- SP, escopos inscritos/não inscritos: https://portal.fazenda.sp.gov.br/servicos/certidoes/Paginas/Sobre.aspx
- SP, emissão não inscritos: https://portal.fazenda.sp.gov.br/servicos/certidoes/Paginas/Guia-N%C3%A3o-Inscritos.aspx
- DF: https://ww1.receita.fazenda.df.gov.br/cidadao/certidoes/Certidao
- Alagoas: https://contribuinte.sefaz.al.gov.br/certidao/
- Amazonas: https://www.sefaz.am.gov.br/portfolio-servicos/detalhes/541
- Espírito Santo: https://s2-internet.sefaz.es.gov.br/certidao/cnd
- Goiás: https://goias.gov.br/economia/certidao-negativa-de-debito/
- Rondônia: https://portalcontribuinte.sefin.ro.gov.br/Publico/certidaoNegativa.jsp

SP apresenta dois cartões estaduais para não confundir os escopos. O DF não exige cartão municipal separado neste fluxo. Demais diferenças de abrangência, inscrição estadual/municipal e certidões de dívida ativa ainda exigem homologação por jurisdição; não se presume cobertura tributária completa pelo nome de um documento.

## Municipal

Portais iniciais com referência consultada: São Paulo, Fortaleza, Campinas e Horizonte. Campinas e Horizonte começam no diretório de serviços, podendo encaminhar a outro domínio ainda não autorizado para captura.

- São Paulo: https://www.prefeitura.sp.gov.br/web/fazenda/w/servicos/certidoes/2394
- Fortaleza: https://cartadeservicos.sefin.fortaleza.ce.gov.br/
- Fortaleza, emissão: https://grpfordam.sefin.fortaleza.ce.gov.br/grpfor/pagesPublic/certidoes/emitirCertidao.seam
- Fortaleza, validação: https://servicossite.sefin.fortaleza.ce.gov.br/validacao-de-certidao
- Campinas: https://portal-adm.campinas.sp.gov.br/servico/certidoes-secretaria-de-financas
- Horizonte: https://www.horizonte.ce.gov.br/servicos.php

Nas demais localidades, a consulta tenta descobrir um site governamental a partir do código IBGE no Wikidata e procura links de certidão na página municipal. Descoberta pode falhar, apontar somente o diretório ou exigir adaptação para sistemas terceirizados. Links descobertos não são homologados e não podem confirmar automaticamente a comparação do PDF.

## O que a conferência implementada prova

1. O PDF armazenado mantém o SHA-256 registrado.
2. Os dados extraídos correspondem ao CNPJ e a um tipo de documento reconhecido.
3. Quando um PDF de referência é capturado em uma sessão de conferência, a comparação registra se os bytes são idênticos ao PDF anteriormente anexado. A origem HTTPS deve pertencer à lista de hosts do portal.
4. PDF diferente significa inconclusão, não falsificação. Nova emissão ou diferenças de metadados podem alterar o hash.
5. Capturas de tela e texto são evidências da navegação, não uma confirmação automática de autenticidade.

Não estão implementados: validação criptográfica de assinatura ICP-Brasil; interpretação homologada de todas as respostas de autenticidade; timestamp externo certificado; armazenamento externo imutável; conectores completos para todos os municípios. Não usar a expressão “todos os portais homologados” para esta versão.
