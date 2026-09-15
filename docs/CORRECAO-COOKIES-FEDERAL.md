# Aviso de cookies da Receita Federal

Em 11/09/2026, foi observado no formulário oficial de CNPJ o aviso “utilizamos cookies”, com o botão “Aceitar” dentro de `#card0`. O clique fechou o aviso e deixou o formulário disponível, sem enviar identificadores ou solicitar uma certidão.

O motor de emissão agora resolve esse aviso antes de preencher o formulário ou acompanhar um pedido já enviado. A ação fica restrita ao host `servicos.receitafederal.gov.br`, ao cartão de cookies identificado e ao botão exato. Outros botões “Aceitar”, termos e desafios de segurança não são abrangidos. Se o aviso não fechar, a sessão informa a necessidade de intervenção, sem afirmar que houve emissão.

Testes sintéticos verificam o fechamento antes do preenchimento, a retomada sem emissão duplicada após um aviso tardio e a ausência de aceite em outros hosts. O fechamento no portal real foi observado; não foi obtida uma certidão federal real nesta verificação. Erros 105/106 e outros impedimentos do órgão continuam sendo tratados separadamente.

Para carregar a alteração em uma instalação já aberta, encerre o servidor com Ctrl+C na janela de inicialização e execute novamente `Iniciar-Central.cmd`. Em seguida, inicie uma nova consulta federal.
