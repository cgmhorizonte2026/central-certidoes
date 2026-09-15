# Roteamento de Horizonte e navegação municipal

O cadastro do CNPJ já determina UF e código IBGE, confrontados com a base municipal. O diretório seleciona o emissor estadual pela UF e o municipal pelo código IBGE.

Em 15/09/2026, a página oficial https://www.horizonte.ce.gov.br/servicos.php vinculava os serviços tributários a servicos2.speedgov.com.br. O link de contribuinte redirecionou para https://tributario.speedgov.com.br/horizonte/servicos. O diretório agora abre https://tributario.speedgov.com.br/horizonte/servicos/certidoes e mantém o vínculo de validação publicado pela prefeitura. Somente os hosts identificados foram adicionados.

A navegação reconhece também Emitir certidões, Emissão de certidão, Certidões, Emitir CND e Serviços Tributários. Continua excluindo opções imobiliárias e de validação no fluxo de emissão.

O portal distingue contribuinte, estabelecimento e imóvel. Não foi emitida certidão real nesta alteração. A necessidade de inscrição municipal, CAPTCHA ou seleção adicional depende do serviço. A emissão integral de todos os municípios e estados permanece não homologada; um portal identificado não comprova autenticidade ou regularidade.

Testes sintéticos verificam seleção por IBGE, substituição de descoberta antiga, hosts exatos e navegação até preenchimento e envio único do CNPJ.
