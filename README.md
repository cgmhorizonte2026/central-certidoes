# Central de Certidões v2.9.3.11

Central local com automação assistida por Playwright e emissão sequencial das certidões configuradas. As etapas automatizadas continuam dependentes das regras e desafios apresentados por cada órgão.

## Instalação para teste
1. Instale Node.js LTS e extraia a pasta completa da Central no computador do usuário.
2. Execute `INICIAR-CENTRAL.bat`. Na primeira execução, ele instala as dependências e o Chromium da automação, caso ainda não estejam instalados.
3. Mantenha a janela do iniciador aberta e acesse http://127.0.0.1:3031 no navegador.
4. Informe o CNPJ e inicie uma consulta. O navegador da automação abre quando o primeiro órgão for consultado; CAPTCHAs continuam dependendo de ação humana.
5. Para encerrar, pressione Ctrl+C na janela do iniciador. Use `npm test` para executar a validação automatizada.

PDFs permanentes ficam em `%LOCALAPPDATA%\CentralCertidoes`, ou no caminho configurado em `CENTRAL_CERTIDOES_STORAGE`. Se o Windows bloquear essa pasta, a Central usa `data\storage` dentro da instalação e, como último recurso, a pasta temporária do usuário. O caminho ativo aparece no log de inicialização do servidor. O cache de descoberta municipal fica junto aos dados da instalação. Este pacote não contém PDFs de empresas, dados reais nem perfil do navegador.

## Correções
- Clique em qualquer parte do card ou em Ver detalhes seleciona o documento e seus dados.
- Cards individuais podem iniciar a consulta assistida ou abrir o portal oficial para consulta manual; a Municipal resolve o portal pela empresa cadastrada.
- Visualização PDF estável, com páginas renderizadas por PDF.js e leitor nativo como alternativa; abrir/imprimir e baixar disponíveis.
- Anexo manual pede o código impresso e confirmação de que o responsável consultou o portal oficial. A Central verifica CNPJ, código e indícios do órgão no PDF; essa conferência local não consulta a base oficial automaticamente.
- Substituir documento preserva a cópia anterior no armazenamento.
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

## v2.9.3.11 — prontidão local
- Descoberta municipal adiada até a etapa municipal nas consultas completas. Consulta individual de outro órgão não fica esperando busca de portal municipal.
- Erros inesperados encerram a sessão com estado e log explícitos, liberam a fila e permitem iniciar uma nova consulta.
- O botão Parar responde antes do encerramento assíncrono do navegador.
- Chromium próprio da Central abre diretamente para cada sessão de consulta, sem depender do Chrome do usuário ou de conexão CDP na porta 9222. O iniciador verifica o executável instalado e prepara o navegador quando ele estiver ausente.
- Se a pasta permanente estiver sem permissão, a Central escolhe outra pasta gravável e continua arquivando o PDF; registros antigos continuam acessíveis pelos caminhos arquivados.
- O servidor local aceita conexões somente de `127.0.0.1`.
- `npm test` executa os arquivos de teste da pasta `test` individualmente.
# Execução local e demonstração Linux

## Windows

`INICIAR-CENTRAL.bat` abre a Central local na porta `3031`. Também é possível usar `PORT=3031 node server.js` no PowerShell; a porta padrão agora é `3031`.

## Docker/VPS

Copie `.env.example` para `.env` e ajuste apenas as variáveis necessárias:

```bash
cp .env.example .env
docker compose build
docker compose up -d
docker compose logs -f central-certidoes
docker compose down
```

O serviço fica em `http://127.0.0.1:3030` dentro da VPS. O volume `central_certidoes_storage` preserva PDFs, `archive`, cache de portais e demais dados em `/app/storage` mesmo após recriar o container. No Linux, o `BrowserManager` usa Chromium gerenciado pelo Playwright; não abre `chrome.exe` nem expõe CDP.

Para Nginx, encaminhe HTTP para a porta 3030 e preserve conexões de polling (`proxy_http_version 1.1`, `proxy_read_timeout` acima do intervalo de consulta). A aplicação atual usa long polling HTTP em `/api/session/:id`, não WebSocket.

Esta etapa é de demonstração: PostgreSQL, autenticação própria, backup e alta disponibilidade permanecem fora do escopo.
