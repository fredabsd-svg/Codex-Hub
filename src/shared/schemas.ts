/**
 * Schemas de runtime para TODO payload que atravessa o IPC.
 * O processo principal recusa qualquer chamada cujo payload não valide.
 */

import { z } from 'zod';
import { IPC_INVOKE_CHANNELS, type IpcInvokeChannel } from './ipc';

const voidish = z.union([z.undefined(), z.null(), z.void()]).transform(() => undefined);

const id = z.string().min(1).max(200);
const text = z.string().max(200_000);
const path = z.string().min(1).max(4096);
const url = z.string().min(1).max(2048);

const engineId = z.enum(['codex', 'direct']);
const mode = z.enum(['chat', 'plan', 'execute']);
const reasoningEffort = z.enum(['minimal', 'low', 'medium', 'high']);

const routing = z
  .object({
    order: z.array(z.string().max(120)).max(20).optional(),
    only: z.array(z.string().max(120)).max(20).optional(),
    ignore: z.array(z.string().max(120)).max(20).optional(),
    allowFallbacks: z.boolean().optional(),
    requireParameters: z.boolean().optional(),
    dataCollection: z.enum(['allow', 'deny']).optional(),
    sort: z.enum(['price', 'throughput', 'latency']).optional(),
    modelFallbacks: z.array(z.string().max(200)).max(10).optional(),
    maxPricePromptPerToken: z.number().nonnegative().optional(),
    maxPriceCompletionPerToken: z.number().nonnegative().optional(),
  })
  .strict();

const turnParameters = z
  .object({
    modelId: z.string().max(200).optional(),
    providerId: id.optional(),
    engineId: engineId.optional(),
    reasoningEffort: reasoningEffort.optional(),
    reasoningSummary: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
    personality: z.string().max(120).optional(),
    routing: routing.optional(),
    skillIds: z.array(id).max(50).optional(),
  })
  .strict();

const layout = z
  .object({
    sidebarWidth: z.number().min(180).max(560),
    sidebarCollapsed: z.boolean(),
    rightPanelWidth: z.number().min(280).max(1000),
    rightPanelCollapsed: z.boolean(),
    rightPanelTab: z.enum(['files', 'diff', 'output', 'context']),
  })
  .partial();

const settingsPatch = z
  .object({
    theme: z.enum(['dark', 'light', 'system']),
    fontScale: z.number().min(0.85).max(1.5),
    density: z.enum(['compact', 'comfortable']),
    reduceMotion: z.enum(['system', 'always', 'never']),
    sendWithEnter: z.boolean(),
    showReasoningSummaries: z.boolean(),
    chatWidth: z.enum(['comfortable', 'wide']),
    customInstructions: z.string().max(4000),
    defaultProviderId: id,
    defaultModelId: z.string().max(200),
    defaultEngineId: engineId,
    defaultReasoningEffort: reasoningEffort,
    defaultPersonality: z.string().max(120),
    defaultWorkspacePath: path,
    defaultMode: mode,
    approvalPolicy: z.enum(['always', 'onRequest', 'onFailure', 'never']),
    sandboxPolicy: z.enum(['readOnly', 'workspaceWrite', 'dangerFullAccess']),
    toolNetworkPolicy: z.enum(['blocked', 'workspaceAllowed', 'allowed']),
    startupBehavior: z.enum(['newConversation', 'lastConversation', 'home']),
    codexExecutablePath: z.string().max(4096),
    diagnosticsEnabled: z.boolean(),
    diagnosticsLogLevel: z.enum(['error', 'warn', 'info', 'debug']),
    developerMode: z.boolean(),
    demoMode: z.boolean(),
    attachmentMaxCount: z.number().int().min(1).max(200),
    attachmentMaxBytes: z.number().int().min(1024).max(512 * 1024 * 1024),
    toolMaxSteps: z.number().int().min(1).max(200),
    toolMaxDurationMs: z.number().int().min(1000).max(60 * 60 * 1000),
    toolMaxResultBytes: z.number().int().min(1024).max(8 * 1024 * 1024),
    layout,
  })
  .partial()
  .strict();

/** Nomes de cabeçalho aceitos em endpoints compatíveis. */
const headerName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/, 'Cabeçalho inválido')
  .refine((n) => !/^(host|content-length|connection|authorization|cookie)$/i.test(n), {
    message: 'Este cabeçalho é controlado pelo aplicativo.',
  });

