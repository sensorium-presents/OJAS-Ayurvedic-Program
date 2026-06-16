// netlify/functions/generate-program.js
//
// Receives: { apiKey, model, brief }
// Uses the USER's own API key (not the site owner's)
// Calls Claude to generate a structured 35-day OJAS program JSON
// Returns: { program: {...} } or { error: "..." }

exports.handler = async function (event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { apiKey, model, brief } = body;

    if (!apiKey || !model || !brief) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing apiKey, model, or brief' })
      };
    }

    if (!apiKey.startsWith('sk-ant-')) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid API key format' })
      };
    }

    const systemPrompt = buildSystemPrompt(brief);
    const userPrompt = buildUserPrompt(brief);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errData = await response.json();
      const msg = errData.error?.message || 'API error';
      if (msg.includes('credit') || msg.includes('billing')) {
        return {
          statusCode: 402,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Insufficient API credits. Add credits at console.anthropic.com.' })
        };
      }
      if (msg.includes('authentication') || msg.includes('invalid x-api-key')) {
        return {
          statusCode: 401,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Invalid API key. Check your key at console.anthropic.com.' })
        };
      }
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: msg })
      };
    }

    const data = await response.json();
    const rawText = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Parse JSON from response
    let program;
    try {
      // Strip markdown code fences if present
      const cleaned = rawText
        .replace(/^```json\s*/m, '')
        .replace(/^```\s*/m, '')
        .replace(/```\s*$/m, '')
        .trim();
      program = JSON.parse(cleaned);
    } catch (e) {
      // If JSON parse fails, return a minimal structured fallback
      program = buildFallbackProgram(brief, rawText);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ program })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

// ── SYSTEM PROMPT ──
function buildSystemPrompt(brief) {
  return `You are an expert Ayurvedic wellness practitioner and program designer.
Your task is to generate a personalized 35-day OJAS wellness program as structured JSON.

The program must be:
- Precisely calibrated to the user's tridoshic constitution
- Addressing their specific focus areas and goals
- Respectful of their dietary framework, activity level, and lifestyle
- Grounded in classical Ayurvedic principles (Charaka Samhita, Vagbhata)
- Realistic and actionable for daily practice
- Organized into 5 phases of 7 days each

IMPORTANT:
- Return ONLY valid JSON. No markdown, no explanation, no preamble.
- The JSON must match the exact schema described in the user message.
- Every day must have all required fields.
- Meals must respect dietary restrictions.
- Movement must respect fitness goal and activity level.
- All recommendations must be safe general wellness guidance, not medical treatment.`;
}

// ── USER PROMPT ──
function buildUserPrompt(brief) {
  const { constitution, quiz_clarifiers, focus_areas, goal_profile,
          physical, lifestyle, experience_level, intention } = brief;

  const clarifierSummary = Object.entries(quiz_clarifiers || {})
    .filter(([_, v]) => v && v.trim())
    .slice(0, 15)
    .map(([q, note]) => `Q${q}: "${note}"`)
    .join(', ');

  const goalSummary = (focus_areas || []).map(key => {
    const entry = (goal_profile || {})[key] || {};
    const selected = (entry.selected || []).join(', ');
    const note = entry.note ? ` — "${entry.note}"` : '';
    return `${key}: [${selected}]${note}`;
  }).join('\n');

  const phases = [
    { num: 1, name: 'Purification & Foundation', theme: 'Gentle detox, establishing daily rhythm, introducing core practices' },
    { num: 2, name: 'Building Momentum', theme: 'Deepening routines, intensifying movement, expanding dietary protocol' },
    { num: 3, name: 'Integration', theme: 'Full protocol active, mental and emotional practices deepening' },
    { num: 4, name: 'Peak Practice', theme: 'Maximum program engagement, all systems aligned' },
    { num: 5, name: 'Consolidation', theme: 'Refining what works, preparing the transition to ongoing practice' }
  ];

  return `Generate a 35-day OJAS wellness program for this user profile:

CONSTITUTION: ${constitution.primary} ${constitution.pitta_pct}% / ${constitution.secondary} ${constitution.kapha_pct}% / ${constitution.tertiary} ${constitution.vata_pct}%
EXPERIENCE LEVEL: ${experience_level}
INTENTION: ${intention}
FITNESS GOAL: ${physical.fitnessGoal || 'general health'}
ACTIVITY LEVEL: ${physical.activityLevel || 'moderate'}
DIETARY FRAMEWORK: ${physical.dietaryFramework || 'omnivore'}
ALLERGIES/RESTRICTIONS: ${physical.allergies || 'none stated'}
WAKE TIME: ${lifestyle.wakeTime || '7:00 AM'} | SLEEP TIME: ${lifestyle.sleepTime || '10:30 PM'}
COOKING ACCESS: ${lifestyle.cookingAccess || 'full kitchen'}
EVENING PREFERENCES: ${(lifestyle.eveningPreferences || []).join(', ') || 'flexible'}
PERSONAL INTENTION: ${lifestyle.intention || 'not stated'}

FOCUS AREAS & GOALS:
${goalSummary || 'No specific focus areas set'}

PERSONAL CLARIFIERS FROM QUIZ:
${clarifierSummary || 'None provided'}

PROGRAM PHASES:
${phases.map(p => `Phase ${p.num} (Days ${(p.num-1)*7+1}–${p.num*7}): ${p.name} — ${p.theme}`).join('\n')}

Return this exact JSON structure (all 35 days required):

{
  "program_meta": {
    "user_constitution": "${constitution.primary}-${constitution.secondary}-${constitution.tertiary}",
    "primary_dosha": "${constitution.primary.toLowerCase()}",
    "program_phases": ["Purification & Foundation","Building Momentum","Integration","Peak Practice","Consolidation"],
    "dominant_themes": ["array of 3-5 key focus themes from their goals"],
    "daily_intention_template": "A short personalized daily intention aligned with their stated intention"
  },
  "days": [
    {
      "day": 1,
      "phase": 1,
      "phase_name": "Purification & Foundation",
      "morning_ritual": [
        {"step": "Tongue scraping", "duration": "2 min", "note": "dosha-specific tip"},
        {"step": "Warm water with lemon", "duration": "5 min", "note": ""},
        {"step": "Breathwork", "duration": "10 min", "note": "specific technique for their dosha"}
      ],
      "meal_breakfast": {
        "name": "Meal name",
        "dosha_alignment": "primary dosha",
        "ingredients": ["ingredient 1", "ingredient 2"],
        "prep_time": "15 min",
        "nutrition_focus": "protein/carb/fat emphasis",
        "note": "why this meal for their constitution"
      },
      "meal_lunch": { "name": "", "dosha_alignment": "", "ingredients": [], "prep_time": "", "nutrition_focus": "", "note": "" },
      "meal_snack": { "name": "", "dosha_alignment": "", "ingredients": [], "prep_time": "", "nutrition_focus": "", "note": "" },
      "meal_dinner": { "name": "", "dosha_alignment": "", "ingredients": [], "prep_time": "", "nutrition_focus": "", "note": "" },
      "movement": {
        "name": "Workout name",
        "type": "strength/yoga/cardio/mobility/rest",
        "duration": "45 min",
        "intensity": "moderate",
        "focus": "muscle group or movement focus",
        "exercises": ["Exercise 1 — 3x10", "Exercise 2 — 3x12"],
        "note": "why this movement phase fits their goal"
      },
      "supplements": [
        {"name": "Supplement", "dose": "amount", "timing": "with breakfast", "note": "purpose"}
      ],
      "skincare_am": [
        {"step": "Step name", "product_type": "type", "note": "dosha-specific application"}
      ],
      "skincare_pm": [
        {"step": "Step name", "product_type": "type", "note": ""}
      ],
      "oral_care": [
        {"step": "Oil pulling", "duration": "10-15 min", "note": "use sesame or coconut based on dosha"}
      ],
      "evening_ritual": [
        {"step": "Activity", "duration": "time", "note": ""}
      ],
      "journal_prompt": "A specific reflective question for this day's focus",
      "zenzo_daily_quote": "An Ayurvedic or wisdom quote aligned with this day's theme",
      "zenzo_intention_check": "A short personalized encouragement from ZenZo for this day"
    }
  ]
}

Generate all 35 days. Vary meals, workouts, and rituals throughout. Escalate intensity in phases 2-4. Wind down in phase 5.`;
}

// ── FALLBACK if JSON parse fails ──
function buildFallbackProgram(brief, rawText) {
  return {
    program_meta: {
      user_constitution: `${brief.constitution.primary}-${brief.constitution.secondary}-${brief.constitution.tertiary}`,
      primary_dosha: brief.constitution.primary.toLowerCase(),
      program_phases: ['Purification & Foundation', 'Building Momentum', 'Integration', 'Peak Practice', 'Consolidation'],
      dominant_themes: brief.focus_areas.slice(0, 5),
      daily_intention_template: 'I honor my constitution and align my actions with my highest wellbeing today.',
      raw_generation: rawText.slice(0, 2000),
      generation_note: 'Program was generated but could not be fully parsed. Raw content saved for recovery.'
    },
    days: Array.from({ length: 35 }, (_, i) => ({
      day: i + 1,
      phase: Math.ceil((i + 1) / 7),
      phase_name: ['Purification & Foundation', 'Building Momentum', 'Integration', 'Peak Practice', 'Consolidation'][Math.ceil((i + 1) / 7) - 1],
      journal_prompt: 'How are you feeling today? What did you notice about your energy, digestion, and mood?',
      zenzo_daily_quote: 'The body is the vehicle of the soul — care for it with the same reverence you would offer a temple.',
      zenzo_intention_check: 'You are doing the work. Every practice counts, even the small ones.'
    }))
  };
}
