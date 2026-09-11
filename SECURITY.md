# Segurança

Este documento descreve o que o Codex Hub **faz**, e também o que ele
**deliberadamente não faz**. Onde uma garantia depende de um componente externo,
isso está dito de forma explícita — o aplicativo não promete interceptar tudo.

## Credenciais

**Cada credencial pertence ao provedor que a emitiu.**

- Uma chave do OpenRouter **nunca** é enviada ao fluxo de login por chave da
  OpenAI usado pelo Codex, e vice-versa. Os campos são separados na interface e
  o aviso está escrito ao lado deles.
- Assinatura do ChatGPT **não** é tratada como crédito de OpenRouter nem de
  qualquer outra API. São coisas distintas e aparecem separadas.
- A credencial de um provedor **nunca** é reaproveitada ao testar uma URL
  diferente. Cada endpoint compatível registrado tem o próprio segredo.

### A chave do OpenRouter entregue ao processo do Codex

Existe **uma** situação em que um segredo sai do processo principal: quando a
pessoa liga, explicitamente, "usar o OpenRouter como provedor do Codex"
(Configurações › Codex; desligado por padrão). Regras dessa entrega:

- a chave vai para o processo filho em **variável de ambiente**
  (`OPENROUTER_API_KEY`), que é o mecanismo previsto pelo próprio Codex para
  provedores declarados em `model_providers`;
- **nunca** vai em argumento de linha de comando — argumentos são visíveis na
  lista de processos do sistema. Há teste garantindo que nenhum argumento
  montado contém a chave;
- **nunca** vai pelo fluxo `account/login/start` com método `apiKey`: aquele
  campo é a chave da OpenAI usada pelo Codex e continua separado;
- o destino é o mesmo serviço que emitiu a credencial (openrouter.ai). Isso não
  é reaproveitar a chave de um provedor em outro;
- o trecho de `config.toml` que a interface exibe contém apenas o **nome** da
  variável de ambiente, nunca o segredo;
- a partir do momento em que a chave está no processo do Codex, o que ele faz
  com ela é responsabilidade dele — este aplicativo não intercepta as conexões
  de outro runtime, e diz isso na tela.

### Armazenamento

- Segredos que a pessoa escolher salvar vão para o armazenamento protegido do
  sistema, via `safeStorage` do Electron (DPAPI no Windows).
- **Quando a proteção não está disponível, o segredo não é gravado.** Ele vale
  para a sessão e o aplicativo mostra um aviso permanente explicando o motivo e
  o que fazer.
- Segredos **não** entram em: estado persistido do Zustand, `localStorage`,
  banco de preferências, logs, URLs, argumentos de processo ou arquivos
  versionados.
- Depois de conectar, o renderer recebe apenas: estado da conexão, identificador
  da credencial e uma representação mascarada (`sk-or-…abc1`).

### Redação

`main/services/redact.ts` cobre padrões conhecidos (`sk-or-v1-…`, `sk-ant-…`,
`sk-proj-…`, `sk-…`, `gh*_…`, `AIza…`, JWT), cabeçalhos `Authorization`, campos
nomeados (`api_key`, `token`, `secret`…) e strings de consulta — além dos
segredos registrados em runtime. A redação é aplicada em **logs, payloads de
erro e diagnóstico**, recursivamente, inclusive dentro de objetos `Error`.

O diagnóstico exportável passa pela mesma redação e pode ser revisado antes de
ser compartilhado.

## Processo, IPC e renderer

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- O preload expõe uma superfície mínima: `invoke` restrito a uma **lista fixa**
  de canais e assinatura de eventos. Não há `ipcRenderer`, `require`, execução
  de shell, leitura irrestrita de arquivos nem encaminhamento arbitrário de
  métodos do App Server.
- Cada handler passa pelo guard (`main/ipc/guard.ts`):
  1. remetente autorizado (janela principal, frame principal, origem esperada);
  2. schema zod `.strict()` por canal, validado em runtime;
  3. limite de frequência nos canais sensíveis (ex.: `turn:send` 120/min,
     `providers:connect` 20/min, `catalog:probeCapability` 10/min);
  4. erro serializado em pt-BR, com ação concreta e sem segredos.
- Resposta sempre no envelope `{ ok, data | error }`: o renderer nunca recebe uma
  stack do processo principal.
