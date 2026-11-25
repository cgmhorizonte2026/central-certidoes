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
