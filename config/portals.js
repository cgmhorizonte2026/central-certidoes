module.exports = [
  {
    "key": "federal",
    "name": "Certidão Federal",
    "shortName": "Federal",
    "url": "https://servicos.receitafederal.gov.br/servico/certidoes/",
    "verifyUrl": "https://solucoes.receita.fazenda.gov.br/Servicos/certidao/certaut/NIAutentic.asp?origem=pj",
    "humanCaptcha": "required",
    "captchaTimeout": 600000,
    "preActions": [
      {
        "name": "Abrir emissão",
        "selectors": [
          "text=Iniciar"
        ]
      },
      {
        "name": "Selecionar Pessoa Jurídica",
        "selectors": [
          "text=Pessoa Jurídica"
        ]
      }
    ],
    "selectors": {
      "cnpj": [
        "input[name=\"cnpj\"]",
        "input[id*=\"cnpj\" i]",
        "input[placeholder*=\"CNPJ\" i]",
        "input[name*=\"cpfcnpj\" i]"
      ]
    },
    "beforeCaptchaActions": [
      {
        "name": "Emitir Certidão",
        "selectors": [
          "button:has-text(\"Emitir Certidão\")",
          "a:has-text(\"Emitir Certidão\")",
          "input[type=button][value*=\"Emitir Certidão\" i]",
          "input[type=submit][value*=\"Emitir Certidão\" i]",
          "text=Emitir Certidão",
          "text=Emitir certidão"
        ],
        "waitMs": 2500
      }
    ],
    "afterCaptchaActions": [
      {
        "name": "Emitir certidão",
        "selectors": [
          "text=Emitir Certidão",
          "text=Emitir certidão",
          "text=Emitir"
        ],
        "captureDownload": true,
        "downloadTimeout": 30000,
        "waitMs": 2200
      }
    ],
    "downloadButtons": [
      "text=Baixar",
      "text=Download",
      "text=Imprimir",
      "text=Certidão",
      "text=Gerar"
    ]
  },
  {
    "key": "fgts",
    "name": "CRF — FGTS",
    "shortName": "FGTS",
    "url": "https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf",
    "verifyUrl": "https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf",
    "selectors": {
      "cnpj": [
        "input[id*=\"inscricao\" i]",
        "input[name*=\"inscricao\" i]",
        "input[maxlength=\"14\"]",
        "input[maxlength=\"18\"]",
        "input[name*=\"cnpj\" i]",
        "input[id*=\"cnpj\" i]",
        "input[placeholder*=\"CNPJ\" i]"
      ]
    },
    "afterCaptchaActions": [
      {
        "name": "Consultar FGTS",
        "selectors": [
          "text=Consultar",
          "input[type=\"submit\"]"
        ],
        "waitMs": 1800
      }
    ],
    "downloadButtons": [
      "text=Visualizar",
      "text=Imprimir",
      "text=Certificado",
      "text=Consultar"
    ]
  },
  {
    "key": "trabalhista",
    "name": "Certidão Trabalhista",
    "shortName": "Trabalhista",
    "url": "https://cndt-certidao.tst.jus.br/gerarCertidao",
    "verifyUrl": "https://www.tst.jus.br/certidao1",
    "selectors": {
      "cnpj": [
        "#cpfCnpj"
      ]
    },
    "afterCaptchaActions": [
      {
        "name": "Emitir CNDT",
        "selectors": [
          "#botao-emitir"
        ],
        "captureDownload": true,
        "downloadTimeout": 30000,
        "waitMs": 1000
      }
    ],
    "downloadButtons": []
  },
  {
    "key": "estadual-ce",
    "name": "Certidão Estadual — Ceará",
    "shortName": "Estadual CE",
    "url": "https://consultapublica.sefaz.ce.gov.br/certidaonegativa/preparar-consultar",
    "verifyUrl": "https://consultapublica.sefaz.ce.gov.br/certidaonegativa/preparar-consultar",
    "selectors": {
      "cnpj": [
        "input[name=\"codigoDevedor\"]",
        "input#codigoDevedor"
      ]
    },
    "afterCaptchaActions": [],
    "downloadButtons": [
      "a:has(img[src*=\"pdf\" i])",
      "button:has(img[src*=\"pdf\" i])",
      "img[src*=\"pdf\" i]",
      "a[title*=\"PDF\" i]",
      "button[title*=\"PDF\" i]",
      "a[aria-label*=\"PDF\" i]",
      "button[aria-label*=\"PDF\" i]",
      "mat-icon:has-text(\"picture_as_pdf\")",
      ".material-icons:has-text(\"picture_as_pdf\")",
      "text=picture_as_pdf",
      "text=PDF",
      "text=Imprimir",
      "text=Baixar",
      "text=Download",
      "text=Emitir"
    ],
    "preActions": [
      {
        "name": "Selecionar CNPJ",
        "selectors": [
          "input#cnpj[type=\"radio\"]"
        ],
        "waitMs": 500,
        "required": true
      }
    ],
    "beforeCaptchaActions": [
      {
        "name": "Pesquisar",
        "selectors": [
          "button:has-text(\"Pesquisar\")",
          "input[value=\"Pesquisar\"]"
        ],
        "waitMs": 1500
      }
    ]
  }
];
