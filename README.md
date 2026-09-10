# Central de Certidões V3

Sistema local para controle documental de prestadoras. Consulta CNPJ, determina UF e município, seleciona portais, guarda PDFs, registra evidências e gera relatórios persistentes. O projeto original na unidade E: foi preservado.

## Abrir neste computador

1. Execute `Iniciar-Central.cmd` nesta pasta e mantenha a janela aberta.
2. Acesse **http://127.0.0.1:3030**.
3. O cadastro público está desativado. Se ainda não houver usuário, execute `Criar-Administrador.cmd` no computador e informe nome e senha (mínimo 12 caracteres). A senha não é exibida nem passada como argumento de processo. Depois entre e use **Administração > Usuários**.

Dependências já copiadas do projeto original para este ambiente. Em outro computador, instale Node.js 24 ou superior e Microsoft Edge, execute `npm ci` e depois `npm start`. Alternativamente, use Chromium com `npx playwright install chromium`. `BROWSER_CHANNEL=chrome` seleciona Chrome.

O servidor escuta exclusivamente em `127.0.0.1`. Não exponha essa instalação na internet nem mude o bind para rede compartilhada: a arquitetura é local e não inclui implantação HTTPS ou gestão de usuários de equipe.

## Uso

1. Informe o CNPJ. Os dígitos verificadores são conferidos, inclusive para o formato alfanumérico. A consulta cadastral usa BrasilAPI, Minha Receita ou ReceitaWS, registrando a fonte utilizada.
2. A UF e o município são confrontados com a base IBGE embarcada. O sistema possui referências das 27 UFs e 5.571 municípios, que **não equivalem a 5.571 integrações homologadas**.
3. Emita uma certidão ou use **Consultar todas**. O navegador abre em uma sessão isolada, tenta preencher e emitir onde reconhece os controles. Conclua CAPTCHA e campos adicionais no órgão. **Concluir e registrar evidências** salva a tela e prossegue na fila.
4. PDFs baixados pelos hosts cadastrados são capturados. PDFs recebidos da prestadora também podem ser anexados. O original é preservado; nova anexação cria outra versão.
5. Use **Conferir PDF** para abrir a consulta de autenticidade e obter a referência oficial. Se o órgão devolver o mesmo PDF, o sistema registra a igualdade exata por SHA-256. Se devolver outro arquivo, ou apenas uma página sem interpretação homologada, a autenticidade permanece inconclusiva. Captura de tela e observação ficam na trilha.
6. Gere o relatório PDF e baixe o comprovante JSON. Cada relatório é um retrato imutável pela interface: mudanças posteriores exigem novo relatório. **Conferir integridade** compara os arquivos com os hashes armazenados.

## Descoberta municipal na primeira consulta

São Paulo, Fortaleza, Campinas e Horizonte têm referências iniciais. Para outra localidade, a consulta procura o site governamental do município pelo código IBGE e tenta localizar links de certidão tributária. O sistema salva a origem dessa descoberta para reutilizar com outras empresas.

Uma descoberta não é uma homologação. Se a fonte estiver indisponível, não houver correspondência ou o portal usar fornecedor terceirizado, a interface mantém a pendência e permite cadastrar o serviço oficial. A conferência não recebe confirmação automática com um link apenas descoberto. Serviços terceirizados exigem cadastro técnico com evidência do vínculo oficial.

## Regras de confiança

- Ler “negativa” no PDF não prova autenticidade. “Irregular” nunca é tratado como “regular”.
- Um PDF sem CNPJ correspondente, tipo reconhecido ou validade explícita permanece pendente.
- Vencimento é recalculado na data de consulta em horário de Brasília. A extração não inventa uma validade com base em qualquer data existente no texto.
- “PDF idêntico ao obtido no portal oficial” descreve uma comparação de bytes em consulta registrada; não é validação de assinatura ICP-Brasil ou garantia jurídica absoluta.
- Reconsultar é necessário para atualizar a conferência em outro dia. O relatório identifica a data efetiva da comparação.
- Resposta ausente, CAPTCHA, erro, PDF diferente e município sem integração não resultam em aprovação.
- O painel nunca decide pela liberação de pagamento. A análise documental é parte do processo de controle.

## Dados e segurança

Dados persistem em `data/central.sqlite`; arquivos e evidências em `data/files`, `data/evidence` e `data/reports`. `data/audit.key` autentica os registros e a cadeia de eventos. Não há armazenamento dos PDFs em localStorage, nem exposição de diretórios por URL.

Senhas usam scrypt; a sessão local usa cookie HttpOnly e SameSite Strict, proteção de origem e token CSRF. Há limite de tentativas de login. Administradores cadastram órgãos e usuários, alteram perfis e bloqueiam contas. Operadores não podem administrar cadastros. Alterações de senha, perfil ou bloqueio revogam as sessões do usuário. O último administrador ativo não pode ser bloqueado ou rebaixado. O nome identifica a conta usada; não equivale a assinatura digital da pessoa.

Para backup, pare o servidor e copie a pasta **data inteira**, incluindo banco, arquivos, relatórios e chave, para local protegido. Restaurar exige o conjunto completo. Perder a chave invalida a conferência dos registros. Não sincronize um SQLite aberto por simples cópia de arquivos.

