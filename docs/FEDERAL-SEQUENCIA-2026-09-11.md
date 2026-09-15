# Sequência da Receita e bloqueio da Caixa — 11/09/2026

## Atualização após orientação do usuário

O fluxo ativo foi alterado para: preencher CNPJ → Emitir Certidão → aceitar o aviso de cookies quando aparecer → Emitir Nova Certidão → capturar PDF. A preparação inicial apenas aguarda o formulário; não aceita cookies antes do primeiro envio. A confirmação de nova emissão aguarda o aviso de cookies fechar e o botão ficar habilitado. A consulta automática de segunda via descrita no histórico abaixo deixou de ser chamada pelo motor de emissão. As esperas de 30 segundos na preparação e 60 segundos por etapa continuam. O reaproveitamento de PDFs já armazenados na Central permanece inalterado.

O teste de regressão verifica a ordem exata dos três cliques, ausência de consulta de segunda via e ausência de envios duplicados. Isso não comprova emissão real na Receita.

## Histórico da investigação anterior

O log da Central mostrou envio de Emitir às 16:42:33 UTC, resposta HTTP 400 e aceite de cookies às 16:42:34 UTC. O aviso resultante foi 023. A ordem incorreta está comprovada; o significado interno do código 023 e sua causa exclusiva não foram confirmados.

## Correções

- Receita: aguarda pelo menos 8 segundos de carregamento inicial, verifica campo e botão disponíveis, aceita o aviso de cookies e exige 1,5 segundo de disponibilidade contínua. Se não ficar pronta em 30 segundos, suspende o envio nessa sessão.
- Cada etapa federal enviada tem limite de 60 segundos; o robô suspende o próximo comando quando o prazo termina e não repete pedidos automaticamente.
- Diante de Certidão Válida Encontrada, consulta o período exibido pelo portal e solicita segunda via de uma linha identificada como Válida com pelo menos 5 dias restantes. CNPJ divergente, datas inválidas ou falta de resultado elegível exigem conferência. A seleção considera os resultados da página exibida; não afirma ter percorrido todas as páginas.
- Caixa: a mensagem de comportamento malicioso suspende a sessão e a interação, sem converter o bloqueio em diagnóstico fiscal ou tentar contornar o controle.
- O robô continua sem janela externa e usa o painel da Central.

## Verificação real e limites

No navegador de inspeção, em segundo plano, o formulário federal aceitou o CNPJ digitado sequencialmente, apresentou Certidão Válida Encontrada, abriu a consulta e listou certidões vigentes. Ao solicitar a segunda via com validade até 04/10/2026, o portal confirmou “A segunda via da certidão foi emitida com sucesso”. Não foram alterados tokens, desafios de segurança ou configurações para ocultar automação.

Essa confirmação do portal não comprova que o PDF tenha sido persistido na base da Central. O teste de inspeção usa uma sessão diferente do robô da aplicação. A captura e a persistência pelo fluxo da Central foram verificadas com PDFs fictícios; ainda é necessário confirmar o documento real na instalação em uso. A imagem enviada pelo usuário confirma bloqueio da Caixa, mas não identifica conclusivamente qual sinal causou o bloqueio.
