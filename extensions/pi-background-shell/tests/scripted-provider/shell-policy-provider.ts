import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type TranscriptContext,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model,
  type TextContent,
  type ToolCall,
} from '@earendil-works/pi-ai';

const PROVIDER = 'pi-bg-shell-policy';
const MODEL_ID = 'shell-policy-model';
const API = 'pi-bg-shell-policy-api';
const DEFAULT_USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type JsonObject = Record<PropertyKey, unknown>;
type ScriptedBlock = TextContent | ToolCall;
type ScriptedAssistantMessage = Omit<AssistantMessage, 'content' | 'stopReason'> & {
  content: ScriptedBlock[];
  stopReason: 'stop' | 'toolUse';
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: JsonObject): void {
  const path = process.env['PI_BG_SHELL_POLICY_EVENTS'];
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function guidanceFrom(description: string): JsonObject | undefined {
  const match = /Shell executable: ("(?:\\.|[^"\\])*"); args: (\[[^\n]*?\]); command syntax: ([^.]+)\./u.exec(description);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return undefined;
  return { executable: JSON.parse(match[1]), args: JSON.parse(match[2]), syntax: match[3] };
}

function messageText(message: unknown): string {
  if (!isObject(message)) return '';
  const content = message['content'];
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part: unknown) =>
            isObject(part) && typeof part['text'] === 'string'
              ? part['text']
              : isObject(part) && typeof part['type'] === 'string'
                ? part['type']
                : '',
          )
          .join(' ')
      : '';
}

function latestBgRunTask(context: TranscriptContext): JsonObject | undefined {
  const result = context.messages
    .filter(
      (message) =>
        message.role === 'toolResult' && 'toolName' in message && message.toolName === 'bg_run',
    )
    .at(-1);
  if (result === undefined || !('details' in result) || !isObject(result.details)) return undefined;
  return isObject(result.details['task']) ? result.details['task'] : undefined;
}

function text(value: string): TextContent {
  return { type: 'text', text: value };
}

function toolCall(command: string): ToolCall {
  return {
    type: 'toolCall',
    id: 'shell-policy-bg-run',
    name: 'bg_run',
    arguments: {
      name: 'Shell Policy Witness',
      command,
      notifyOnCompletion: false,
      triggerOnCompletion: false,
    },
  };
}

function assistant(
  content: ScriptedBlock[],
  stopReason: 'stop' | 'toolUse',
): ScriptedAssistantMessage {
  return {
    role: 'assistant',
    content,
    api: API,
    provider: PROVIDER,
    model: MODEL_ID,
    usage: DEFAULT_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function pushMessage(
  stream: AssistantMessageEventStream,
  message: ScriptedAssistantMessage,
): void {
  const partial: AssistantMessage = { ...message, content: [], stopReason: 'pending' };
  stream.push({ type: 'start', partial: { ...partial } });
  message.content.forEach((block, contentIndex) => {
    if (block.type === 'text') {
      const partialText: TextContent = { type: 'text', text: '' };
      partial.content = [...partial.content, partialText];
      stream.push({ type: 'text_start', contentIndex, partial: { ...partial } });
      partialText.text = block.text;
      stream.push({ type: 'text_delta', contentIndex, delta: block.text, partial: { ...partial } });
      stream.push({ type: 'text_end', contentIndex, content: block.text, partial: { ...partial } });
      return;
    }
    if (block.type !== 'toolCall') return;
    const partialTool: ToolCall = { ...block, arguments: {} };
    partial.content = [...partial.content, partialTool];
    stream.push({ type: 'toolcall_start', contentIndex, partial: { ...partial } });
    const json = JSON.stringify(block.arguments);
    stream.push({ type: 'toolcall_delta', contentIndex, delta: json, partial: { ...partial } });
    partialTool.arguments = block.arguments;
    stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: { ...partial } });
  });
  stream.push({ type: 'done', reason: message.stopReason, message });
  stream.end(message);
}

export default function shellPolicyProvider(pi: ExtensionAPI): void {
  let calls = 0;
  pi.registerProvider(PROVIDER, {
    name: 'Shell Policy Scripted Provider',
    baseUrl: 'http://localhost:0',
    apiKey: 'PI_BG_SHELL_POLICY_API_KEY',
    api: API,
    models: [
      {
        id: MODEL_ID,
        name: 'Shell Policy Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 1024,
      },
    ],
    streamSimple(_model: Model<Api>, context: TranscriptContext): AssistantMessageEventStream {
      calls += 1;
      const prompt = getCurrentSystemPrompt(context.messages);
      const tools = getCurrentTools(context.messages);
      const declaration = tools.find((tool) => tool.name === 'bg_run');
      const guidance = guidanceFrom(declaration?.description ?? '');
      const task = latestBgRunTask(context);
      record({
        call: calls,
        guidance,
        noSystemInjection: !/pi_background_shell_policy|activation shell policy|Shell executable:/.test(prompt),
        tools: tools.map((tool) => tool.name).sort(),
        description: declaration?.description,
        parameters: declaration?.parameters,
        peerGuidance: prompt.includes('peer system guidance survives'),
        taskShellPolicy: task?.['shellPolicy'],
        taskId: task?.['id'],
        taskOutputPath: task?.['outputPath'],
        toolResult: context.messages.map(messageText).at(-1),
      });

      let message: ScriptedAssistantMessage;
      if (calls === 1 && guidance?.['syntax'] === 'inherited shell (not classified as Bash or POSIX)') {
        message = assistant([toolCall('shell_policy_probe Ω with spaces')], 'toolUse');
      } else if (calls === 1 && guidance?.['syntax'] === 'Bash') {
        message = assistant(
          [toolCall(`printf '%s\\n' 'real bash selected Ω with spaces'`)],
          'toolUse',
        );
      } else if (calls === 1) {
        message = assistant([text('Shell policy declaration was unavailable or unexpected.')], 'stop');
      } else {
        message = assistant([text('Shell policy launch receipt observed.')], 'stop');
      }

      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => pushMessage(stream, message));
      return stream;
    },
  });
}
