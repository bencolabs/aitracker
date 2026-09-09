/** Server composition entry point. Provider adapters are injected by the host. */
export type { AIOrchestrationPorts } from "./contracts.ts";
export {
  chatHeaders,
  chatUrl,
  modelRequestUrl,
  modelListUrl,
  parseChatCompletion,
  requestBody,
  type ChatRequestBodyOptions,
  type ChatResponseClassification,
  type ClassifiedChatResponse,
} from "./model-profile.server.ts";
export {
  CLAUDE_CODE_DEFAULT_TIMEOUT_MS,
  CLAUDE_CODE_PROVIDER_ID,
  ClaudeCodeInvocationError,
  createClaudeCodeProvider,
  probeClaudeCodeAvailability,
  stripCodeFence,
  type ClaudeCodeProviderOptions,
} from "./infrastructure/claude-code-provider.server.ts";
