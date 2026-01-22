import OpenAI from "openai";

export const runtime = "nodejs";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

export async function POST(req: Request) {
  try {
    const { message, state } = await req.json();

    const system = `
You are an assistant inside a planner app.
Goal: propose a planning update based on the user's message.

IMPORTANT: You must NOT apply changes. You only create:
1) a concise preview summary
2) an action object the app can apply after user confirmation.

Use today's date: ${todayISO()}.
If user gives times, convert to minutes. Days must be one of: Mon Tue Wed Thu Fri Sat Sun.
If a due date is relative (e.g. "Friday"), pick the next occurrence and output YYYY-MM-DD.
If duration isn't given, infer a reasonable estimateMins (60–180).
Return JSON exactly with keys: preview, action, confirmationToken.
`;

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        preview: { type: "string" },
        confirmationToken: { type: "string" },
        action: {
          type: "object",
          additionalProperties: false,
          properties: {
            preferences: {
              type: "object",
              additionalProperties: false,
              properties: {
                startHour: { type: "integer", minimum: 0, maximum: 23 },
                endHour: { type: "integer", minimum: 1, maximum: 24 },
                workBlockMins: { type: "integer", minimum: 15, maximum: 180 },
                maxBlocksPerDay: { type: "integer", minimum: 1, maximum: 12 },
              },
            },
            addBusyBlocks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  day: { type: "string", enum: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"] },
                  startMin: { type: "integer", minimum: 0, maximum: 1440 },
                  endMin: { type: "integer", minimum: 0, maximum: 1440 },
                  label: { type: "string" },
                },
                required: ["day","startMin","endMin"],
              },
            },
            addTasks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string" },
                  dueDate: { type: "string" },
                  priority: { type: "string", enum: ["low","medium","high"] },
                  estimateMins: { type: "integer", minimum: 15, maximum: 1440 },
                },
                required: ["title","dueDate"],
              },
            },
            replan: { type: "boolean" },
          },
        },
      },
      required: ["preview","action","confirmationToken"],
    };

    const res = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: `CURRENT_STATE: ${JSON.stringify(state)}\n\nUSER_MESSAGE: ${message}` },
      ],
      // JSON-only output
      text: { format: { type: "json_schema", name: "plan_preview", schema } } as any,
    });

    const jsonText = res.output_text;
    const parsed = JSON.parse(jsonText);

    // ensure replan default true (so apply will replan)
    if (parsed?.action && typeof parsed.action.replan !== "boolean") parsed.action.replan = true;

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
