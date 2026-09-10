# Robô de certidões

O robô utiliza Playwright/Chromium, equivalente funcional ao Selenium para este fluxo. O navegador é dedicado, com perfil por operador, e não altera o Chrome pessoal. A instalação desta máquina já inclui Chromium e Buster 3.4.0. O modelo Whisper local é preparado por perfil de operador. Para reinstalar as dependências em outra máquina: `powershell -File .\Instalar-Robo.ps1` (Node e dependências do projeto devem estar disponíveis).

## Fluxo

1. **Consultar** verifica os registros e a integridade dos PDFs locais. Havendo documento de origem oficial, CNPJ/tipo compatíveis, classificação reconhecida e pelo menos cinco dias até o vencimento, informa a validade e reutiliza o arquivo.
2. Caso contrário, abre o órgão, preenche os campos reconhecidos e solicita a emissão.
3. Ao detectar reCAPTCHA compatível, tenta o Buster gratuito por áudio: até duas tentativas e 90 segundos por sessão. Resolução só é considerada concluída pelo estado real do formulário, nunca pelo simples clique no Buster.
4. Sem extensão, com bloqueio, sem áudio ou diante de outro CAPTCHA, mostra a pendência e mantém a janela disponível. Após a resposta, continua automaticamente. Não há serviço pago configurado.
5. Captura o PDF do domínio oficial, extrai a situação/validade e registra evidências. **Visualizar / imprimir** abre o arquivo no leitor PDF do navegador; **Validar** abre uma consulta de autenticação, separada da emissão.

O Buster é específico para reCAPTCHA com áudio. Não atende todos os desafios dos órgãos, nem corrige indisponibilidade, erro 106 da Receita ou exigências cadastrais. O robô configura o Whisper local da extensão e desativa os serviços remotos nas opções. O modelo é baixado na primeira preparação do perfil; nenhuma chave paga é configurada. Se a preparação falhar, o sistema informa a pendência. Não há garantia de emissão sem intervenção em todos os portais.

## Arquivos e configuração

- PDFs definitivos: `data/files/<CNPJ>/<tipo>/<sha256>.pdf`. O nome por hash evita cópias idênticas. Referências antigas são preservadas; links físicos permitem organizar o mesmo conteúdo sem duplicar bytes.
- Downloads temporários do navegador: `data/downloads/<CNPJ>/<tipo>/`. O navegador não pede confirmação de download; a captura persiste o PDF na pasta definitiva antes de encerrar a sessão.
- `DATA_DIR`: diretório absoluto do banco, PDFs, evidências e perfis; defina antes de iniciar o servidor. Não troque sem migrar a base completa.
- `CAPTCHA_METHOD=manual`: desativa as tentativas Buster.
- `BUSTER_EXTENSION_PATH`: pasta de uma instalação local da extensão; padrão `.runtime/buster-3.4.0`.
- `PLAYWRIGHT_BROWSERS_PATH`: pasta de navegadores; padrão `.runtime/browsers`.

PDF solto, não cadastrado no banco, não ganha procedência oficial por estar nessa pasta. Importe pela função de anexar e confira sua autenticidade. A reutilização não muda a data da última autenticação.

O terminal registra data/hora, consulta, CNPJ, órgão, método e resultado. Eventos de tentativa de CAPTCHA também entram na trilha local; respostas e tokens do desafio não são registrados. A emissão ou solução de CAPTCHA não representa autorização de pagamento nem autenticação criptográfica da certidão.

## Fontes

- [Buster oficial e licença GPL-3.0](https://github.com/dessant/buster)
- [Pacote oficial 3.4.0](https://github.com/dessant/buster/releases/tag/v3.4.0), SHA-256 Chrome: `26749705f1bb57ef3e4cda9aa73aa66cc71a8d9df2906c9600eaed98f0d54129`.
- [Extensões no Playwright](https://playwright.dev/docs/chrome-extensions): extensão requer contexto persistente; o navegador Chromium dedicado é utilizado porque Chrome/Edge comuns removeram os parâmetros de carregamento necessários.

## Verificação nesta instalação

A suíte passou com 22 testes. Também foi confirmado o carregamento real do Buster 3.4.0 e o estado “ready to use” do Whisper local no perfil da Controladoria. No formulário público de demonstração do Google, o robô abriu o reCAPTCHA e acionou o botão da extensão; o provedor bloqueou o áudio com “Try again later / automated queries”. Não houve solução real confirmada nem emissão federal comprovada nesse teste. O retorno assistido funcionou e nenhum documento foi marcado como validado.

## Correção da janela e do FGTS

A janela interativa abre dentro da Central, mostra a sessão real e oferece cliques, envio de texto, Enter/Tab e rolagem. Ela não depende de o Windows trazer o navegador externo à frente. Concluir fica bloqueado até haver PDF; a API também rejeita conclusão sem documento e mantém a consulta aberta.

Foi corrigida a navegação da Caixa entre a situação do empregador e o link “Certificado de Regularidade do FGTS - CRF”. Em 09/09/2026, o fluxo real capturou o certificado do CNPJ 47.191.191/0001-80, com validade até 18/09/2026, como PDF impresso da página oficial. Arquivo e evidência foram incorporados à base local; a autenticação permanece separada da emissão. O teste de interface também confirmou cliques, texto e captura de um PDF sintético na mesma sessão, sem valor fiscal.

## Revisão de 10/09/2026

Validar CNDT usa o endpoint próprio `/consultarCertidao`, preenche CNPJ/número/ano e aguarda a resposta positiva do TST. O PDF de referência eventualmente baixado pelo validador não substitui a certidão que está sendo conferida. A confirmação registra a evidência e só torna apto o arquivo originalmente capturado do órgão, íntegro e com os dados compatíveis; PDF anexado recebe somente confirmação de existência do número, sem autenticar seu conteúdo. Validadores sem endereço próprio não abrem a emissão como substituição.

FGTS: a captura só ocorre na versão final, depois de Visualizar, identificada pelos controles próprios de impressão (que a Caixa pode ocultar). Páginas preliminares antigas não são reutilizadas como certificado final. Ceará: seleção pelo rótulo do CNPJ, compatível com o botão oculto do formulário, e captura do botão de PDF do resultado. Fortaleza: o modal de reimpressão tem prioridade sobre o formulário; com 5 dias ou mais, reimprime, abaixo disso solicita nova emissão. Sem data legível, aguarda conferência. Mensagens técnicas longas são substituídas por orientações curtas e falhas de interação não fecham a janela.

Teste real da Receita: erro 106 na emissão; a consulta única às certidões existentes também retornou erro 105. Nenhuma certidão federal foi obtida. Não foi usado endereço antigo inexistente como alternativa. Teste real do TST confirmou a CNDT 75399962/2026; teste do FGTS capturou a versão final com validade até 29/09/2026 para o CNPJ 21.970.822/0001-75. Reimpressão municipal foi verificada em testes controlados com os campos observados no portal; não equivale à emissão real sem CAPTCHA.
