# Instalação local da Central de Certidões no Windows

Este guia instala a Central separadamente em cada computador. Cada instalação consulta os portais no próprio computador e guarda seus PDFs e registros localmente.

## Requisitos

- Windows 11 (ou Windows Server 2019 ou posterior).
- Node.js 24 LTS para Windows x64, instalado a partir do site oficial.
- Acesso à internet na primeira instalação, para baixar as dependências Node.js e o Chromium do Playwright, e durante as consultas aos órgãos.
- Espaço livre em disco para o navegador e para os PDFs emitidos.
- Permissão para executar arquivos `.bat` e instalar o Node.js. Se a política da Prefeitura bloquear instalação, solicite à TI a instalação do Node.js.

Não é necessário instalar Git nem Google Chrome. A Central usa um Chromium próprio. O CAPTCHA, quando solicitado pelo portal, deve ser resolvido manualmente na janela do Chromium.

## 1. Preparar uma cópia limpa do sistema

O código atual está em:

```text
C:\Users\Geral\Documents\ChatGPT\CENTRAL DAS CERTIDÕES
```

Distribua uma cópia aprovada dessa versão por uma pasta interna autorizada ou mídia institucional. Em cada computador, extraia/copie para uma pasta local, por exemplo:

```text
C:\Sistemas\CentralCertidoes
```

Não execute a aplicação a partir de pendrive, pasta de rede ou pasta sincronizada pelo OneDrive. Para evitar compartilhar dados locais de teste, não inclua na cópia de distribuição as pastas `.git`, `node_modules`, `.runtime`, `data`, `tmp` ou `output`, nem arquivos `.env`. Preserve os arquivos `package.json` e `package-lock.json` e o restante do código, incluindo `INICIAR-CENTRAL.bat`, `server.js`, `interface-api.js`, `automation`, `config`, `lib`, `public` e `scripts`.

## 2. Instalar Node.js

1. Acesse [nodejs.org/download](https://nodejs.org/en/download/).
2. Baixe a versão **LTS** para Windows x64, formato instalador `.msi`.
3. Execute o instalador e mantenha as opções padrão, incluindo adicionar Node.js ao `PATH`.
4. Feche e abra novamente o Prompt de Comando (CMD).
5. Digite estas linhas, uma por vez:

```cmd
node --version
npm --version
```

O primeiro comando deve mostrar uma versão `v24.x`. O segundo deve mostrar a versão do npm. Se algum comando não for reconhecido, reinicie o computador e tente novamente; se persistir, peça à TI para verificar a instalação e o `PATH`.

## 3. Iniciar pela primeira vez

1. No Explorador de Arquivos, abra `C:\Sistemas\CentralCertidoes`.
2. Dê duplo clique em `INICIAR-CENTRAL.bat`.
3. Na primeira execução, aguarde: o iniciador instala as dependências e baixa o Chromium. Não feche a janela preta durante esse processo.
4. Quando aparecer a mensagem de endereço local, abra no navegador:

```text
http://127.0.0.1:3031/central-certidoes.html
```

5. Deixe a janela do terminal aberta enquanto usa a Central. Fechá-la encerra o servidor local.
6. Durante uma consulta, mantenha aberta também a janela do Chromium da Central. Se o órgão apresentar CAPTCHA, resolva-o manualmente nessa janela e retorne à Central para continuar.

O iniciador configura o servidor para aceitar conexões somente do próprio computador. Não é preciso abrir a porta 3031 no roteador ou no Firewall do Windows.

## 4. Como usar depois

Em cada dia de uso:

1. Abra `C:\Sistemas\CentralCertidoes`.
2. Execute `INICIAR-CENTRAL.bat`.
3. Abra `http://127.0.0.1:3031/central-certidoes.html`.
4. Ao terminar, volte à janela preta e pressione `Ctrl+C`.

Se o endereço apresentar “recusou a conexão”, normalmente a janela do iniciador foi fechada ou o servidor não iniciou. Abra o `.bat` e leia a mensagem de erro nessa janela.

## 5. Onde ficam os documentos e dados

Os PDFs e o índice do arquivo ficam, por padrão, em:

```text
%LOCALAPPDATA%\CentralCertidoes
```

Os logs e dados auxiliares ficam na pasta `data` da instalação. Faça cópias de segurança das duas localizações para um destino institucional protegido. Não envie PDFs de certidões ou logs por e-mail pessoal ou links públicos.

## 6. Atualizar a aplicação

1. Pare o servidor com `Ctrl+C`.
2. Faça backup da pasta `data` e de `%LOCALAPPDATA%\CentralCertidoes`.
3. Instale a nova versão em uma pasta temporária ou substitua somente os arquivos de programa, preservando os dados locais.
4. Execute novamente `INICIAR-CENTRAL.bat`. Ele verifica e instala dependências e Chromium se estiverem ausentes.
5. Confirme a abertura da interface e faça uma consulta de teste autorizada.

## Limite das instalações locais

As instalações em computadores diferentes são independentes: empresas, histórico, logs e PDFs de um computador não aparecem automaticamente nos outros. Para compartilhar um histórico único seria necessário um serviço central com armazenamento e controle de acesso, o que não faz parte desta instalação local.

## Problemas comuns

- **`node` ou `npm` não reconhecido:** instale o Node.js LTS, reinicie o CMD e confira `node --version` e `npm --version`.
- **Falha baixando dependências ou Chromium:** confirme que o computador tem internet e que a rede institucional permite downloads do npm e do Playwright. Não desative o antivírus; peça à TI para analisar o bloqueio.
- **Porta 3031 já em uso:** feche a outra janela da Central que esteja aberta e tente novamente.
- **Portal exige CAPTCHA:** a pessoa deve resolver o desafio na janela visível do Chromium. A Central não deve contornar verificações humanas.
- **PDF não aparece no histórico:** verifique a mensagem da consulta e os diretórios de dados acima antes de repetir a emissão.