export const IPC_SCHEMAS: { [C in IpcInvokeChannel]: z.ZodType } = {
  'app:getBootstrap': voidish,

  'settings:get': voidish,
  'settings:update': settingsPatch,

  'providers:list': voidish,
  'providers:connections': voidish,
  'providers:connect': z
    .object({ providerId: id, apiKey: z.string().min(1).max(4096).optional(), persist: z.boolean() })
    .strict(),
  'providers:disconnect': z.object({ providerId: id }).strict(),
  'providers:test': z.object({ providerId: id }).strict(),
  'providers:registerCompatible': z
    .object({
      label: z.string().min(1).max(80),
      baseUrl: url,
      apiKey: z.string().min(1).max(4096).optional(),
      persist: z.boolean(),
      headers: z.record(headerName, z.string().max(1024)).optional(),
    })
    .strict(),
  'providers:removeCompatible': z.object({ providerId: id }).strict(),
  'providers:usage': z.object({ providerId: id }).strict(),

  'catalog:list': z
    .object({ providerId: id, cursor: z.string().max(2048).optional(), forceRefresh: z.boolean().optional() })
    .strict(),
  'catalog:refresh': z.object({ providerId: id }).strict(),
  'catalog:addManualModel': z
    .object({ providerId: id, modelId: z.string().min(1).max(200), displayName: z.string().max(200).optional() })
    .strict(),
  'catalog:setFavorite': z
    .object({ providerId: id, modelId: z.string().min(1).max(200), favorite: z.boolean() })
    .strict(),
  'catalog:probeCapability': z
    .object({
      providerId: id,
      modelId: z.string().min(1).max(200),
      capability: z.enum(['toolCalling', 'imageInput', 'streaming']),
    })
    .strict(),

  'codex:runtime': voidish,
  'codex:locate': z.object({ executablePath: z.string().max(4096).optional() }).strict(),
  'codex:start': voidish,
  'codex:stop': voidish,
  'codex:account': voidish,
  'codex:loginStart': z
    .object({ method: z.enum(['chatgpt', 'deviceCode', 'apiKey']), apiKey: z.string().min(1).max(4096).optional() })
    .strict(),
  'codex:loginCancel': z.object({ loginId: id }).strict(),
  'codex:logout': voidish,
  'codex:rateLimits': voidish,
  'codex:skills': z.object({ workspacePath: path.optional() }).strict(),

  'conversations:list': z.object({ includeArchived: z.boolean().optional() }).strict(),
  'conversations:create': z
    .object({
      engineId,
      providerId: id,
      modelId: z.string().min(1).max(200),
      workspacePath: path.optional(),
      mode,
      title: z.string().max(200).optional(),
    })
    .strict(),
  'conversations:read': z.object({ conversationId: id }).strict(),
  'conversations:items': z
    .object({
      conversationId: id,
      limit: z.number().int().min(1).max(2000).optional(),
      beforeSeq: z.number().int().min(0).optional(),
    })
    .strict(),
  'conversations:rename': z.object({ conversationId: id, title: z.string().min(1).max(200) }).strict(),
  'conversations:archive': z.object({ conversationId: id }).strict(),
  'conversations:unarchive': z.object({ conversationId: id }).strict(),
  'conversations:delete': z.object({ conversationId: id }).strict(),
  'conversations:fork': z
    .object({
      conversationId: id,
      fromItemId: id.optional(),
      exclusive: z.boolean().optional(),
      title: z.string().max(200).optional(),
    })
    .strict(),
  'conversations:setFavorite': z.object({ conversationId: id, favorite: z.boolean() }).strict(),
  'conversations:search': z.object({ query: z.string().max(500), limit: z.number().int().min(1).max(200).optional() }).strict(),
  'conversations:export': z.object({ conversationId: id, format: z.enum(['markdown', 'json']) }).strict(),
  'conversations:saveDraft': z
    .object({ conversationId: id, text, attachmentIds: z.array(id).max(200) })
    .strict(),
  'conversations:readDraft': z.object({ conversationId: id }).strict(),
  'conversations:setParameters': z.object({ conversationId: id, parameters: turnParameters }).strict(),
  'conversations:setMode': z.object({ conversationId: id, mode }).strict(),
  'conversations:setWorkspace': z
    .object({ conversationId: id, workspacePath: z.union([path, z.null()]) })
    .strict(),

  'turn:send': z
    .object({
      conversationId: id,
      text,
      attachmentIds: z.array(id).max(200).optional(),
      parameters: turnParameters.optional(),
      asSteer: z.boolean().optional(),
    })
    .strict(),
  'turn:steer': z.object({ conversationId: id, text }).strict(),
  'turn:interrupt': z.object({ conversationId: id }).strict(),
  'turn:policy': z.object({ conversationId: id }).strict(),

  'approvals:pending': voidish,
  'approvals:resolve': z
    .object({
      approvalId: id,
      decision: z.enum(['allowOnce', 'allowForSession', 'deny', 'cancel']),
      note: z.string().max(2000).optional(),
    })
    .strict(),

  'workspaces:list': voidish,
  'workspaces:choose': voidish,
  'workspaces:register': z.object({ path }).strict(),
  'workspaces:remove': z.object({ id }).strict(),
  'workspaces:setFavorite': z.object({ id, favorite: z.boolean() }).strict(),
  'workspaces:git': z.object({ path }).strict(),
  'workspaces:gitChanges': z.object({ path }).strict(),
  'workspaces:fileTree': z.object({ path, maxEntries: z.number().int().min(1).max(20_000).optional() }).strict(),
  'workspaces:readFile': z
    .object({ workspacePath: path, filePath: path, maxBytes: z.number().int().min(1).max(8 * 1024 * 1024).optional() })
    .strict(),

  'attachments:choose': z.object({ conversationId: id }).strict(),
  'attachments:prepare': z.object({ conversationId: id, paths: z.array(path).min(1).max(200) }).strict(),
  'attachments:prepareFromPaths': z.object({ conversationId: id, paths: z.array(path).min(1).max(200) }).strict(),
  'attachments:prepareFromClipboardImage': z
    .object({
      conversationId: id,
      // ~48 MB de base64.
      base64: z.string().min(16).max(64 * 1024 * 1024),
      suggestedName: z.string().max(200).optional(),
    })
    .strict(),
  'attachments:discard': z.object({ conversationId: id, attachmentId: id }).strict(),

  'diagnostics:report': voidish,
  'diagnostics:export': voidish,
  'diagnostics:openLogFolder': voidish,

  'shell:openExternal': z.object({ url }).strict(),
  'shell:showItemInFolder': z.object({ path }).strict(),
  'clipboard:writeText': z.object({ text: z.string().max(1_000_000) }).strict(),
};

