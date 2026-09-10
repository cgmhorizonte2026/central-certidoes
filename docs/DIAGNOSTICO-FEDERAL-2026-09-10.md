# Diagnóstico verificável — Certidão Federal

Data: 10/09/2026. Teste com navegador visível, CNPJ já autorizado no histórico e dados pessoais omitidos. A emissão federal integral **não foi concluída**. Nenhum PDF federal foi obtido neste teste; não existe arquivo real a ser aprovado ou apresentado como certidão.

## Causa comprovada e limite da conclusão

No JavaScript servido pela própria Receita, a enumeração define ERRO_HCAPTCHA_EMITIR = "106" e ERRO_HCAPTCHA_CONSULTA = "105". O formulário executa validaHCaptcha antes de emitirService.verificar. executeCaptcha possui tempo limite padrão de 5.000 ms e pode falhar por captcha-timeout, missing-captcha ou erro do provedor.

O teste anterior às mudanças mostrou CNPJ completo, campo ng-valid/aria-invalid=false, clique efetivo e erro 106 antes de qualquer requisição de emissão observada. A causa imediata comprovada é falha da etapa hCaptcha, não impedimento fiscal, seletor do botão ou download perdido. O subtipo interno da falha e a razão de o procedimento manual do usuário funcionar **não foram comprovados**. Não foram capturados tokens nem alterados callbacks do provedor para investigar isso.

Fontes primárias inspecionadas, sem executar endpoints internos por fora do navegador:
- https://servicos.receitafederal.gov.br/servico/certidoes/chunk-HRHJGXSL.js — enumeração dos códigos 105/106.
- https://servicos.receitafederal.gov.br/servico/certidoes/chunk-NTXXKRUK.js — onSubmit, validaHCaptcha, verificar, modal e rota resultado.
- https://servicos.receitafederal.gov.br/servico/certidoes/chunk-5CVI44IF.js — componente hCaptcha invisível e limite de cinco segundos.
Esses nomes de arquivos são os observados nesta data; não são endpoints fixados no robô.

## Etapas e evidências

URL do teste: https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj

| Horário UTC, teste posterior | Etapa | Resultado |
|---|---|---|
| 15:01:51 | Abrir navegador | Visível, sem extensão de resolução de CAPTCHA |
| 15:02:11 | GET /servico/certidoes/api/env | HTTP 200; configuração carregada pelo portal |
| 15:02:13 | Formulário e clique Emitir | CNPJ preenchido; um clique, sem reenvio |
| 15:02:18 | Segurança | Estado captcha_required; erro 106 do portal |
| 15:02:19 | Arquivo | pdfCount=0; nenhum PDF fiscal anexado |

Arquivos locais de evidência, relativos ao projeto:
- tmp/federal-audit-before/events.json — execução anterior, metadados sem payloads.
- tmp/federal-audit-before/01-landing.png, 02-form.png, 03-filled.png, 05-result.png — telas com campos mascarados.
- tmp/federal-audit-after/events.json — execução posterior e URLs sem query strings.
- tmp/federal-audit-after/01-form.png e 02-result.png — telas após alteração.

O script scripts/diagnose-federal.js reproduz o teste com navegador visível. A sessão diagnóstica é encerrada explicitamente ao terminar o teste; uma sessão normal da Central permanece aberta para intervenção manual, respeitando seu limite operacional de 20 minutos.

## Comparação com os demais fluxos

| Integração | Resultado/captura | Diferença relevante |
|---|---|---|
| Ceará | Linha do CNPJ e página oficial de impressão convertida em PDF | Não é o mecanismo federal; a federal não usa esse fallback HTML |
| FGTS | Visualizar e versão final de impressão | Exige distinguir página preliminar de certidão |
| TST | Download e consulta pelo número/ano | Formulário e autenticador próprios |
| Federal | hCaptcha antes da verificação; modal de certidão existente; rota resultado | Falha atual acontece antes do resultado e do PDF |

## Investigação técnica

