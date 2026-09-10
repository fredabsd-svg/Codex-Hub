# Provedores, motores e capacidades reais

Este documento registra **o que foi implementado**, **o que foi verificado** e
**contra o quê**. Ele distingue três coisas que costumam ser confundidas:

1. **Catálogo declarado** — o que o provedor diz sobre um modelo.
2. **Integração implementada** — o que este aplicativo sabe fazer com aquilo.
3. **Combinação validada** — o que foi efetivamente exercido em execução.

Uma capacidade tem três estados (**suportado**, **não suportado**,
**desconhecido**) e uma procedência (**declarado**, **testado**, **inferido**).
Desconhecido é mostrado como desconhecido. **Preço ausente não significa
gratuito** — aparece como "Não informado".

---

## 1. Provedores

### OpenRouter (`openrouter`)

- Base: `https://openrouter.ai/api/v1`
- Autenticação: chave de API (`Authorization: Bearer …`), enviada **somente** do
  processo principal.
- Endpoints usados:

  | Endpoint | Uso no aplicativo |
  | --- | --- |
  | `GET /models` | catálogo: ID exato, nome, modalidades, janela de contexto, limite de saída, parâmetros suportados, preços |
  | `GET /key` | teste de credencial, rótulo e limites |
  | `GET /credits` | crédito e uso acumulado, quando a credencial tem acesso |
  | `POST /chat/completions` | conversa com `stream: true` (SSE) |

- Roteamento: `provider.order`, `only`, `ignore`, `allow_fallbacks`,
  `data_collection`, `sort`, `max_price`; e `models` para fallback de modelo.
  **Fallbacks só são enviados quando a pessoa autoriza explicitamente.**
- Uso e custo: mostrados **apenas** com dado oficial. O custo relatado pelo
  provedor é rotulado como relatado; qualquer valor calculado localmente é
  rotulado como estimativa.
- Documentação consultada (setembro de 2026):
  - `https://openrouter.ai/docs/api_reference/overview`
  - `https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties`
  - `https://openrouter.ai/docs/guides/features/tool-calling`
  - `https://openrouter.ai/docs/guides/routing/provider-selection`

### Endpoint compatível (`compatible:*`)

- Qualquer serviço que implemente `POST {base}/chat/completions` no formato da
  OpenAI. Descoberta de modelos só acontece se `GET {base}/models` responder em
  um formato reconhecível; caso contrário o aplicativo diz isso e permite
  informar um ID manualmente (marcado como **não verificado**).
- HTTP em texto claro é permitido **apenas** para hosts locais
  (`127.0.0.1`, `localhost`, `::1`).
- Alvos típicos: Ollama (`http://127.0.0.1:11434/v1`), LM Studio
  (`http://127.0.0.1:1234/v1`), gateways próprios.
- Capacidades começam **desconhecidas** e só mudam diante de evidência.

### Codex (`codex`)

Não é um provedor HTTP: é o runtime oficial acessado pelo App Server. O modelo é
escolhido dentro do catálogo que o próprio Codex reporta (`model/list`).

---

## 2. Motores

| | Motor direto | Motor Codex |
| --- | --- | --- |
| Conversa com streaming | sim | sim |
| Ferramentas estruturadas | sim (`list_files`, `read_file`, `search_content`, `apply_file_changes`, `git_status`, `git_diff`) | conduzidas pelo Codex |
| Execução de comandos arbitrários | **não** — desabilitada até haver isolamento verificado | sim, com sandbox e aprovações do Codex |
| Aprovações | fila local, com diff antes de gravar | requisições iniciadas pelo servidor, respondidas no id original |
| Orientação no meio do turno (steer) | não | sim (`turn/steer`) |
| Skills | não | `skills/list` |
| Requisito | uma chave de API | Codex CLI instalado |

`ENGINE_CAPABILITIES.direct.taskExecution` é declarado **não suportado**, com o
motivo, e a interface mostra isso.

---

## 3. Matriz de capacidades

Como cada capacidade é decidida:

