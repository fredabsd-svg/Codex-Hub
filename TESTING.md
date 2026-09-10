# Testes e verificação visual

```bash
npm run verify     # typecheck (main + renderer) + lint + testes
npm run test       # Vitest: unit + integração + renderer  (376 testes)
npm run build      # typecheck + build de produção (necessário antes do e2e)
npm run test:e2e   # Playwright + Electron (20 testes)
npm run dist:dir   # empacota; habilita o teste do aplicativo empacotado
npm run test:live  # somente com credencial real (ver abaixo)
```

Em ambiente sem display gráfico:

```bash
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test
```

---

## 1. Transporte mockado é obrigatório

Nenhum teste da suíte padrão fala com um provedor real ou com uma conta real.
Os dublês ficam em `tests/helpers/`:

| Helper | Substitui |
| --- | --- |
| `fakeCodexTransport.ts` | o processo do Codex App Server (stdio JSONL), com controle de fragmentação e de morte do processo |
| `fakeFetch.ts` | respostas HTTP e streams SSE, inclusive fragmentados e com erro no meio |
| `recordingSink.ts` | o `TurnSink`, registrando a ordem exata dos eventos do turno |
| `fakeBridge.ts` | a ponte `window.codexHub` no renderer, com falhas programáveis |

Os testes e2e de conversa e de ferramentas sobem um **servidor HTTP local do
próprio teste** que implementa `/v1/models` e `/v1/chat/completions` com SSE.
Nada sai da máquina.

## 2. Cobertura por área

### Protocolo e transporte (`tests/unit`, `tests/integration`)

- `streams.test.ts` — parser JSONL e parser SSE: linha fragmentada em vários
  chunks, várias mensagens em um chunk, LF e CRLF, UTF-8 partido no meio de um
  caractere, comentário SSE, keep-alive, limite de tamanho de linha.
- `protocol.test.ts` — classificação e codificação das mensagens do App Server
  (o campo `jsonrpc` **não** vai na linha).
- `codexClient.test.ts` — handshake obrigatório antes de qualquer operação;
  operações emitidas antes do `initialized` ficam na fila; correlação de ID com
  timeout; **requisições iniciadas pelo servidor** respondidas no id original;
  morte do processo; reinício com backoff e limite; respostas de uma conexão
  antiga rejeitadas por geração; **nada mutável é reexecutado** na reconciliação.
- `chatCompletions.test.ts` — deltas de texto, acumulação de `tool_calls` por
  índice com emissão só quando completa, erro entregue dentro do stream, uso
  reportado, cancelamento por `AbortSignal` (`finish: cancelled`), timeout de
  inatividade.

### Catálogo e parâmetros (`catalog.test.ts`)

Normalização de modelos, preços com unidade explícita, **preço ausente ≠
grátis**, capacidades tri-estado com procedência, cache com data de busca e
fallback avisado, modelos manuais marcados como não verificados, filtro de
parâmetros não suportados no corpo da requisição, e a regra de que erro de rede
ou de limite de taxa **não** vira incompatibilidade.

### Ferramentas e aprovações (`tools.test.ts`, `approvals.test.ts`, `directEngine.test.ts`)

Ciclo completo com aprovação, com recusa e com cancelamento; argumentos inválidos
recusados pelo schema; **argumentos parciais nunca executados**; ferramenta com
efeito colateral não repetida após falha; limite de passos e de duração;
restrição de modo imposta no backend (ferramenta de escrita indisponível fora do
modo Executar, mesmo que o modelo peça); string de comando em resposta do modelo
**não** vira execução; escopo de sessão estreito; padrão destrutivo não aprovável
em lote.

### Caminhos, IPC e segredos

- `pathSafety.test.ts` — travessia `..`, symlink apontando para fora, caminho
  inexistente dentro da raiz, diferença de caixa, nome reservado do Windows,
  byte nulo.
- `ipcGuard.test.ts` — remetente não autorizado recusado, payload fora do schema
  recusado, limite de frequência, erro serializado sem stack e sem segredo.
- `redact.test.ts` — chaves de vários formatos, cabeçalho `Authorization`, campos
  nomeados, query string, **payload de erro** e objetos `Error` aninhados.

### Persistência (`store.test.ts`, `persistence.test.ts`)

Transação incompleta descartada na abertura, cauda truncada ignorada, rollback
por replay, compactação atômica, migrações versionadas e recuperação após queda:
itens `pending`/`streaming` viram cancelados com a nota de que nada foi
reexecutado por conta própria.

### Interface (`tests/renderer`)

Inicialização e erro de inicialização com ação; onboarding com o OpenRouter em
primeiro lugar; streaming aplicado a partir de eventos reais; **Ctrl+Enter envia
uma vez, não duas**; IME não envia durante composição; navegação por teclado na
paleta e no catálogo; fila de aprovação; Markdown sem HTML bruto e com
protocolos restritos; diff.

