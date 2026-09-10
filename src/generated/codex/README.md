# Tipos do Codex App Server

Este diretório recebe os tipos **gerados pela versão do Codex instalada na máquina**:

```bash
npm run codex:types
# equivale a: codex app-server generate-ts --out ./src/generated/codex
```

## Situação neste repositório

O comando **não foi executado** no ambiente onde este código foi escrito: o
Codex CLI não está instalado lá. Portanto:

- `provisional.ts` contém tipos **provisórios**, isolados neste diretório;
- `VERSION` registra `provisorio` em vez de uma versão real;
- o aplicativo **não considera o protocolo validado** por causa desses tipos.
  `CodexRuntimeInfo.generatedTypesAreProvisional` é `true` e a interface mostra
  isso em Configurações › Codex e no diagnóstico exportado.

## O que fazer ao rodar em uma máquina com o Codex

1. Instale o Codex CLI e confirme com `codex --version`.
2. Rode `npm run codex:types`.
3. Confira o conteúdo gerado e **substitua** os usos de `provisional.ts` pelos
   tipos reais nos módulos de `src/main/codex/`.
4. Grave a versão usada em `VERSION` (o script de geração costuma sobrescrever
   este diretório inteiro; nesse caso, recrie o `VERSION` com a saída de
   `codex --version`).

## Por que o código não depende desses tipos hoje

`src/main/codex/parse.ts` lê os payloads de forma defensiva, tentando os
aliases plausíveis de cada campo e devolvendo `undefined` quando nada
corresponde. Isso permite conversar com versões diferentes do App Server sem
inventar campos — e sem fingir que o protocolo foi verificado.

Quando um método não existe na versão instalada, o servidor responde
`-32601 method not found`; o cliente traduz isso para um estado
**indisponível com motivo concreto** na interface, em vez de erro genérico.
