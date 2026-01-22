export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { confirmationToken, action, userConfirmationText } = await req.json();

    // Minimal “confirmation gate”
    const okWords = ["confirmo", "confirm", "sí", "si", "ok", "dale", "aplica"];
    const ok = typeof userConfirmationText === "string" &&
      okWords.some(w => userConfirmationText.toLowerCase().includes(w));

    if (!ok) {
      return new Response(JSON.stringify({ error: "Confirmation required. Type 'confirmo' to apply." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // In a real app, you'd verify confirmationToken server-side.
    // For MVP, we just accept it if present.
    if (!confirmationToken) {
      return new Response(JSON.stringify({ error: "Missing confirmation token." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, action }), {
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
