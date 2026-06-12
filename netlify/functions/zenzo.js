// netlify/functions/zenzo.js
//
// This is a serverless function that runs on Netlify's servers, not in
// the browser. It receives requests from dashboard.html, adds the secret
// Anthropic API key (which never reaches the browser), calls Claude, and
// returns the response.
//
// Why this is needed: browsers block direct calls to api.anthropic.com
// from client-side JavaScript for security (CORS), and you should never
// put a real API key in code that runs in someone's browser anyway —
// anyone could view it and use your API credits.

exports.handler = async function (event, context) {
  // Only allow POST requests
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body);
    const { system, messages } = body;

    if (!system || !messages) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing system or messages" }),
      };
    }

    // The API key is stored as a Netlify environment variable —
    // never visible in browser code or GitHub
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Server configuration error: ANTHROPIC_API_KEY not set",
        }),
      };
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: system,
        messages: messages,
      }),
    });

    const data = await response.json();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
