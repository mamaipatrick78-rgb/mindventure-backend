// Turns a rule-based signal into a plain-English explanation. This is presentation
// only — it never decides whether to trade. If ANTHROPIC_API_KEY is set, it asks Claude
// to summarize the already-computed indicators; otherwise it falls back to a template
// so the feature works out of the box with zero external dependencies or cost.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function templateExplain({ asset, action, confidence, indicators, reason }) {
  const pct = Math.round(confidence * 100);
  return `${action} signal on ${asset} (${pct}% confidence). ${reason}. `
    + `This is generated from technical indicators only (RSI, moving averages, momentum) `
    + `and is not financial advice.`;
}

export async function explainDecision(decision) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return templateExplain(decision);

  const { asset, action, confidence, indicators, reason } = decision;
  const prompt = `You are annotating an automated crypto trading decision for a user's activity log. `
    + `Summarize plainly in 2-3 sentences why the system chose ${action} for ${asset}. `
    + `Indicators: ${JSON.stringify(indicators)}. Internal rationale: ${reason}. Confidence: ${confidence}. `
    + `Do not give financial advice, do not predict future price, do not use hype language. `
    + `State clearly this is not a guarantee.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return templateExplain(decision);
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || '').join(' ').trim();
    return text || templateExplain(decision);
  } catch {
    return templateExplain(decision);
  }
}
