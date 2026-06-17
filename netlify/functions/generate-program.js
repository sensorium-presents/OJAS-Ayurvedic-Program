// netlify/functions/generate-program.js
//
// Phased generation — called 5 times, once per phase (7 days each)
// Receives: { apiKey, model, brief, phase, previousPhases }
// Returns:  { days: [...], phase_meta: {...} } or { error: "..." }
//
// Each call generates exactly 7 days, well under the 10-second timeout.
// Previous phases are passed as context so the full program stays coherent.

exports.handler = async function (event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { apiKey, model, brief, phase, previousPhases } = body;

    if (!apiKey || !model || !brief || !phase) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing required fields: apiKey, model, brief, phase' })
      };
    }

    if (!apiKey.startsWith('sk-ant-')) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid API key format' })
      };
    }

    const phaseNum = parseInt(phase);
    if (phaseNum < 1 || phaseNum > 5) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Phase must be 1–5' })
      };
    }

    const systemPrompt = buildSystemPrompt(brief);
    const userPrompt = buildPhasePrompt(brief, phaseNum, previousPhases || []);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 4000,
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

    let result;
    try {
      const cleaned = rawText
        .replace(/^```json\s*/m, '')
        .replace(/^```\s*/m, '')
        .replace(/```\s*$/m, '')
        .trim();
      result = JSON.parse(cleaned);
    } catch (e) {
      result = buildFallbackPhase(phaseNum, brief);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(result)
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

// ── SYSTEM PROMPT (same for all phases) ──
function buildSystemPrompt(brief) {
  return `You are an expert Ayurvedic wellness practitioner and program designer.
Your task is to generate ONE PHASE (7 days) of a personalized 35-day OJAS wellness program as structured JSON.

The program must be:
- Precisely calibrated to the user's tridoshic constitution
- Addressing their specific focus areas and goals
- Respectful of their dietary framework and restrictions
- Grounded in classical Ayurvedic principles
- Realistic and actionable for daily practice

CRITICAL RULES:
- Return ONLY valid JSON. No markdown, no explanation, no preamble.
- Generate exactly 7 days for the requested phase.
- Day numbers must match the phase (Phase 1 = days 1-7, Phase 2 = days 8-14, etc.).
- Meals must respect all dietary restrictions absolutely.
- No repeated meals within the same phase — variety is required.
- Movement intensity must match the phase arc.
- Every field in the schema is required.`;
}

// ── PHASE-SPECIFIC PROMPT ──
function buildPhasePrompt(brief, phaseNum, previousPhases) {
  const { constitution, focus_areas, goal_profile, physical, lifestyle,
          experience_level, intention, quiz_clarifiers } = brief;

  const phaseInfo = {
    1: { name: 'Purification & Foundation', days: '1–7',
         theme: 'Gentle detox, establishing daily rhythm. Light foods, gentle movement, core dinacharya practices introduced. Build consistency before intensity.',
         intensity: 'Low to moderate. No heavy lifting. Yoga, walking, gentle stretching.' },
    2: { name: 'Building Momentum', days: '8–14',
         theme: 'Deepen routines, increase movement intensity, expand dietary protocol. Body adapting to new rhythm.',
         intensity: 'Moderate. Introduce structured workouts. 3-4 days movement per week.' },
    3: { name: 'Integration', days: '15–21',
         theme: 'Full protocol active. Mental and emotional practices deepening. Meal variety expands. Energy building.',
         intensity: 'Moderate to high. Full workout schedule. Push toward fitness goal.' },
    4: { name: 'Peak Practice', days: '22–28',
         theme: 'Maximum program engagement. All systems aligned. This is the peak week — highest intensity, most refined protocols.',
         intensity: 'High. Peak of training cycle. Progress toward major milestone.' },
    5: { name: 'Consolidation', days: '29–35',
         theme: 'Refine what works, wind down intensity, prepare transition to ongoing practice. Reflection and integration.',
         intensity: 'Moderate and decreasing. More restorative movement. Preparing the body for ongoing practice.' }
  };

  const phase = phaseInfo[phaseNum];
  const dayStart = (phaseNum - 1) * 7 + 1;
  const dayEnd = phaseNum * 7;

  const clarifierSummary = Object.entries(quiz_clarifiers || {})
    .filter(([_, v]) => v && v.trim())
    .slice(0, 10)
    .map(([q, note]) => `Q${q}: "${note}"`)
    .join('; ');

  const goalSummary = (focus_areas || []).map(key => {
    const entry = (goal_profile || {})[key] || {};
    const selected = (entry.selected || []).join(', ');
    const note = entry.note ? ` — "${entry.note}"` : '';
    return `${key}: [${selected}]${note}`;
  }).join('\n');

  // Build continuity context from previous phases
  let continuityContext = '';
  if (previousPhases && previousPhases.length > 0) {
    const lastPhase = previousPhases[previousPhases.length - 1];
    const lastDays = (lastPhase.days || []).slice(-2);
    if (lastDays.length > 0) {
      const mealNames = lastDays.flatMap(d => [
        d.meal_breakfast?.name, d.meal_lunch?.name,
        d.meal_snack?.name, d.meal_dinner?.name
      ]).filter(Boolean);
      const workoutNames = lastDays.map(d => d.movement?.name).filter(Boolean);
      continuityContext = `\nCONTINUITY — Do not repeat these from the previous phase:\nMeals used: ${mealNames.join(', ')}\nWorkouts used: ${workoutNames.join(', ')}`;
    }
  }

  return `Generate Phase ${phaseNum} (Days ${dayStart}–${dayEnd}) of the OJAS program.

PHASE: ${phase.name}
THEME: ${phase.theme}
MOVEMENT GUIDANCE: ${phase.intensity}

USER PROFILE:
Constitution: ${constitution.primary} ${constitution.pitta_pct}% / ${constitution.secondary} ${constitution.kapha_pct}% / ${constitution.tertiary} ${constitution.vata_pct}%
Experience: ${experience_level} | Intention: ${intention}
Fitness goal: ${physical.fitnessGoal || 'general health'} | Activity: ${physical.activityLevel || 'moderate'}
Diet: ${physical.dietaryFramework || 'omnivore'} | Restrictions: ${physical.allergies || 'none'}
Wake: ${lifestyle.wakeTime || '7am'} | Sleep: ${lifestyle.sleepTime || '10:30pm'}
Cooking: ${lifestyle.cookingAccess || 'full kitchen'}
Personal intention: ${lifestyle.intention || 'not stated'}

FOCUS AREAS:
${goalSummary || 'None set'}

CLARIFIERS:
${clarifierSummary || 'None provided'}
${continuityContext}

Return this exact JSON (7 days, days ${dayStart}–${dayEnd}):

{
  "phase": ${phaseNum},
  "phase_name": "${phase.name}",
  "phase_theme": "${phase.theme}",
  "days": [
    {
      "day": ${dayStart},
      "phase": ${phaseNum},
      "phase_name": "${phase.name}",
      "morning_ritual": [
        {"step": "Tongue scraping", "duration": "2 min", "note": "specific tip for their dosha"},
        {"step": "Warm water", "duration": "5 min", "note": ""},
        {"step": "Breathwork or meditation", "duration": "10 min", "note": "specific technique"}
      ],
      "meal_breakfast": {
        "name": "Unique meal name",
        "dosha_alignment": "primary dosha",
        "ingredients": ["ingredient 1", "ingredient 2", "ingredient 3"],
        "prep_time": "15 min",
        "nutrition_focus": "protein/carb/fat emphasis",
        "note": "why this meal for their constitution"
      },
      "meal_lunch": {"name": "", "dosha_alignment": "", "ingredients": [], "prep_time": "", "nutrition_focus": "", "note": ""},
      "meal_snack": {"name": "", "dosha_alignment": "", "ingredients": [], "prep_time": "", "nutrition_focus": "", "note": ""},
      "meal_dinner": {"name": "", "dosha_alignment": "", "ingredients": [], "prep_time": "", "nutrition_focus": "", "note": ""},
      "movement": {
        "name": "Workout name",
        "type": "strength/yoga/cardio/mobility/rest",
        "duration": "45 min",
        "intensity": "moderate",
        "focus": "muscle group or movement focus",
        "exercises": ["Exercise 1 — 3x10", "Exercise 2 — 3x12", "Exercise 3 — 3x15"],
        "note": "why this movement fits their phase and goal"
      },
      "supplements": [
        {"name": "Supplement name", "dose": "amount", "timing": "with breakfast", "note": "purpose for their dosha"}
      ],
      "skincare_am": [
        {"step": "Cleanse", "product_type": "gentle cleanser", "note": "dosha-specific tip"}
      ],
      "skincare_pm": [
        {"step": "Oil application", "product_type": "carrier oil", "note": ""}
      ],
      "oral_care": [
        {"step": "Oil pulling", "duration": "10 min", "note": "sesame for Vata/Kapha, coconut for Pitta"}
      ],
      "evening_ritual": [
        {"step": "Evening activity", "duration": "20 min", "note": "aligned with their preferences"}
      ],
      "journal_prompt": "A specific reflective question for day ${dayStart}",
      "zenzo_daily_quote": "An Ayurvedic or wisdom quote for this day",
      "zenzo_intention_check": "ZenZo's personalized encouragement for this specific day"
    }
  ]
}

Generate all 7 days (${dayStart} through ${dayEnd}). Every day must have all fields. Vary meals and workouts — no repeats within this phase.`;
}

// ── FALLBACK if JSON parse fails ──
function buildFallbackPhase(phaseNum, brief) {
  const phaseNames = [
    'Purification & Foundation', 'Building Momentum', 'Integration',
    'Peak Practice', 'Consolidation'
  ];
  const dayStart = (phaseNum - 1) * 7 + 1;

  return {
    phase: phaseNum,
    phase_name: phaseNames[phaseNum - 1],
    phase_theme: 'Phase generated with fallback structure.',
    days: Array.from({ length: 7 }, (_, i) => ({
      day: dayStart + i,
      phase: phaseNum,
      phase_name: phaseNames[phaseNum - 1],
      morning_ritual: [
        { step: 'Tongue scraping', duration: '2 min', note: 'Clean the tongue upon waking' },
        { step: 'Warm water with lemon', duration: '5 min', note: 'Stimulates Agni' },
        { step: 'Breathwork', duration: '10 min', note: 'Nadi Shodhana (alternate nostril)' }
      ],
      meal_breakfast: {
        name: 'Warm Spiced Oatmeal',
        dosha_alignment: brief.constitution.primary.toLowerCase(),
        ingredients: ['oats', 'almond milk', 'cardamom', 'cinnamon', 'ghee', 'dates'],
        prep_time: '10 min',
        nutrition_focus: 'complex carbohydrate + healthy fat',
        note: 'Warming and grounding — supports Agni'
      },
      meal_lunch: {
        name: 'Kitchari',
        dosha_alignment: 'tridoshic',
        ingredients: ['split mung dal', 'basmati rice', 'ghee', 'cumin', 'coriander', 'turmeric', 'ginger'],
        prep_time: '30 min',
        nutrition_focus: 'complete protein + digestive herbs',
        note: 'The Ayurvedic reset meal — tridoshic and deeply nourishing'
      },
      meal_snack: {
        name: 'Soaked Almonds and Dates',
        dosha_alignment: 'tridoshic',
        ingredients: ['almonds (soaked overnight)', 'medjool dates'],
        prep_time: '0 min',
        nutrition_focus: 'healthy fat + natural sugar',
        note: 'Builds Ojas — the vital essence'
      },
      meal_dinner: {
        name: 'Mung Bean Vegetable Soup',
        dosha_alignment: brief.constitution.primary.toLowerCase(),
        ingredients: ['whole mung beans', 'zucchini', 'spinach', 'cumin seeds', 'ghee', 'lime'],
        prep_time: '25 min',
        nutrition_focus: 'light protein + minerals',
        note: 'Easy to digest in the evening — supports overnight detox'
      },
      movement: {
        name: phaseNum <= 2 ? 'Gentle Yoga Flow' : phaseNum <= 4 ? 'Strength Training' : 'Restorative Yoga',
        type: phaseNum <= 2 ? 'yoga' : phaseNum <= 4 ? 'strength' : 'mobility',
        duration: phaseNum <= 1 ? '30 min' : phaseNum <= 4 ? '45 min' : '30 min',
        intensity: phaseNum <= 1 ? 'low' : phaseNum <= 3 ? 'moderate' : phaseNum === 4 ? 'high' : 'low',
        focus: 'Full body',
        exercises: ['Sun Salutations — 5 rounds', 'Warrior sequence', 'Seated forward fold', 'Savasana — 5 min'],
        note: 'Movement aligned with current phase energy'
      },
      supplements: [
        { name: 'Ashwagandha', dose: '500mg', timing: 'with warm milk at night', note: 'Adaptogen — supports nervous system and recovery' },
        { name: 'Triphala', dose: '1 tsp in warm water', timing: 'before bed', note: 'Gentle daily cleanse — supports elimination' }
      ],
      skincare_am: [
        { step: 'Cleanse', product_type: 'gentle cleanser', note: 'Use lukewarm water — not hot' },
        { step: 'Moisturize', product_type: 'light oil or cream', note: 'Apply to slightly damp skin' }
      ],
      skincare_pm: [
        { step: 'Oil cleanse', product_type: 'coconut or jojoba', note: 'Massage in circular motions' },
        { step: 'Night serum', product_type: 'vitamin C or neem', note: 'Supports overnight skin repair' }
      ],
      oral_care: [
        { step: 'Oil pulling', duration: '10 min', note: 'Sesame oil for Vata/Kapha — coconut for Pitta' },
        { step: 'Tongue scraping', duration: '1 min', note: 'Use copper scraper if available' }
      ],
      evening_ritual: [
        { step: 'Digital sunset', duration: '30 min before bed', note: 'No screens — dim lights' },
        { step: 'Abhyanga (self oil massage)', duration: '10 min', note: 'Warm sesame oil — deeply grounding for Vata' },
        { step: 'Journaling', duration: '10 min', note: 'Reflect on today' }
      ],
      journal_prompt: `Day ${dayStart + i}: What felt most aligned today — in your body, your energy, or your mind? What one thing could you do differently tomorrow?`,
      zenzo_daily_quote: 'When diet is wrong, medicine is of no use. When diet is correct, medicine is of no need. — Ayurvedic proverb',
      zenzo_intention_check: `Day ${dayStart + i} complete. You showed up. That is the whole practice.`
    }))
  };
}
