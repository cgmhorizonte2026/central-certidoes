# Consulta municipal — versão 2.9.4.2

## Como usar

1. Consulte a empresa e inicie a certidão Municipal.
2. A Central identifica o portal com o resolvedor existente e abre uma janela
   própria do Chrome. Um município sem roteiro aprendido começa em modo manual,
   inclusive Fortaleza. O fluxo antigo de CAPTCHA não é executado nesse caso.
3. Nessa janela, preencha o CNPJ, conclua a emissão e use Baixar ou Imprimir. A Central
   recebe o download, confere CNPJ e identificação municipal e salva o PDF na
   pasta permanente assim que termina a leitura. Não é necessário anexá-lo.
4. Quando aparecer “PDF municipal salvo”, clique em **Continuar**. O sistema
   conclui a etapa e guarda o roteiro para outras empresas do mesmo município.
5. Se o roteiro já existir, a Central o executa com o CNPJ da empresa atual.
   Um PDF ainda válido pode ser reaproveitado depois que o município já tiver
   roteiro aprendido.

Se Continuar for pressionado antes do download, a Central informa que aguarda o
PDF. Ela não reinicia a página, não retorna ao CAPTCHA e não conclui sem arquivo.
O anexo manual comum continua disponível fora desse fluxo, como alternativa.

## CAPTCHA e mudança no portal

CAPTCHA e dados particulares podem continuar exigindo intervenção. Durante a
repetição, a Central pausa na mesma página; após o usuário resolver o desafio e
clicar em Continuar, retoma da etapa interrompida. Não salva senhas nem respostas
de CAPTCHA. Esses pontos ficam registrados como pausas no roteiro.

Se um campo mudar ou o portal não entregar o PDF, a janela e os cookies são
preservados para concluir manualmente. Não há nova navegação automática para o
início. O roteiro só é salvo depois da confirmação de um PDF compatível e de
uma demonstração que inclua o preenchimento do CNPJ. PDFs sem texto reconhecível,
portais com domínios adicionais e formulários especiais podem exigir adaptação.
Não é possível garantir emissão sem intervenção em todos os órgãos.

## Captura e armazenamento

A raiz é `CENTRAL_CERTIDOES_STORAGE`, quando configurada; por padrão:
`%LOCALAPPDATA%\CentralCertidoes`.

- `certidoes/CNPJ/data`: PDFs permanentes. Certidões municipais usam um sufixo de
  hash para preservar versões diferentes emitidas no mesmo dia.
- `archive/CNPJ.json`: índice, metadados e histórico das versões. Escrita por
  arquivo temporário e renomeação, preservando o índice anterior em caso de falha.
- `municipal-flows`: roteiros, separados por município/IBGE e endereço do portal.
- `municipal-downloads/identificador`: pasta exclusiva de captura de cada sessão;
  mantém os arquivos recebidos para diagnóstico e recuperação.

A captura combina eventos de download, respostas PDF, PDFs incorporados e
monitoramento da pasta configurada via CDP. Arquivos parciais não são processados.
Downloads repetidos são deduplicados por SHA-256. A conclusão exige que o PDF já
esteja arquivado. Cancelar ou reiniciar o servidor preserva os PDFs já salvos;
uma demonstração não concluída pode precisar ser repetida.

A sessão tem limite de 30 minutos. O botão Parar libera a fila imediatamente, cancela as esperas de CAPTCHA e fecha somente as abas de automação da sessão. Uma resposta atrasada da sessão cancelada não altera a consulta seguinte. Repetir o cancelamento da sessão antiga não cancela uma nova sessão.
O encerramento do servidor interrompe as esperas e libera os monitores.

## Relatório

Inclui situação, validade, número, chave de consulta e indicação de origem.
A indicação de portal oficial exige evidência do endereço de resposta/download
no domínio identificado. A leitura isolada de um arquivo na pasta não prova o
host de origem; nesses casos, o relatório informa origem não comprovada.
Capturas CDP com URL e nome do download permitem vincular essa origem ao PDF.
Os campos não extraídos permanecem vazios, sem herdar os valores de outro PDF.

## Validação e operação

Execute `npm run test:municipal`. Os testes usam portais e documentos sintéticos,
sem emitir certidões reais. Cobrem emissão manual inicial, gravação antes de
Continuar, execução com outro CNPJ, download CDP sem evento do Playwright, pausa
e retomada de CAPTCHA, cancelamento, timeout, alteração de formulário, rejeição
de CNPJ divergente, deduplicação, arquivamento e a interface real do sistema.

Para atualizar a instalação local, encerre o servidor anterior e execute
`INICIAR-CENTRAL.bat` nesta pasta. Recarregue a página com Ctrl+F5. O endpoint
`/api/health` deve indicar `2.9.4.2`. Faça backup da raiz de armazenamento antes de
mover a instalação para outra máquina; copiar somente o código não transfere os
PDFs e os roteiros aprendidos.

## Impressão municipal compartilhada

O mecanismo observa `window.print()` na página, em popups e em frames do portal
identificado. Registra a versão de impressão no momento da chamada, antes que o
portal apague o conteúdo ou feche a janela. Respeita CSS de impressão e tamanho
de página; renderiza em navegador separado, com scripts desabilitados. O PDF
original recebido do órgão tem prioridade sobre essa renderização.

Somente documentos com CNPJ compatível, identificação municipal, situação
declarada, texto certificador e dados documentais são aceitos. Páginas de
resultado e listagens permanecem pendentes. Esse controle é aplicado também a
PDFs nativos, não apenas à impressão. O relatório distingue o PDF gerado da
versão de impressão do arquivo recebido originalmente.

Roteiros antigos podem incorporar o botão Imprimir quando ele for identificado
sem ambiguidade. Caso contrário, a demonstração manual acrescenta essa etapa.
Arquivos anteriores sem a política de verificação do documento final não são
reutilizados automaticamente; permanecem preservados no histórico.

A lógica não depende do nome do município. Portais com conteúdo inacessível,
certidões apenas em imagem, domínios externos não cadastrados ou impressão por
componente proprietário ainda podem exigir adaptação. A validação desta versão
usa portais sintéticos; não representa homologação de todos os órgãos reais.
