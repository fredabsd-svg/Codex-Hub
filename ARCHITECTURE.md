# Arquitetura

## Visão geral

Três processos, com fronteiras claras:

```
┌──────────────────────────── processo principal (Node) ────────────────────────────┐
│  IPC guard  ·  serviços  ·  motores  ·  provedores  ·  ferramentas  ·  persistência │
│  Tudo que é privilegiado mora aqui: rede autenticada, disco, processos filhos.      │
└───────────────▲───────────────────────────────────────────────────────────────────┘
                │ canais tipados, validados por schema, com limite de tamanho e taxa
┌───────────────┴─── preload (contextBridge, sem Node no renderer) ─────────────────┐
│  Superfície mínima: `invoke` em lista fixa + assinatura de eventos.                │
└───────────────▲───────────────────────────────────────────────────────────────────┘
                │ window.codexHub
┌───────────────┴─── renderer (React 19, sandbox, sem nodeIntegration) ─────────────┐
│  Estado de interface (Zustand), componentes, i18n pt-BR, Monaco sob demanda.       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

O renderer **nunca** fala com um provedor, com o Codex ou com o disco. Ele pede,
o processo principal decide.

## Diretórios

```
src/
  main/
    codex/         cliente do Codex App Server (JSONL, handshake, eventos, processo)
    engines/       ExecutionEngine: DirectEngine e CodexEngine
    providers/     ModelProvider: OpenRouter, endpoint compatível, catálogo, HTTP
    tools/         ferramentas estruturadas, aprovações e diff
    ipc/           lista de canais, validação e registro dos handlers
    services/      conversas, credenciais, workspaces, anexos, Git, logs, diagnóstico
    persistence/   store transacional, migrações e repositórios
    context.ts     composição das dependências
    window.ts      janela, CSP, bloqueio de navegação e de novas janelas
    main.ts        ciclo de vida do aplicativo
  preload/         ponte segura (contextBridge)
  shared/          tipos de domínio, contrato de IPC, schemas zod, erros, capacidades
  generated/codex/ tipos do protocolo Codex (provisórios neste repositório)
  renderer/        interface
