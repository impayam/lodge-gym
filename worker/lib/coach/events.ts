// The events of a streamed coach answer (SPEC-v9 M12), shared by the Worker and the chat.

/** One server-sent event of an answer. */
export type CoachEvent =
  | { type: "progress"; index: number; text: string }
  | { type: "text"; index: number; text: string }
  | { type: "tool"; id: string; name: string }
  | { type: "card"; message_id: string; tool_use_id: string; name: string; input: unknown; result: unknown; is_error: boolean }
  | { type: "saved"; message_id: string; role: "user" | "assistant" }
  | { type: "done"; cost_usd: number | null; model: string; omitted: number }
  | { type: "error"; code: string; message: string };