`improvements.test.tsx` cobre as regressões das melhorias: foco inicial dos
diálogos no campo de busca (não no botão "Fechar"); atalhos globais inativos com
um diálogo aberto; paleta pesquisando no conteúdo das mensagens e mostrando
atalhos; Enter envia só com a preferência ligada (Shift+Enter quebra linha);
rascunho gravado ao desmontar; exclusão com diálogo de confirmação próprio;
totais de tokens e custo no painel de contexto. `highlight.test.tsx` garante que
o realce de sintaxe nunca perde texto nem interpreta HTML.

### Exportação e título (`conversationExport.test.ts`)

Markdown com cabeçalho, mensagens, uso por turno e totais (estimativa sempre
rotulada, custo ausente nunca vira zero), cercas de código maiores do que as
internas, JSON com formato declarado, nome de arquivo seguro e derivação do
título a partir da primeira mensagem (sem marcação, cortado em palavra).

### Fluxos no Electron (`tests/e2e`)

| Arquivo | O que exercita |
| --- | --- |
| `app.spec.ts` | abre sem o Codex instalado, onboarding, configurações, paleta, catálogo, barra de status, capturas em 1280×720/1440×900/1920×1080 e em janela estreita, ausência de rolagem horizontal, encerramento |
| `conversation.spec.ts` | cadastra endpoint compatível, escolhe modelo descoberto, envia, vê o streaming e a conclusão, recarrega e reabre a conversa persistida |
| `tools.spec.ts` | workspace, anexo, modo Executar, chamada de ferramenta com argumentos fragmentados, aprovação (**nada gravado antes de aprovar**), aplicação e diff |
| `packaged.spec.ts` | aplicativo **empacotado** (ASAR): interface monta, dados do usuário fora do ASAR e do diretório de instalação, renderer sem `require` e sem `ipcRenderer` |

## 3. Testes com credencial real

`tests/live/openrouter.live.test.ts` roda **apenas** por `npm run test:live` e
**apenas** quando `OPENROUTER_API_KEY` e `OPENROUTER_LIVE_MODEL` estão definidos.

- Sem essas variáveis os testes são **ignorados explicitamente**, com aviso no
  console. Isso **não** conta como aprovação.
- Se a conta não tiver saldo ou acesso ao modelo, a falha é reportada como
  falha. Nada é maquiado.

Nunca coloque credenciais em arquivos versionados. Use variáveis de ambiente na
sessão do terminal.

## 4. Verificação visual

Renderizar em jsdom **não** aprova acabamento visual. A verificação visual é
feita com capturas do aplicativo real, produzidas pelos testes e2e em
`test-results/capturas/`:

| Captura | Tela |
| --- | --- |
| `onboarding.png` | escolha do caminho inicial |
| `layout-1280x720.png`, `layout-1440x900.png`, `layout-1920x1080.png` | conversa vazia nas três resoluções |
| `layout-estreito.png` | janela estreita: painéis secundários recolhidos, composer preservado |
| `composer-preenchido.png`, `streaming.png`, `conversa-concluida.png`, `conversa-apos-recarga.png` | envio, streaming, conclusão com tokens e persistência |
| `catalogo.png` | catálogo com ID exato, preço com unidade e capacidades |
| `paleta.png` | paleta de comandos |
| `configuracoes-codex.png` | diagnóstico do Codex ausente, com ação concreta |
| `anexos.png` | anexo no composer |
| `aprovacao.png` | fila de aprovação com diff proposto e as decisões possíveis |
| `diff.png` | painel de alterações depois de aplicar |

O teste também falha se o corpo da página rolar horizontalmente em qualquer uma
das três resoluções.

Problemas encontrados **nessa inspeção** e corrigidos: quebra de linha do estado
da conexão em janela estreita; rótulo do workspace cortado pelo atalho embutido;
mensagem e ação de erro coladas sem separação; nome do modelo sumindo no
cabeçalho quando o painel direito abre; atalho duplicado na paleta; aprovação
cuja área de decisão ficava abaixo da dobra; painel de alterações que trocava de
aba sem abrir.

## 5. Limites conhecidos da suíte

- Sem conta real do OpenRouter, o caminho autenticado (streaming com chave,
  crédito, custo relatado) fica **implementado sem validação externa**.
- Sem o Codex CLI, o motor Codex é exercitado apenas com transporte falso, e os
  tipos do protocolo continuam provisórios.
- `packaged.spec.ts` verifica o pacote gerado nesta máquina (árvore Linux com o
  mesmo ASAR). O instalador NSIS e o portable do Windows **são gerados** por
  `npm run dist:win` — inclusive em Linux com Wine — mas instalar e executar em
  uma máquina Windows real não foi feito aqui.
