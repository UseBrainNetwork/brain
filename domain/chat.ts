/**
 * OpenAI-compatible chat shapes shared by the gateway, the engine and the upstream client.
 * Tool calling and structured output follow the Chat Completions wire format so agent frameworks
 * work unchanged against /v1.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  /** null is only valid for an assistant message that carries tool_calls. */
  content: string | null;
  /** Assistant messages: calls the model made. */
  tool_calls?: ToolCall[];
  /** Tool messages: which call this result answers. */
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
}

export type ToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

export type ResponseFormat = { type: "text" } | { type: "json_object" } | { type: "json_schema"; json_schema: { name: string; schema?: Record<string, unknown>; strict?: boolean; description?: string } };

/** Fields of a chat request that are forwarded verbatim to a capable provider. */
export interface ChatOptions {
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
  stop?: string[];
}

/** Characters of prompt the request represents, including tool schemas; used for size estimates. */
export function chatChars(messages: ChatMessage[], tools?: ToolDefinition[]): number {
  let n = 0;
  for (const m of messages) {
    n += (m.content ?? "").length;
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  }
  if (tools?.length) n += JSON.stringify(tools).length;
  return n;
}

/** Whether a request actually needs tool support from the executing provider. */
export const wantsTools = (tools?: ToolDefinition[], toolChoice?: ToolChoice) => Boolean(tools?.length) && toolChoice !== "none";