tests/             unit, integration, renderer, e2e (Playwright) e live
```

## Abstrações centrais

| Abstração | Onde | Responsabilidade |
| --- | --- | --- |
| `ModelProvider` | `main/providers/types.ts` | Descobrir modelos, testar credencial, transmitir a conversa, relatar uso |
| `ExecutionEngine` | `main/engines/types.ts` | Conduzir o turno: abrir conversa, executar, orientar, interromper, declarar política |
| `ModelCatalog` | `main/providers/ModelCatalog.ts` | Cache com data de busca, atualização manual, modelos manuais, observações testadas |
| `CredentialStore` | `main/services/CredentialStore.ts` | Guardar segredos por provedor, mascarar, isolar |
| `ConversationRepository` | `main/persistence/repositories.ts` | Conversas, itens, rascunhos, workspaces, preferências |
| `WorkspaceService` | `main/services/WorkspaceService.ts` | Raízes autorizadas, resumo Git, registro |
| `ApprovalBroker` | `main/tools/ApprovalBroker.ts` | Fila de aprovações, escopo de sessão, heurística de risco |

Provedor e motor são combináveis: o `DirectEngine` roda sobre qualquer
`ModelProvider`; o `CodexEngine` roda sobre o Codex App Server. A interface
mostra a combinação ativa e o que ela permite.

## Fluxo de um turno

1. O renderer chama `turn:send`. O guard valida remetente, schema, tamanho e taxa.
2. `ConversationService` tira um **snapshot** da conversa (workspace, modo,
   parâmetros): trocar o workspace na interface depois disso não redireciona o
   turno em andamento.
3. A mensagem do usuário é **persistida e anunciada** antes de qualquer chamada
   externa — ela aparece na conversa mesmo que o provedor demore ou falhe.
4. O motor executa. Todo evento passa por um `TurnSink` que persiste e emite:
   `item/started`, `item/textDelta`, `item/completed`, `turn/completed`,
   `approval/requested`, `diff/updated`, `policy/effective`…
5. Cada evento leva um `seq` por conversa. O renderer detecta lacunas e avisa
   "eventos incompletos" em vez de fingir estado completo.

### Motor direto (`DirectEngine`)

Ciclo completo de ferramentas: pedido → montagem da chamada **completa** →
validação dos argumentos por schema → autorização → execução → registro →
retorno ao modelo → continuação até concluir ou bater um limite.

- Argumentos parciais recebidos por streaming **nunca** são executados: a
  chamada só é montada quando o provedor sinaliza que terminou.
- Ferramentas com efeito colateral não são repetidas automaticamente após falha
  de rede ou reinício (`retryableAfterFailure: false`).
- Cada passo tem uma chave de idempotência (`<turnId>-<passo>`), então uma
  reconexão não gera duas cobranças do mesmo passo.
- O conjunto de ferramentas por modo é imposto **no backend** (`allowedModes`),
  não pelo texto do prompt.
- Execução de comandos arbitrários está **indisponível** neste motor até existir
  isolamento efetivo. As ferramentas estruturadas continuam.

Ferramentas: `list_files`, `read_file`, `search_content`, `apply_file_changes`,
`git_status`, `git_diff`.

### Motor Codex (`CodexEngine`)

Processo filho do Codex CLI, protocolo JSON-RPC sobre JSONL no stdio.

- **Handshake obrigatório**: `initialize` → aguardar resposta → `initialized`.
  Só então qualquer outra operação. O handshake é refeito a cada nova conexão.
- Correlação por ID com timeout; respostas de uma conexão antiga são rejeitadas
  por um contador de geração.
- Requisições iniciadas pelo servidor (aprovações) são respondidas **no id
  original**.
- stdout carrega protocolo; stderr é diagnóstico e passa por redação.
- Buffer incremental UTF-8: linhas fragmentadas, LF/CRLF, várias mensagens por
  chunk e limite de tamanho de linha.
- Reinício com backoff progressivo e limite de tentativas, seguido de
  reconciliação **sem repetir operações mutáveis**.
- Encerramento por árvore de processos, com caminho específico para Windows
  (`taskkill /T /F`).

Os nomes de métodos usados estão em `main/codex/methods.ts`, com a procedência
documentada. `-32601 method not found` vira "recurso ausente nesta versão", com
motivo concreto na interface — nunca um erro genérico.

## Streaming HTTP (provedores)

`providers/chatCompletions.ts` implementa o parser SSE:

- ignora comentários (`: ...`) e keep-alives;
- lida com fragmentação arbitrária de chunks e com várias mensagens por chunk;
- trata erro entregue **dentro** do stream (mapeando status quando existe);
- acumula `tool_calls` por índice e só emite quando a chamada está completa;
- timeout de inatividade e cancelamento por `AbortSignal` (`finish: cancelled`).

`providers/http.ts` segue redirecionamentos manualmente e **recusa** repassar a
credencial para outra origem. HTTP em texto claro só é permitido para serviços
locais.

## Persistência

Arquivo transacional append-only em `<userData>/data`:

- cada transação é delimitada por um marcador `{"k":"txn","n":N}`; blocos
  incompletos e caudas truncadas são descartados na abertura;
- compactação atômica: escreve em `.tmp`, `fsync`, `rename`;
- migrações versionadas em `persistence/migrations.ts`;
- na abertura, itens que ficaram `pending`/`streaming` são marcados como
  cancelados com a nota "Nada foi executado novamente por conta própria" e as
  conversas voltam para ocioso.

Não usamos SQLite: seria um módulo nativo a mais para empacotar e reconstruir
por arquitetura. O custo é não ter SQL — as consultas do aplicativo são simples
e indexadas em memória.

## Interface

- React 19 + Tailwind 4 com tokens em CSS custom properties (`styles/global.css`).
- Zustand para estado; seletores devolvem referências estáveis (v5 compara por
  identidade — criar objetos no seletor causa re-render infinito).
- Monaco carregado sob demanda a partir de `editor.api` com os contribs
  necessários e **um** worker, para não inflar o pacote.
- Markdown renderizado sem `dangerouslySetInnerHTML`, com lista de protocolos
  permitidos em links.
- Tudo em pt-BR em `i18n/pt-BR.ts`, pronto para tradução.

## Atualizações

A base do electron-builder está preparada (`publish: null`), mas a atualização
automática está **desativada** nesta versão. Habilitar exige definir um destino
de publicação, assinar os artefatos e testar o canal — nada disso foi feito
aqui, e o aplicativo não afirma o contrário.
