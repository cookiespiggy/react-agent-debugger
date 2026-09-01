/**
 * A stand-in LLM for exercising replay without spending money or holding an
 * API key.
 *
 *   npm run mock:llm                       # listens on :4010
 *   REPLAY_LLM_BASE_URL=http://localhost:4010/v1 \
 *   REPLAY_LLM_API_KEY=mock npm run dev
 *
 * It implements just enough behaviour to make forks demonstrable:
 *   - first turn            -> calls a tool
 *   - tool failed           -> retries (reproducing the original loop)
 *   - two failures          -> gives up, same as the recorded run
 *   - tool succeeded        -> answers immediately
 *
 * So replaying a retry-storm trace unchanged reproduces the storm, while
 * overriding that one tool result makes the replay finish in two steps. That
 * contrast is the whole point of forking.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_LLM_PORT ?? 4010);

interface WireMessage {
  role: string;
  content?: string | null;
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });

  req.on("end", () => {
    let parsed: { model?: string; messages?: WireMessage[]; tools?: unknown[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }

    const messages = parsed.messages ?? [];
    const model = parsed.model ?? "mock-model";
    const tools = (parsed.tools ?? []) as { function?: { name?: string } }[];
    const toolName = tools[0]?.function?.name ?? "mock_tool";

    const toolMessages = messages.filter((m) => m.role === "tool");
    const last = toolMessages[toolMessages.length - 1];
    const failedCount = toolMessages.filter((m) =>
      String(m.content ?? "").startsWith("Error:"),
    ).length;

    let message: Record<string, unknown>;
    let finishReason: string;

    if (toolMessages.length === 0) {
      message = {
        role: "assistant",
        content: "Thought: I need to look this up before answering.",
        tool_calls: [
          {
            id: `call_mock_${toolMessages.length + 1}`,
            type: "function",
            function: { name: toolName, arguments: "{}" },
          },
        ],
      };
      finishReason = "tool_calls";
    } else if (String(last?.content ?? "").startsWith("Error:")) {
      if (failedCount >= 2) {
        message = {
          role: "assistant",
          content: `I could not complete the ${toolName} lookup after ${failedCount} attempts. Escalating to a human.`,
        };
        finishReason = "stop";
      } else {
        message = {
          role: "assistant",
          content: `Thought: that attempt failed. Retrying ${toolName}.`,
          tool_calls: [
            {
              id: `call_mock_${toolMessages.length + 1}`,
              type: "function",
              function: { name: toolName, arguments: "{}" },
            },
          ],
        };
        finishReason = "tool_calls";
      }
    } else {
      message = {
        role: "assistant",
        content: "Got the result I needed. Here is the answer.",
      };
      finishReason = "stop";
    }

    const promptTokens = 800 + toolMessages.length * 450;

    const body = {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 96,
        // Deliberately reported via completion_tokens_details, the shape
        // o-series / GPT-5 actually use, so the usage parser is exercised.
        completion_tokens_details: { reasoning_tokens: 512 },
      },
    };

    console.log(
      `  [mock-llm] turns=${toolMessages.length} failed=${failedCount} -> ${finishReason}`,
    );

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});

server.listen(PORT, () => {
  console.log(`mock LLM listening on http://localhost:${PORT}/v1`);
});
