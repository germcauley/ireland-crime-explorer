import { NextResponse } from "next/server";
import dashboard from "@/data/processed/dashboard.json";
import { computeAnswer, type QueryFilters } from "@/app/lib/analytics";
import type { DashboardData } from "@/app/lib/dashboard-types";

const data = dashboard as unknown as DashboardData;

const HF_MODEL = process.env.HF_MODEL ?? "meta-llama/Llama-3.1-8B-Instruct";

const SYSTEM_PROMPT = `You turn a question about Irish recorded crime into a JSON filter object.
Reply with ONLY a single JSON object, no prose, no markdown fences. Shape:
{
  "geography": "station" | "division" | null,
  "area": string | null,
  "category": string,
  "year": number | null,
  "compareYear": number | null
}

Rules:
- "station" geography = Dublin Garda station areas (41 small areas, e.g. "Dundrum", "Store Street").
- "division" geography = Garda Divisions (28 areas covering all of Ireland, e.g. "Cork West Division", "DMR South Central Division").
- If the question names a place, put it in "area" verbatim (e.g. "Dundrum", "Cork", "Galway"). If it asks about all of Ireland or doesn't name a place, set "area" to null.
- If unsure which geography, leave "geography" null — the caller infers it from "area".
- "category" is the crime type mentioned (e.g. "murder", "burglary", "assault", "theft", "sexual offences", "drugs"). If none is mentioned, use "all".
- "year" is the target year as a 4-digit number, or null if not stated (defaults to the latest available year).
- "compareYear" is set ONLY if the question asks about change/increase/decrease/trend compared to a specific other year; otherwise null.

Examples:
Q: "how many burglaries were there in Dundrum in 2023"
{"geography":"station","area":"Dundrum","category":"burglary","year":2023,"compareYear":null}

Q: "how did murders in Cork West change since 2019"
{"geography":"division","area":"Cork West","category":"murder","year":null,"compareYear":2019}

Q: "total recorded crime in Ireland in 2022"
{"geography":"division","area":null,"category":"all","year":2022,"compareYear":null}`;

export async function POST(request: Request) {
  const token = process.env.HF_TOKEN;
  if (!token) {
    return NextResponse.json(
      { ok: false, reason: "The question feature isn't configured yet (missing HF_TOKEN)." },
      { status: 500 },
    );
  }

  let question = "";
  try {
    const body = (await request.json()) as { question?: unknown };
    question = typeof body.question === "string" ? body.question.trim() : "";
  } catch {
    return NextResponse.json({ ok: false, reason: "Invalid request." }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ ok: false, reason: "Ask a question first." }, { status: 400 });
  }
  if (question.length > 300) {
    return NextResponse.json({ ok: false, reason: "That question is too long." }, { status: 400 });
  }

  let filters: QueryFilters;
  try {
    filters = await extractFilters(question, token);
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "Could not understand that question." },
      { status: 502 },
    );
  }

  return NextResponse.json(computeAnswer(filters, data));
}

async function extractFilters(question: string, token: string): Promise<QueryFilters> {
  const response = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: HF_MODEL,
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: question },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Hugging Face inference failed (${response.status}). ${text.slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("The model returned no answer.");

  const parsed = JSON.parse(extractJson(content)) as Record<string, unknown>;
  return {
    geography: parsed.geography === "division" || parsed.geography === "station" ? parsed.geography : null,
    area: typeof parsed.area === "string" && parsed.area.trim() ? parsed.area.trim() : null,
    category: typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : "all",
    year: typeof parsed.year === "number" && Number.isFinite(parsed.year) ? Math.trunc(parsed.year) : null,
    compareYear:
      typeof parsed.compareYear === "number" && Number.isFinite(parsed.compareYear)
        ? Math.trunc(parsed.compareYear)
        : null,
  };
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("The model didn't return a usable answer.");
  return candidate.slice(start, end + 1);
}