- CSP de produção sem `unsafe-eval`; navegação e criação de janelas bloqueadas;
  nenhum conteúdo remoto privilegiado; nada de `eval`.
- Markdown, saída de ferramentas, nomes de arquivo e respostas de modelos são
  tratados como **conteúdo não confiável**: renderização sem HTML bruto e
  links restritos a protocolos permitidos.

## Caminhos e workspaces

`main/services/pathSafety.ts` **não** compara prefixos de texto. Cada caminho é:

1. normalizado e resolvido para absoluto;
2. resolvido fisicamente (`realpath`) até o ancestral existente mais profundo —
   o que neutraliza symlinks, junctions e reparse points do Windows;
3. comparado com o `realpath` da raiz autorizada via `path.relative`, com
   comparação insensível a caixa no Windows.

Também são recusados: caminhos com byte nulo e nomes reservados do Windows
(`CON`, `PRN`, `LPT1`…).

Escrever fora das raízes autorizadas exige consentimento explícito (registro de
uma raiz adicional em Configurações › Workspaces).

## Git

O acesso é **somente leitura**: estado e diff. O aplicativo **não** faz commit,
reset, checkout ou limpeza automática. Sem Git no PATH, o painel diz que o Git
está indisponível e o restante continua funcionando.

## Anexos

- Arquivos são copiados para `<workspace>/.codex-hub/anexos`, com nome
  sanitizado, sem conflito, sem travessia de caminho e sem nome reservado.
- **Imagem é imagem pelo conteúdo**, não pela extensão: os bytes iniciais são
  verificados e um arquivo cuja extensão não corresponde é recusado.
- PDF, DOCX, XLSX, CSV, TXT e código-fonte **não** são imagens. Quando a
  extração de texto falha, o aplicativo diz que falhou e sugere OCR — nunca
  finge que leu conteúdo binário.
- Um caminho local **não** dá acesso a um provedor remoto: para o motor direto,
  o conteúdo precisa ser embutido; para o Codex, o caminho é entregue ao runtime
  que roda na mesma máquina. A diferença é mostrada na interface.
- Nada é executado, e o workspace inteiro **não** é enviado automaticamente.

## Aprovações e políticas

- Fila central mostrando ação, diretório, motivo, arquivos afetados e destinos de
  rede, com o **diff proposto** antes de qualquer gravação.
- O risco é apresentado como **heurística local identificada**, com a base do
  cálculo — não como garantia.
- Decisões possíveis conforme o que a solicitação realmente aceita: permitir uma
  vez, permitir na sessão, recusar, cancelar. O escopo de sessão é estreito e
  descrito na própria tela.
- Operações identificadas como destrutivas **não** podem ser aprovadas em lote
  para a sessão e nunca são aprovadas automaticamente.
- No Codex, aprovações são **requisições iniciadas pelo servidor** e são
  respondidas no id original.
- Rede da **API de inferência** e rede das **ferramentas do agente** são coisas
  diferentes e ambas aparecem com o estado efetivo. Quando o motor não confirma
  a política, a interface diz "solicitada", não "aplicada"
  (`EffectivePolicy.confirmedByRuntime`).
- Padrões nunca desabilitam proteções nem concedem acesso total para contornar
  falhas de implementação.

## Limitações declaradas

- **Execução de comandos arbitrários no motor direto está indisponível.** Só
  será habilitada depois de existir um mecanismo de isolamento efetivo e
  verificado. Até lá, as ferramentas estruturadas cobrem o que é possível fazer
  com segurança. O aplicativo **não** chama validação de caminhos de "sandbox do
  sistema operacional".
- O aplicativo **não** promete interceptar toda conexão ou toda alteração feita
  por um motor externo: o que o Codex faz dentro do próprio sandbox é
  responsabilidade do Codex, e isso está dito na interface.
- Os artefatos de distribuição **não são assinados** por padrão. Assinatura exige
  um certificado próprio; sem ela, o Windows mostrará o aviso do SmartScreen.
- Os tipos do protocolo Codex neste repositório são **provisórios**. Isso não
  torna o protocolo validado — ver `src/generated/codex/README.md`.

## Como relatar um problema

Abra uma issue com passos de reprodução e o diagnóstico exportado
(Configurações › Diagnóstico). O diagnóstico já vem redigido; revise antes de
anexar.
