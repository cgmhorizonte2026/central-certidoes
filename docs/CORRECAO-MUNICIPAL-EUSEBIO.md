# Navegação municipal e Eusébio — 11/09/2026

O cadastro descoberto de Eusébio (IBGE 2304285) só reconhecia o site principal. A consulta registrada chegou ao portal GPI e ficou bloqueada por domínio. O site oficial https://eusebio.ce.gov.br/ publica “Portal do Contribuinte Atendimento Sefin” com destino a https://gpi.eusebio.ce.gov.br/ServerExec/acessoBase/?idPortal=29b1b7da-7c90-43e3-8817-64373eedc7f1 .

O cadastro revisado usa esse destino e inclui explicitamente o host GPI. Ele prevalece sobre o antigo cadastro automático; cadastros manuais continuam preservados. Não foi liberado um domínio genérico de fornecedores.

A navegação municipal reconhece links e botões de certidões negativas/tributárias, Portal do Contribuinte e serviços. Prioriza a certidão tributária e evita certidões imobiliárias, civis e validação de autenticidade. Segue somente destinos já cadastrados, com limite de etapas, antes do preenchimento. A descoberta também mantém os hosts governamentais das páginas intermediárias percorridas.

A captura municipal passa a reconhecer PDF embutido em object/embed/iframe ou blob, além de downloads. Apenas bytes PDF recebidos de uma página confiável são capturados; não se transforma qualquer página de formulário em certidão.

Limitação: o navegador de inspeção não conseguiu acessar o serviço GPI, embora o vínculo no site oficial e o destino no registro local tenham sido confirmados. O fluxo completo e o PDF real de Eusébio ainda precisam ser verificados. Os testes usam páginas e PDFs fictícios.

Para carregar o código atualizado, reinicie a Central e inicie uma nova consulta municipal. A consulta anterior guarda o cadastro com que foi aberta.
