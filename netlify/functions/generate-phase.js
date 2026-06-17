// netlify/functions/generate-phase.js
//
// Generates a single adaptive phase (7 days) using:
// - Historic data from previous phases
// - Weekly report findings + research citations
// - Live clarification responses from the user
// - User's confirmed direction statement
//
// This is different from generate-program.js which is for the initial build.
// Receives: { apiKey, model, brief, phase, weeklyReport, clarifications, confirmedDirection }
// Returns: { days: [...], phase_meta: {...} }

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { apiKey, model, brief, phase, weeklyReport,
            clarifications, confirmedDirection, previousPhasesSummary } = body;

    if (!apiKey || !model || !brief || !phase) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    if (!apiKey.startsWith('sk-ant-')) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid API key format' })
      };
    }

    const systemPrompt = buildAdaptiveSystemPrompt();
    const userPrompt = buildAdaptivePhasePrompt(
      brief, phase, weeklyReport, clarifications,
      confirmedDirection, previousPhasesSummary
    );

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
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: errData.error?.message || 'API error' })
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
    } catch(e) {
      result = buildFallbackAdaptivePhase(phase, brief);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(result)
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

function buildAdaptiveSystemPrompt() {
  return `You are an expert Ayurvedic wellness practitioner building an adaptive weekly program.
You have access to real data about what worked for this specific person last week —
their meal ratings, workout patterns, journal language, and their own words
about how the week felt and what they want next.

Your job is to build a 7-day phase that genuinely responds to all of this.
Not a generic dosha protocol — a program calibrated to this exact person in this exact moment.

CRITICAL RULES:
1. Return ONLY valid JSON. No markdown, no preamble.
2. Meals MUST prioritize items similar to high-rated meals from previous week.
3. Workout intensity MUST reflect the user's confirmed direction (increase/maintain/reduce).
4. Journal prompts MUST reference themes from last week's clarification conversation.
5. Every day's ZenZo intention check must reference their stated direction.
6. Day numbers must be correct for this phase (Phase 2 = days 8-14, etc.)
7. No repeating meals that were low-rated (<3 stars) in previous weeks.`;
}

function buildAdaptivePhasePrompt(brief, phase, weeklyReport,
                                   clarifications, confirmedDirection, previousPhasesSummary) {
  const phaseNames = ['','Purification & Foundation','Building Momentum',
    'Integration','Peak Practice','Consolidation'];
  const phaseName = phaseNames[phase] || 'Phase ' + phase;
  const dayStart = (phase - 1) * 7 + 1;
  const dayEnd = phase * 7;
  const doshaNames = {p:'Pitta', k:'Kapha', v:'Vata'};
  const primary = doshaNames[brief.constitution.primary.toLowerCase()] || brief.constitution.primary;

  // Format clarification conversation
  const clarificationText = (clarifications || [])
    .map(function(c, i) {
      return 'Q' + (i+1) + ': ' + c.question + '\nAnswer: ' + c.answer;
    }).join('\n\n') || 'No clarification conversation recorded';

  // Format top meals from report
  const topMeals = (weeklyReport && weeklyReport.top_meals || [])
    .map(m => m.name + ' (' + m.category + ', ' + m.rating + '/5)').join(', ') || 'none recorded';

  // Format adjustments proposed
  const adjustments = (weeklyReport && weeklyReport.adjustments_proposed || [])
    .map(a => a.area + ': ' + a.proposed + ' — ' + a.reason).join('\n') || 'none';

  // Format patterns
  const patterns = (weeklyReport && weeklyReport.patterns_observed || [])
    .map(p => p.pattern + ' (' + p.citation + ')').join('\n') || 'none';

  const psychRead = weeklyReport && weeklyReport.psychological_read
    ? weeklyReport.psychological_read.observed_state + ' — readiness: ' + weeklyReport.psychological_read.readiness_signal
    : 'not available';

  // Previous meals to avoid repeating
  const lowRatedMeals = (weeklyReport && weeklyReport.top_meals || [])
    .filter(m => m.rating <= 2).map(m => m.name);

  return `Build Phase ${phase} (Days ${dayStart}–${dayEnd}: ${phaseName}) for this user.

USER CONSTITUTION: ${primary}-dominant (${brief.constitution.pitta_pct}% Pitta / ${brief.constitution.kapha_pct}% Kapha / ${brief.constitution.vata_pct}% Vata)
DIETARY FRAMEWORK: ${brief.physical.dietaryFramework || 'omnivore'} | RESTRICTIONS: ${brief.physical.allergies || 'none'}
FITNESS GOAL: ${brief.physical.fitnessGoal || 'general health'} | ACTIVITY: ${brief.physical.activityLevel || 'moderate'}
COOKING ACCESS: ${brief.lifestyle.cookingAccess || 'full kitchen'}

══ WHAT WORKED LAST WEEK ══
Top meals: ${topMeals}
${previousPhasesSummary ? 'Top workouts: ' + (previousPhasesSummary.topWorkouts || []).join(', ') : ''}

══ MEALS TO AVOID (low rated) ══
${lowRatedMeals.length ? lowRatedMeals.join(', ') : 'None — all meals were well received'}

══ PATTERNS OBSERVED (with citations) ══
${patterns}

══ PROPOSED ADJUSTMENTS FOR THIS PHASE ══
${adjustments}

══ PSYCHOLOGICAL READ ══
${psychRead}
Key tension: ${weeklyReport && weeklyReport.psychological_read ? weeklyReport.psychological_read.key_tension : 'none identified'}

══ CLARIFICATION CONVERSATION ══
${clarificationText}

══ USER'S CONFIRMED DIRECTION ══
"${confirmedDirection || 'Continue building on what is working.'}"

══ THIS PHASE THEME ══
${phaseName}: ${phase === 2 ? 'Build momentum — intensity increases, variety expands, routines deepen.' :
  phase === 3 ? 'Integration — full protocol active, mental practices deepening.' :
  phase === 4 ? 'Peak practice — highest engagement, push toward primary goal.' :
  'Consolidation — refine what worked, prepare transition to ongoing practice.'}

BUILD PHASE ${phase} GUIDED BY:
1. The user's confirmed direction above — this is their stated intention, honor it
2. More of what they rated highly, less of what they rated low
3. Adjustments the research and their patterns indicate
4. What they expressed in the clarification conversation
5. Increasing/maintaining/reducing intensity per their readiness signal: ${weeklyReport && weeklyReport.psychological_read ? weeklyReport.psychological_read.readiness_signal : 'moderate'}

Return the same JSON structure as generate-program.js — 7 days (${dayStart}–${dayEnd}), all fields required.
Each day's zenzo_intention_check must reference their confirmed direction.
Journal prompts must pick up themes from the clarification conversation.`;
}

function buildFallbackAdaptivePhase(phase, brief) {
  const phaseNames = ['','Purification & Foundation','Building Momentum',
    'Integration','Peak Practice','Consolidation'];
  const dayStart = (phase - 1) * 7 + 1;

  return {
    phase: phase,
    phase_name: phaseNames[phase] || 'Phase ' + phase,
    days: Array.from({ length: 7 }, (_, i) => ({
      day: dayStart + i,
      phase: phase,
      phase_name: phaseNames[phase],
      morning_ritual: [
        { step: 'Tongue scraping', duration: '2 min', note: 'Copper scraper if available' },
        { step: 'Warm water with ginger', duration: '5 min', note: 'Fresh grated ginger for Kapha and Vata' },
        { step: 'Nadi Shodhana pranayama', duration: '10 min', note: 'Alternate nostril breathing — balances all three doshas' }
      ],
      meal_breakfast: {
        name: 'Spiced Millet Porridge',
        dosha_alignment: 'tridoshic',
        ingredients: ['millet','almond milk','cardamom','cinnamon','ghee','honey','pomegranate seeds'],
        prep_time: '15 min',
        nutrition_focus: 'complex carbohydrate + warming spices',
        note: 'Millet is lighter than oats — excellent for reducing Kapha while nourishing Vata'
      },
      meal_lunch: {
        name: 'Lentil Soup with Seasonal Vegetables',
        dosha_alignment: 'tridoshic',
        ingredients: ['red lentils','carrots','spinach','cumin','coriander','turmeric','ghee','lime'],
        prep_time: '25 min',
        nutrition_focus: 'complete protein + digestive herbs',
        note: 'Red lentils are the most digestible legume — appropriate for all phases'
      },
      meal_snack: {
        name: 'Adaptogenic Golden Milk',
        dosha_alignment: 'tridoshic',
        ingredients: ['oat milk','turmeric','black pepper','ashwagandha','cinnamon','raw honey'],
        prep_time: '5 min',
        nutrition_focus: 'anti-inflammatory + adaptogenic',
        note: 'Turmeric with black pepper increases curcumin bioavailability by 2000% (Shoba et al., 1998)'
      },
      meal_dinner: {
        name: 'Quinoa Buddha Bowl',
        dosha_alignment: 'tridoshic',
        ingredients: ['quinoa','roasted sweet potato','steamed broccoli','tahini','lemon','sesame seeds'],
        prep_time: '30 min',
        nutrition_focus: 'light complete protein + minerals',
        note: 'Lighter dinner supports overnight detox — Ayurvedic principle confirmed in circadian metabolism research (Sutton et al., Cell Metabolism 2018)'
      },
      movement: {
        name: phase <= 2 ? 'Vinyasa Flow' : phase <= 4 ? 'Full Body Strength' : 'Restorative Practice',
        type: phase <= 2 ? 'yoga' : phase <= 4 ? 'strength' : 'mobility',
        duration: phase <= 1 ? '30 min' : phase <= 4 ? '45 min' : '30 min',
        intensity: phase <= 1 ? 'low' : phase === 2 ? 'moderate' : phase <= 4 ? 'high' : 'low',
        focus: 'Full body',
        exercises: ['Sun Salutations B — 5 rounds','Warrior II sequence — 3 min each side','Chair pose — 3x1 min','Seated twist — 2 min each side'],
        note: 'Yoga practice reduces cortisol and improves HPA axis function (Thirthalli et al., Indian J Psychiatry 2013)'
      },
      supplements: [
        { name: 'Triphala', dose: '1 tsp', timing: 'warm water before bed', note: 'Gentle daily cleanse — Charaka Samhita primary rasayana formula' },
        { name: 'Ashwagandha', dose: '600mg', timing: 'with warm milk at night', note: 'KSM-66 extract — stress reduction confirmed (Chandrasekhar et al., IJAYIM 2012)' }
      ],
      skincare_am: [
        { step: 'Cleanse', product_type: 'gentle neem-based cleanser', note: 'Neem is antifungal and antibacterial — suited for Pitta-prone skin' },
        { step: 'Rose water toner', product_type: 'hydrosol', note: 'Cooling for Pitta — apply to damp skin' },
        { step: 'Moisturize', product_type: 'light non-comedogenic oil', note: 'Jojoba mimics sebum — suited for all skin types' }
      ],
      skincare_pm: [
        { step: 'Oil cleanse', product_type: 'coconut or sunflower', note: 'Follow with warm damp cloth — no soap needed' },
        { step: 'Facial massage', product_type: 'rosehip seed oil', note: '5 min upward strokes — stimulates lymphatic drainage' }
      ],
      oral_care: [
        { step: 'Oil pulling', duration: '10-15 min', note: 'Sesame for Vata/Kapha, coconut for Pitta — on empty stomach only' },
        { step: 'Tongue scraping', duration: '1 min', note: 'Removes Ama (toxins) that accumulate overnight — classical dinacharya' }
      ],
      evening_ritual: [
        { step: 'Screen-free wind down', duration: '30 min', note: 'Blue light suppresses melatonin — prioritize dimmer lighting after 8pm' },
        { step: 'Abhyanga', duration: '10 min', note: 'Warm sesame oil self-massage — deeply regulating for the nervous system' },
        { step: 'Journaling', duration: '10 min', note: 'Write three things that aligned today and one intention for tomorrow' }
      ],
      journal_prompt: `Day ${dayStart + i}: What did you notice about your energy and digestion today? Was there a moment where you felt most like yourself?`,
      zenzo_daily_quote: 'The goal of Ayurveda is not to add years to life, but to add life to years. — traditional Ayurvedic wisdom',
      zenzo_intention_check: `Day ${dayStart + i}. You set your direction for this week. Every practice today is an expression of that intention.`
    }))
  };
}