| Capacidade | OpenRouter | Endpoint compatível | Codex |
| --- | --- | --- | --- |
| Conversa | **suportado** (declarado: consta do catálogo de chat) | **suportado** (declarado: expõe `/chat/completions`) | **suportado** (declarado) |
| Streaming | **suportado** (declarado) | **desconhecido** até o primeiro uso | **suportado** (eventos do App Server) |
| Entrada de imagem | do catálogo: `image` nas modalidades → suportado; modalidades presentes sem `image` → não suportado; sem modalidades → **desconhecido** | **desconhecido** (o endpoint não informa) | conforme o modelo reportado pelo Codex |
| Chamada de ferramentas | `tools` em `supported_parameters` → suportado; parâmetros presentes sem `tools` → não suportado; sem parâmetros → **desconhecido** | **desconhecido** — há um botão "Verificar suporte a ferramentas" que faz uma requisição mínima e registra o resultado como **testado** | conduzido pelo Codex |
| Execução de tarefas | **não suportado** no motor direto (motivo declarado) | **não suportado** no motor direto | **suportado** |
| Esforço de raciocínio | `reasoning`/`include_reasoning` nos parâmetros | **desconhecido** | níveis reportados pelo Codex |

Uma falha de rede ou de limite de taxa **nunca** é convertida em
"incompatibilidade": `ModelCatalog.applyErrorObservation` ignora esses casos.

---

## 4. O que foi validado, e como

| Combinação | Situação | Evidência |
| --- | --- | --- |
| Endpoint compatível + motor direto: descoberta, streaming, conclusão, persistência | **implementado e validado** | `tests/e2e/conversation.spec.ts` contra servidor HTTP local do próprio teste |
| Endpoint compatível + motor direto: ciclo completo de ferramenta (`apply_file_changes`), aprovação, gravação, diff | **implementado e validado** | `tests/e2e/tools.spec.ts` |
| Parser SSE (comentários, fragmentação, erro no meio, tool deltas, cancelamento) | **implementado e validado** | `tests/unit/chatCompletions.test.ts`, `tests/unit/streams.test.ts` |
| OpenRouter: leitura do catálogo público, normalização de preços e capacidades | **implementado e validado** | catálogo real carregado em execução (435 modelos) nos testes de interface; `tests/unit/catalog.test.ts` |
| OpenRouter: credencial, streaming autenticado, crédito, custo relatado | **implementado sem validação externa** | sem conta real neste ambiente. `tests/live/openrouter.live.test.ts` existe e é **ignorado explicitamente** sem `OPENROUTER_API_KEY` |
| Codex App Server: handshake, correlação, eventos, aprovações, reinício com backoff, encerramento da árvore | **implementado sem validação externa** | Codex CLI ausente no ambiente. Coberto por transporte falso em `tests/integration/codexClient.test.ts` e `tests/integration/codexEngine.test.ts` |
| Tipos gerados do protocolo Codex | **bloqueado pelo ambiente** | `npm run codex:types` exige o Codex instalado. `src/generated/codex/VERSION` contém `provisorio` e o aplicativo **não** considera o protocolo validado |

### Procedência dos nomes de método do Codex

Os identificadores em `src/main/codex/methods.ts` seguem a documentação pública
do App Server (`https://learn.chatgpt.com/docs/app-server`). Eles são o que o
aplicativo **tenta** usar — não são prova de que a versão instalada os
implementa. Quando o servidor responde `-32601 method not found`, o recurso é
marcado como indisponível **com motivo concreto**, e não como erro genérico.
Notificações desconhecidas são ignoradas com registro em modo desenvolvedor;
nenhum evento é inventado para preencher a interface.

---

## 5. Versões usadas

| Componente | Versão |
| --- | --- |
| Electron | 38.8.6 |
| Node (build) | ≥ 20.19 (verificado em 22.x) |
| React | 19.3.0 |
| Vite / electron-vite | 7.3.6 / 5.0.0 |
| Tailwind CSS | 4.3.3 |
| Zod | 4.6.1 |
| Zustand | 5.0.15 |
| Monaco Editor | 0.56.0 |
| Vitest / Playwright | 3.2.7 / 1.63.0 |
| electron-builder | 26.15.3 |
| Codex App Server | **não verificado** — nenhuma versão foi usada neste repositório |

---

## 6. O que este aplicativo não afirma

- Não promete compatibilidade universal com "qualquer endpoint compatível":
  promete o que `GET /models` e `POST /chat/completions` entregarem, e diz
  quando não entregam.
- Não converte ausência de preço em "grátis".
- Não mostra saldo, gasto ou tokens sem dado oficial do provedor.
- Não apresenta plugins ou MCP como conectados: eles são roadmap e nada é
  exibido como operacional.
- Não declara o protocolo do Codex validado por causa de tipos provisórios.