Hashes/HMAC detectam alterações quando a chave está preservada. Quem controla o computador e a chave pode reconstruir registros. Esta versão não usa timestamp externo certificado nem armazenamento WORM externo. As datas são do relógio do computador servidor.

## Verificação executada

Execute `npm test` ou `node --test test/*.test.js`.

Os testes cobrem CNPJ numérico/alfanumérico, classificação conservadora, datas inválidas, documento vencido, UF/município/DF/SP, origens HTTPS, descoberta municipal, autenticação/CSRF, upload, comparação de PDF, geração de relatório, persistência e alteração de banco/arquivos.

O teste de comparação usa uma resposta **sintética**, explicitamente marcada como teste, para verificar a lógica. Não demonstra emissão real por todos os órgãos. Foi realizada consulta cadastral real de um CNPJ público para testar o roteamento do DF. Nenhuma prestadora foi declarada regular como resultado desses testes.

O relatório de teste fica em `tmp/pdfs/relatorio-teste.pdf`, sem valor para processo de pagamento.

## Limites de entrega

A automação preenche e envia formulários reconhecidos e acompanha as próximas etapas. Há adaptações específicas para Receita Federal, Ceará, Distrito Federal, TST e Fortaleza, além de preenchimento por identificação de campos nos demais portais. A emissão e a autenticidade de todos os estados e municípios não estão homologadas. A integração pode parar em páginas de serviços, CAPTCHAs ou sistemas de terceiros. Não há validação criptográfica de assinatura digital nem carimbo de tempo externo. Antes de uso decisório, valide o fluxo real de cada órgão atendido com documentos e responsáveis do processo.

Fontes e cobertura: [docs/FONTES-E-COBERTURA.md](docs/FONTES-E-COBERTURA.md).

## Estrutura

- `server.js`, `lib/app.js`: servidor local e API autenticada.
- `lib/company.js`, `config/municipalities.json`: consulta cadastral e jurisdição.
- `config/registry.js`, `lib/discovery.js`: diretório de órgãos e descoberta municipal.
- `automation/sessions.js`: navegador, captura e evidências.
- `lib/domain.js`, `lib/certificates.js`: leitura, classificação e comparação.
- `lib/store.js`: banco e integridade.
- `lib/report.js`: relatório e comprovante.
- `public/`: interface em português, sem scripts externos.
- `scripts/build-geography.js`: atualização explícita da base IBGE; indisponibilidade do Wikidata não remove o diretório IBGE.

## Reutilização e emissão

Ao solicitar emissão, o backend reutiliza o último PDF obtido do portal para aquela empresa e tipo, se o arquivo estiver íntegro, o CNPJ e o tipo forem reconhecidos, a classificação for identificada e houver **5 dias ou mais** de vigência restantes. Abaixo de 5 dias, realiza nova tentativa de emissão. PDFs anexados sem procedência oficial não são reutilizados automaticamente. A reutilização não renova a data da conferência de autenticidade. Arquivos de conteúdo idêntico compartilham o mesmo armazenamento.

A sessão de emissão identifica desafios visíveis e oferece **Mostrar janela do órgão**, **Ver prévia da janela** e **Continuar emissão**. O CAPTCHA é resolvido na janela Edge do órgão, não na imagem de prévia. O robô tenta o Buster nos desafios reCAPTCHA com áudio compatíveis e retoma a emissão ao identificar a resposta. Desafios não resolvidos continuam disponíveis na janela do órgão. Campos com máscara recebem eventos de digitação. O TST abre diretamente o serviço CNDT. Mensagens de falha da Receita são exibidas como impedimento, não como emissão concluída. Ao capturar um PDF, o sistema conclui a sessão automaticamente e registra as evidências possíveis. Páginas sem CAPTCHA não recebem instrução afirmando que ele foi localizado.

## Administração

**Administração > Órgãos** cadastra unidades administrativas e emissores. Emissores federais, estaduais e municipais podem ter seus links de emissão e autenticidade administrados no banco. Alterações preservam a trilha. O cadastro institucional não cria isolamento de dados entre órgãos; esta instalação continua sendo uma base compartilhada local.

### Verificação da automação em 09/09/2026

Foram inspecionados os formulários oficiais da Receita, Ceará, DF, TST e Fortaleza. A tentativa real na Receita passou pela validação do CNPJ após corrigir a digitação com máscara, mas o serviço retornou erro 106 e não entregou PDF. Ceará, TST e Fortaleza apresentam desafios de segurança. O acesso de teste ao FGTS foi redirecionado para verificação externa. Isso não comprova emissão integral nesses portais. A suíte automatizada usa formulários sintéticos para testar preenchimento, navegação, espera por CAPTCHA, retomada sem duplicar solicitação e bloqueio de páginas não confiáveis.

## Robô com Buster

A instalação inclui navegador Chromium dedicado e Buster 3.4.0 para tentativa gratuita por áudio, com logs, limite de tentativas e retorno assistido. PDFs ficam em `data/files/CNPJ/tipo/sha256.pdf`. Veja [configuração, instalação e limites](docs/ROBO-E-CAPTCHA.md). Na tela: Consultar, Validar e Visualizar / imprimir.