- **URL e tipo:** portal atual confirmado pela página oficial de serviço. A página oferece Pessoa Física, Pessoa Jurídica, Imóvel Rural e Obra de Construção Civil. A Central e o teste são de pessoa jurídica. Não foi inferido CPF, CIB ou CNO a partir de CNPJ.
- **Seletores/eventos:** input name=niContribuinte e botão Emitir Certidão foram observados ao vivo. Campo recebeu digitação e blur, ficou válido. O primeiro clique aconteceu.
- **Assíncrono:** carregamento da SPA e resultado aguardados por elementos/estado, não por espera cega. A primeira emissão não é repetida durante o processamento.
- **Iframe/Shadow DOM:** hCaptcha está em frames de outro domínio; o formulário fiscal principal foi localizado no DOM acessível. Não houve intervenção em Shadow DOM fechado nem execução dentro do desafio.
- **Cookies/sessão:** navegador isolado, cookies mantidos pelo próprio contexto. O GET opcional de dados do usuário retornou 401 sem autenticação; isso sozinho não comprova causa da falha do serviço público. Sessão pessoal não foi copiada.
- **CSRF:** não houve requisição de emissão a comparar; portanto não há evidência de CSRF ausente. Nenhum token foi fabricado ou reenviado manualmente.
- **Segurança:** hCaptcha confirmado no código oficial; nenhuma evidência específica de Cloudflare como causa. Buster está desativado para a federal.
- **Headless:** ambos os diagnósticos deste relatório usaram headless:false. A falha não foi atribuída ao modo headless.
- **Pop-up, redirect, blob, base64:** capturas preparadas para download, resposta PDF, JSON/base64, data URI e blob incorporado/aba com origem oficial. O teste real não alcançou essas etapas; testes sintéticos não equivalem a emissão real.
- **Fechamento antecipado:** o navegador permaneceu aberto até a falha de segurança registrada; não havia download em andamento. A finalização normal aguarda as capturas pendentes.
- **Consultar versus emitir:** consultar é uma ação distinta e também usa hCaptcha. O robô não troca emissão por consulta após erro. O modal Emitir Nova Certidão é acionado apenas se aparecer e estiver habilitado.

## Arquivos e alterações

- automation/issuer-engine.js / advance: reconhece 105/106 como segurança; não rotula isso como dívida.
- automation/robot-browser.js / openRobotBrowser: federal visível sem Buster; demais conectores preservados.
- automation/sessions.js / open, guide, receive: metadados de rede sem identificadores; captura adicional de PDF codificado; pausa manual na federal.
- automation/federal-support.js: classificação específica, decodificação limitada de PDF e limpeza dos logs.
- lib/certificates.js / ingest: rejeita captura federal sem identificador/tipo/classificação correspondentes, páginas de erro ou PDF produzido de HTML pelo robô.
- lib/app.js: nome do download federal certidao_federal_IDENTIFICADOR_AAAAMMDD.pdf. Internamente os bytes continuam em caminho por hash para preservar deduplicação e histórico.
- scripts/diagnose-federal.js e test/federal-support.test.js: reprodução visível e testes de segurança/captura.

## Validação e pendências

42 testes gerais passaram na execução completa. Cobrem fluxos existentes, pausa humana, captura, armazenamento, integridade e interface. Novos testes cobrem classificação dos códigos, base64 inválido e redação de logs. A proteção adicional contra texto de erro em PDF foi verificada separadamente.

**Não foi obtido PDF federal real**; logo não se afirma que o PDF real existe, tem assinatura %PDF ou corresponde ao contribuinte. Somente quando recebido será conferido pelo parser, comparado ao identificador e gravado com hash; HTML não é aceito como certidão federal.

CPF, imóvel rural e obra **não estão implementados de ponta a ponta no cadastro desta Central**, que armazena empresas por CNPJ. O portal federal exige identificadores próprios e, conforme o formulário, informações adicionais. Não houve identificador autorizado desses tipos para teste. Ampliar esse cadastro é trabalho distinto da correção isolada da falha atual; não foi apresentado como concluído.

A solução disponível nesta alteração é pausa e continuidade manual na mesma sessão. Se o próprio portal encerrar a tentativa de hCaptcha em cinco segundos, o operador poderá precisar fechar o aviso e tentar pelo botão oficial. O robô não altera esse prazo, não resolve o desafio e não presume que existe uma API pública autorizada para contornar essa etapa.
