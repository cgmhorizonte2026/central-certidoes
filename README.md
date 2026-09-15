# Central de Certidões v2.9.3.2

Correção funcional baseada no ZIP v2.9.3.1. Os arquivos automation/portalRunner.js, automation/browser.js e config/portals.js permanecem intactos. Não foram desenvolvidas novas automações.

## Instalação para teste
1. Encerre o servidor antigo sem apagar sua pasta.
2. Extraia este ZIP em uma nova pasta e execute INICIAR-CENTRAL.bat. Na primeira execução, o iniciador instala as dependências npm caso necessário.
3. Abra http://localhost:3030 no MESMO navegador e endereço usados anteriormente; o histórico e as conferências existentes são vinculados à origem do navegador.
4. Informe o CNPJ. Consultar carrega os registros; Iniciar consultas mantém a automação existente.

PDFs permanentes continuam em %LOCALAPPDATA%\CentralCertidoes, ou no caminho configurado em CENTRAL_CERTIDOES_STORAGE. Este pacote não contém PDFs de empresas, dados reais nem perfil do navegador.

## Correções
- Clique em qualquer parte do card ou em Ver detalhes seleciona o documento e seus dados.
- Visualização PDF estável, com páginas renderizadas por PDF.js e leitor nativo como alternativa; abrir/imprimir e baixar disponíveis.
- Envio manual arquiva os bytes do PDF por CNPJ e tipo de certidão, com identificador único. Substituir preserva a cópia anterior no armazenamento.
- Edição dos dados mantém a associação ao PDF; atualização periódica não sobrescreve edições do mesmo documento.
- Histórico e Empresas listam registros locais e empresas com documentos no arquivo permanente.
- Relatórios gera a conferência das cinco certidões, incluindo pendentes, com impressão/salvamento pelo navegador. Não declara extração direta de documentos manuais.
- Configurações mostra armazenamento e permite editar a razão social da empresa atual.
- Abas Dados extraídos, Autenticidade e Observações funcionais. Observações isoladas por CNPJ e certidão.
- Nova consulta limpa os documentos exibidos. Respostas atrasadas da busca de empresa e do arquivo não atravessam CNPJs.

## Anexos da versão anterior
A v2.9.3.1 não salvava o conteúdo dos PDFs enviados manualmente: guardava apenas nome e dados extraídos. Arquivos já arquivados pelo servidor são reutilizados. Quando houver somente nome/dados e nenhum PDF, reenvie o original uma vez pelo card correto. Não há como reconstruir um PDF a partir de seu nome.

## Roteiro de conferência
- Abra uma empresa antiga e confira cada um dos cinco cards.
- Anexe PDFs em cards distintos, alterne, edite código/validade e recarregue a página.
- Registre observações em dois cards e confirme o isolamento.
- Abra Histórico, Empresas, Relatórios e Configurações.
- Imprima o relatório e um PDF de certidão.
- Use Nova consulta e confira que o documento anterior não permanece.

A extração automática pode não ler PDFs digitalizados ou protegidos. O arquivo ainda é armazenado, e os dados podem ser preenchidos na aba Dados extraídos. PDF.js e as fontes do layout usam os mesmos serviços externos da versão anterior; o leitor nativo serve como alternativa para a visualização.


## v2.9.3.3 — continuidade da fila
A Central tenta Federal, FGTS, Trabalhista e Estadual nessa ordem. Falhas são registradas e a fila continua. O resultado final informa pendências, sem considerar documentos antigos como emitidos nesta consulta. A Municipal permanece manual. A espera de CAPTCHA da Federal fica limitada a 2 minutos (outras esperas do portal possuem seus próprios limites). O botão Parar continua encerrando a fila. Nenhum seletor de emissão foi alterado.

## v2.9.3.4
- Recuperação do PDF Federal na pasta exclusiva da emissão se download.saveAs falhar.
- Busca de CNPJ e botões também dentro de frames, com seletores adicionais.
- Preenchimento manual assistido se o CNPJ do FGTS/TST não for localizado.
- Trabalhista aguarda o usuário preencher o CAPTCHA e clicar em Continuar na Central. Não resolve caracteres automaticamente.
- Reconexão do gerenciador quando a conexão anterior com Chrome foi encerrada.

Validação: sintaxe, recuperação na pasta exclusiva, preenchimento em frame e bloqueio até Continuar passaram. A emissão real completa de FGTS e Trabalhista ainda depende de teste no portal. O PDF Federal da consulta reportada foi recuperado e validado no painel.

## v2.9.3.5
FGTS: fluxo específico Consultar -> link do CRF -> impressão da página oficial em PDF, validando o CNPJ e os campos do certificado antes de salvar.
Trabalhista: endereço direto do formulário oficial, campo cpfCnpj e botão botao-emitir; CAPTCHA preenchido pelo usuário.
Estadual: seleção CNPJ antes de preencher codigoDevedor e ação Pesquisar antes da espera de CAPTCHA.
Validação: sequência FGTS e gravação testadas com simulação; espera humana, recuperação Federal e preenchimento em frame testados. A navegação real até o certificado HTML FGTS foi confirmada. Emissão completa TST/Estadual e impressão do FGTS pela automação ainda dependem de teste real.

## v2.9.3.6
- Trabalhista: downloads passam a usar pasta controlada por portal, permitindo recuperar o PDF quando o Playwright perde o arquivo temporário.
- Estadual CE: a seleção de CNPJ agora é obrigatória e verificada antes de pesquisar, evitando avanço com o formulário em estado inválido.
- Interface: o painel passa a priorizar o evento arquivado definitivo (pdf_archived/pdf_parsed) para exibir o PDF correto no card selecionado.
- Recuperação local: CNDT da última consulta de teste validada pelo CNPJ e anexada ao arquivo permanente da Central.

## v2.9.3.7
- FGTS: depois de abrir o certificado, a Central agora aciona o botão Visualizar e só arquiva o PDF real retornado por essa etapa.
- Estadual CE: captura ampliada para links, botões e imagens de PDF na coluna Ações, com recuperação pela pasta controlada quando o Chrome baixar sem disparar evento Playwright.

## v2.9.3.8
- FGTS: se o botão Visualizar abrir a tela de impressão sem download capturável, a Central gera o PDF da própria página final do certificado.
- Estadual CE: quando o portal abre a certidão como página HTML consultarPdf, a Central imprime essa página oficial em PDF e para de clicar em múltiplos ícones.
- Trabalhista: reforçada a recuperação pela pasta controlada quando uma resposta intermediária inválida chega antes do PDF real.

## v2.9.3.9
- FGTS: adicionada captura pelo botão real de impressão `mainForm:btImprimir4`, que chama `Imprimir()` no portal da Caixa.

## v2.9.3.10
- A fila verifica o arquivo permanente antes de abrir os portais. Certidões com PDF existente e validade vigente são reutilizadas e marcadas como já válidas.
- Somente certidões vencidas, sem validade identificada ou ausentes entram na emissão automática.
- A consulta cadastral passa a guardar UF/município quando disponível. A Estadual do Ceará só roda para CNPJ com UF `CE`; para outra UF, ou UF não identificada, a etapa estadual fica pendente para evitar emissão do estado errado.