/** Garante em tempo de teste que nenhum canal ficou sem schema. */
export function missingSchemas(): string[] {
  return IPC_INVOKE_CHANNELS.filter((c) => !(c in IPC_SCHEMAS));
}

/**
 * Limites de frequência por canal (operações sensíveis).
 * `windowMs` / `max` — excedido, a chamada é recusada com código `validation`.
 */
export const IPC_RATE_LIMITS: Partial<Record<IpcInvokeChannel, { windowMs: number; max: number }>> = {
  'providers:connect': { windowMs: 60_000, max: 20 },
  'providers:test': { windowMs: 60_000, max: 30 },
  'providers:registerCompatible': { windowMs: 60_000, max: 10 },
  'catalog:refresh': { windowMs: 60_000, max: 20 },
  'catalog:probeCapability': { windowMs: 60_000, max: 10 },
  'codex:start': { windowMs: 60_000, max: 10 },
  'codex:loginStart': { windowMs: 60_000, max: 10 },
  'turn:send': { windowMs: 60_000, max: 120 },
  'attachments:prepare': { windowMs: 60_000, max: 120 },
  'attachments:prepareFromPaths': { windowMs: 60_000, max: 120 },
  'attachments:prepareFromClipboardImage': { windowMs: 60_000, max: 60 },
  'workspaces:readFile': { windowMs: 60_000, max: 600 },
  'workspaces:fileTree': { windowMs: 60_000, max: 120 },
  'shell:openExternal': { windowMs: 60_000, max: 30 },
  'diagnostics:export': { windowMs: 60_000, max: 5 },
  'conversations:export': { windowMs: 60_000, max: 20 },
};
