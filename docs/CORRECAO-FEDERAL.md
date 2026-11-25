# Correção do fluxo federal — 25/11/2026

O registro local de 23/11/2026 contém um timeout de clique com `modal-container` interceptando o botão da página inferior. Os cliques repetidos do Playwright provocavam rolagem. Esse registro é anterior ao commit do iniciador Windows (`8f905ef`), que não alterou automações.

A execução federal foi isolada em `automation/federalRunner.js`. O ponto de entrada continua sendo `runPortal`; os demais órgãos permanecem nos mesmos caminhos. O novo fluxo:

- Abre o formulário de pessoa jurídica e usa o campo `niContribuinte` confirmado no portal público.
- Trata cookies e modais antes de preencher ou clicar no formulário inferior.
- Envia cada ação automática uma vez; não repete um clique cujo resultado seja incerto.
- Captura respostas PDF, PDFs em JSON/base64 e downloads desde antes do primeiro clique, inclusive durante intervenção manual.
- Aguarda a leitura do download antes de reavaliar a página após Continuar.
- Mantém a segunda via, a confirmação explícita de nova emissão e a validação de CNPJ/órgão antes de salvar.
- Pausa para intervenção quando há erro, etapa desconhecida ou ausência de resposta. Não contorna CAPTCHA nem transforma erro de acesso em pendência fiscal.
- Respeita o cancelamento e remove os ouvintes ao finalizar.

`test/federal-runner.test.js` integra `npm run test:regression`. Cobre PDF imediato, cookies, modal desconhecido, erro do portal, segunda via, renovação, rejeição de PDF municipal e cancelamento. A inspeção pública confirmou o formulário; os testes de emissão usam páginas controladas. A emissão real continua dependendo da disponibilidade e da verificação de segurança da Receita.

Após atualizar os arquivos, reinicie o processo Node da Central: apenas atualizar a aba não recarrega o código do servidor. Não reinicie durante uma consulta em andamento.

## Diferenças entre computadores e execução em segundo plano

O iniciador inicialmente aceitava qualquer resposta `ok/version` da porta 3030. Isso permitia abrir outra pasta ou atualizar arquivos e continuar usando o processo antigo. Agora `/api/health` informa a identidade da instalação e o hash do código, calculados uma vez ao iniciar. O atalho recusa reutilizar uma cópia diferente ou desatualizada e orienta finalizar as consultas e reiniciar o Windows. Não encerra consultas automaticamente.

O fluxo federal aguarda o formulário completo, habilitado e estável, com uma espera mínima de oito segundos, e reavalia modais antes de preencher. Essa espera não garante que uma verificação externa de segurança foi concluída. Os códigos 023/016 não recebem interpretação fiscal presumida: a mensagem do modal é registrada com identificadores pessoais removidos. É necessária a mensagem completa e comparação com emissão manual para determinar sua causa.

A digitação sequencial do CNPJ e a espera após sair do campo foram restauradas para preservar os eventos de teclado da máscara. Na validação real posterior, a primeira etapa avançou até o modal de certidão existente, mas a consulta de segunda via retornou 023. Portanto, a espera inicial não deve ser apresentada como solução comprovada desse erro.

Inspeção do JavaScript público da Receita em 25/11/2026: `chunk-HRHJGXSL.js` define `ERRO_HCAPTCHA_EMITIR: "106"`; `chunk-5CVI44IF.js` define timeout de 5 segundos no componente; `chunk-NTXXKRUK.js` executa outra verificação no clique Consultar Certidão. Nenhum token é extraído ou modificado pela Central. O código 023 não foi mapeado nesses arquivos e não tem interpretação presumida. A emissão manual fora da Central foi confirmada pelo usuário; a comparação na mesma janela da automação ainda precisa ser validada.
