# Codex Hub

Aplicativo desktop (Windows) para **conversar, programar, analisar arquivos e
executar tarefas** usando vários modelos e provedores. O OpenRouter é cidadão de
primeira classe desde a v1 e funciona **sem o Codex instalado**; o Codex App
Server é o motor de execução de tarefas quando estiver disponível na máquina.

> Estado desta versão: `0.1.0`. O que está implementado e validado, o que está
> implementado sem validação externa, o que está bloqueado pelo ambiente e o que
> é roadmap está listado em [Situação por recurso](#situação-por-recurso).

---

## Três caminhos, um aplicativo

| Caminho | Para que serve | Precisa de quê |
| --- | --- | --- |
| **OpenRouter (direto)** | Conversa com streaming, catálogo amplo, ferramentas estruturadas, histórico | Uma chave de API do OpenRouter |
| **Codex App Server** | Execução real de tarefas pelo runtime oficial, com sandbox e aprovações | Codex CLI instalado na máquina |
| **Endpoint compatível** | Ollama, LM Studio ou gateways próprios que implementem Chat Completions | A URL base do serviço |

O aplicativo separa **provedor** (quem faz a inferência) de **motor** (quem
conduz a conversa, as ferramentas, as permissões e a execução). Trocar de modelo
não muda a interface; trocar de motor muda o que é possível fazer — e isso é
mostrado explicitamente, nunca prometido de forma genérica.

## Requisitos

- Windows 10/11 x64 para uso final (o desenvolvimento também roda em Linux/macOS).
- Node.js ≥ 20.19 e npm 10 para desenvolver.
- Opcional: Codex CLI, para o motor Codex.
- Opcional: Git no PATH, para o painel de alterações. Sem Git o aplicativo
  continua funcionando e diz que o Git está indisponível.

## Instalação e execução (desenvolvimento)

```bash
npm install
npm run dev          # hot reload do renderer, restart do processo principal
```

Verificações:

```bash
npm run verify       # typecheck (main + renderer) + lint + testes
npm run test         # 376 testes unitários, de integração e de renderer
npm run test:e2e     # fluxos no Electron (requer `npm run build` antes)
npm run test:live    # somente com credencial real; ignorado sem as variáveis
```

Distribuição:

```bash
npm run dist:win     # instalador NSIS + executável portable (x64)
npm run dist:dir     # empacota sem instalador (verificação de empacotamento)
```

Os artefatos ficam em `release/<versão>/`:

- `Codex Hub-0.1.0-x64.exe` — instalador NSIS (permite escolher a pasta, cria
  atalhos, e **não** apaga os dados do usuário ao desinstalar);
- `Codex Hub-0.1.0-portable.exe` — executável portable;
- `win-unpacked/` — a árvore do aplicativo, útil para inspeção.

Nada é assinado por padrão: assinatura exige um certificado próprio. Sem ela, o
Windows mostra o aviso do SmartScreen na primeira execução.

Em Linux é possível gerar os artefatos do Windows com Wine instalado
(`wine` + `wine32`); é assim que os `.exe` desta versão foram produzidos. A
instalação em si só pode ser verificada no Windows.

## Primeiro uso

1. Abra o aplicativo. A tela inicial oferece os três caminhos, com o OpenRouter
   em primeiro lugar.
2. Cole a chave do OpenRouter. Ela vai para o processo principal, é testada e —
   se você pedir — guardada no armazenamento protegido do sistema. **A chave
   nunca volta para a interface**: o renderer só recebe estado e uma
   representação mascarada.
3. Escolha um modelo no catálogo (busca por nome ou ID exato, com preço, janela
   de contexto e capacidades).
4. Opcional: vincule um workspace (Ctrl+O) para habilitar os modos Planejar e
   Executar.

## Novidades da versão 0.2

- **Visão geral** com conversas recentes, projetos, conexões e sugestões para
  revisar código, planejar mudanças, criar testes e entender um projeto.
  As sugestões preenchem um rascunho para você editar antes de enviar.
- **Busca nesta conversa (Ctrl+F)** com prévia, teclado e navegação até a
  mensagem encontrada, inclusive em históricos longos.
- **Histórico completo sob demanda**: carregue mensagens anteriores sem
  perder a posição de leitura; respostas em andamento continuam preservadas.
- **Layout adaptável**: cabeçalho com título e controles organizados; painel
  de contexto acessível como diálogo em janelas menores.
- **Envio mais confiável**: bloqueio de envios simultâneos, preservação do
  próximo rascunho, cancelamento durante a conexão e títulos personalizados
  respeitados desde a primeira mensagem.

## No dia a dia

- **Paleta (Ctrl+K)** — ações com atalho visível, ações da conversa atual
  (modo, interromper, favoritar, ramificar, exportar, arquivar), conversas,
  **busca no conteúdo das mensagens**, modelos e workspaces.
- **Exportar** — cada conversa pode ser salva em Markdown ou JSON, ou copiada
  como Markdown (menu `⋯` no cabeçalho, botão direito na barra lateral ou pela
  paleta). Uso e custo só aparecem quando o provedor informou; estimativas são
  rotuladas.
- **Editar e reenviar** — em uma mensagem sua, cria uma ramificação que termina
  antes dela e coloca o texto no composer. A conversa original fica intacta.
- **Totais** — tokens e custo da conversa na barra de status e em
  *Painel de contexto › Contexto*, com a ocupação da janela de contexto.
- **Blocos de código** — realce de sintaxe local (sem HTML), numeração de
  linhas, quebra de linha e copiar.
- **Configurações › Conversa** — Enter envia (Shift+Enter quebra linha),
  resumos de raciocínio, largura de leitura e **instruções personalizadas**
  anexadas ao prompt do motor direto.
- **Configurações › Aparência** — tamanho da interface (zoom real da janela),
  densidade, tema e redução de movimento.

## Atalhos

| Atalho | Ação |
| --- | --- |
| `Ctrl+N` | Nova conversa |
| `Ctrl+K` | Paleta de comandos e busca (alterna) |
| `Ctrl+F` | Buscar nesta conversa |
| `Ctrl+O` | Escolher workspace |
| `Ctrl+Shift+O` | Anexar arquivos |
| `Ctrl+Enter` | Enviar (ou `Enter`, com a preferência ligada) |
| `Ctrl+,` | Configurações |
| `Ctrl+B` / `Ctrl+J` | Recolher barra lateral / painel direito |
| `Esc` | Fecha menus e diálogos. Só interrompe o turno quando nada está aberto. |

Com um diálogo aberto, os atalhos globais ficam inativos (exceto `Ctrl+K` e
`Esc`). Nada é enviado enquanto há composição de texto por IME em andamento.
A lista completa fica em *Configurações › Atalhos*.

## Onde ficam os dados

Tudo em `app.getPath('userData')` e `app.getPath('logs')` — **nunca** dentro do
diretório de instalação nem do ASAR:

- `data/` — conversas, itens, rascunhos, workspaces, preferências e cache do
  catálogo, em um arquivo transacional append-only com compactação atômica.
- `logs/` — registros com rotação (2 MB × 5) e redação de segredos.
- Segredos ficam **fora** desses arquivos: vão para o armazenamento protegido do
  sistema (`safeStorage`). Quando a proteção não está disponível, a chave vale
  apenas para a sessão e **não é gravada em texto puro** — o aplicativo avisa.

## Situação por recurso

| Recurso | Situação |
| --- | --- |
| OpenRouter: credencial, catálogo, streaming, interrupção, custo relatado | **implementado sem validação externa** (sem conta real neste ambiente; catálogo público verificado em execução) |
| Endpoint compatível: descoberta, streaming, ferramentas, aprovação, diff | **implementado e validado** (end-to-end contra servidor local nos testes) |
| Motor direto: ciclo completo de ferramentas, limites, aprovações | **implementado e validado** |
| Codex App Server: handshake, correlação de IDs, eventos, aprovações, reinício | **implementado sem validação externa** (Codex CLI ausente no ambiente; coberto por transporte falso) |
| Tipos gerados do protocolo Codex (`npm run codex:types`) | **bloqueado pelo ambiente** — os tipos em `src/generated/codex` são provisórios e o protocolo **não** é considerado validado por causa deles |
| Instalador Windows (NSIS) e executável portable x64 | **implementado sem validação externa** — os dois `.exe` são gerados por `npm run dist:win`; a instalação em uma máquina Windows real não foi executada aqui |
| Execução de shell arbitrário no motor direto | **roadmap** — indisponível até haver isolamento efetivo; as ferramentas estruturadas continuam |
| MCP / plugins | **roadmap** — nada é mostrado como conectado |
| Atualização automática | **roadmap** — base preparada, desativada nesta versão |

Detalhes e evidências: [TESTING.md](TESTING.md) e [PROVIDERS.md](PROVIDERS.md).

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md) — processos, camadas, protocolos, persistência.
- [SECURITY.md](SECURITY.md) — credenciais, IPC, caminhos, aprovações, conteúdo não confiável.
- [PROVIDERS.md](PROVIDERS.md) — matriz real de capacidades, versões e fontes consultadas.
- [TESTING.md](TESTING.md) — o que é testado, como rodar, o que exige credencial real.

## Licença

MIT.
